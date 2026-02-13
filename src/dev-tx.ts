/**
 * dev-tx — Generate random transactions against a running qbtcd node.
 *
 * Loads the miner wallet from data/node/wallet.json, fetches UTXOs via RPC,
 * and submits transfers to random addresses every few seconds.
 *
 * Usage: pnpm run dev:tx
 */
import { readFileSync } from 'node:fs'
import { generateWallet } from './crypto.js'
import { createTransaction } from './transaction.js'
import type { UTXO } from './transaction.js'

const RPC = process.argv[2] || 'http://127.0.0.1:3001'
const WALLET_PATH = process.argv[3] || 'data/node/wallet.json'
const INTERVAL_MS = 3_000

async function api<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${RPC}/api/v1${path}`, opts)
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`)
  return res.json() as Promise<T>
}

// Sanitize a wallet for JSON (Uint8Array → hex)
function sanitizeTx(obj: unknown): unknown {
  if (obj instanceof Uint8Array) {
    return Array.from(obj).map(b => b.toString(16).padStart(2, '0')).join('')
  }
  if (Array.isArray(obj)) return obj.map(sanitizeTx)
  if (obj !== null && typeof obj === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) out[k] = sanitizeTx(v)
    return out
  }
  return obj
}

async function main() {
  // Load miner wallet
  let wallet
  try {
    const raw = JSON.parse(readFileSync(WALLET_PATH, 'utf-8'))
    wallet = {
      publicKey: new Uint8Array(Buffer.from(raw.publicKey, 'hex')),
      secretKey: new Uint8Array(Buffer.from(raw.secretKey, 'hex')),
      address: raw.address,
    }
  } catch {
    console.error(`Could not load wallet from ${WALLET_PATH}`)
    console.error('Make sure qbtcd is running with --mine first.')
    process.exit(1)
  }

  console.log(`Wallet: ${wallet.address}`)
  console.log(`RPC:    ${RPC}`)
  console.log(`Sending transactions every ${INTERVAL_MS / 1000}s...\n`)

  // Generate a few recipient wallets
  const recipients = Array.from({ length: 5 }, () => generateWallet())
  let recipientIdx = 0

  // Track UTXOs we've already spent in the mempool
  const pendingSpent = new Set<string>()

  async function sendTx() {
    try {
      // Fetch UTXOs for our wallet, filter out ones already in mempool
      const allUtxos = await api<UTXO[]>(`/address/${wallet.address}/utxos`)
      const utxos = allUtxos.filter(u => !pendingSpent.has(`${u.txId}:${u.outputIndex}`))

      if (utxos.length === 0) {
        // Clear pending set — block may have been mined, retry with fresh state
        pendingSpent.clear()
        console.log('No spendable UTXOs — waiting for next block...')
        return
      }

      const recipient = recipients[recipientIdx % recipients.length]
      recipientIdx++

      const amount = Math.round((Math.random() * 0.00009 + 0.00001) * 100000) / 100000
      const fee = 0.00001
      const needed = amount + fee

      let accumulated = 0
      const selected: UTXO[] = []
      for (const utxo of utxos) {
        selected.push(utxo)
        accumulated += utxo.amount
        if (accumulated >= needed) break
      }

      if (accumulated < needed) {
        console.log(`Insufficient balance (${accumulated.toFixed(4)} < ${needed}) — waiting...`)
        return
      }

      const tx = createTransaction(
        wallet,
        selected,
        [{ address: recipient.address, amount }],
        fee,
      )

      const result = await api<{ txid: string }>('/tx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sanitizeTx(tx)),
      })

      // Mark spent UTXOs
      for (const u of selected) {
        pendingSpent.add(`${u.txId}:${u.outputIndex}`)
      }

      console.log(`TX ${result.txid.slice(0, 16)}... → ${recipient.address.slice(0, 8)}... (${amount} QBTC)`)
    } catch (err: any) {
      // Mark selected UTXOs as spent even on error (likely already in mempool)
      if (err.message?.includes('already claimed')) {
        const match = err.message.match(/UTXO ([0-9a-f]+:\d+)/)
        if (match) pendingSpent.add(match[1])
      } else {
        console.log(`Error: ${err.message}`)
      }
    }
  }

  // Send one immediately, then on interval
  await sendTx()
  setInterval(sendTx, INTERVAL_MS)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
