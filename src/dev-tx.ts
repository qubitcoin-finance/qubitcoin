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

  // Generate recipient wallets
  const recipients = Array.from({ length: 10 }, () => generateWallet())
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

      // Pick one UTXO to spend
      const utxo = utxos[0]
      // Random fee: 5,000 – 99,000 satoshis
      const fee = 5_000 + Math.floor(Math.random() * 94_000)
      const available = utxo.amount - fee
      if (available <= 0) {
        pendingSpent.add(`${utxo.txId}:${utxo.outputIndex}`)
        return
      }

      // Split into multiple small outputs to random recipients
      const numOutputs = Math.min(Math.floor(available / 100_000), 5)
      if (numOutputs < 1) {
        pendingSpent.add(`${utxo.txId}:${utxo.outputIndex}`)
        return
      }

      // Budget: spend at most 0.1% of available, rest goes back as change
      const budget = Math.floor(available * 0.001)
      const perOutput = Math.floor(budget / numOutputs)

      const outputs: Array<{ address: string; amount: number }> = []
      for (let i = 0; i < numOutputs; i++) {
        const recipient = recipients[recipientIdx % recipients.length]
        recipientIdx++
        // Small random amount around perOutput (±50%)
        const amount = Math.floor(perOutput * (0.5 + Math.random()))
        if (amount < 1_000) continue
        outputs.push({ address: recipient.address, amount })
      }
      if (outputs.length === 0) {
        pendingSpent.add(`${utxo.txId}:${utxo.outputIndex}`)
        return
      }

      const tx = createTransaction(wallet, [utxo], outputs, fee)

      const result = await api<{ txid: string }>('/tx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sanitizeTx(tx)),
      })

      pendingSpent.add(`${utxo.txId}:${utxo.outputIndex}`)

      const totalSat = outputs.reduce((s, o) => s + o.amount, 0)
      console.log(`TX ${result.txid.slice(0, 16)}... → ${numOutputs} outputs (${(totalSat / 1e8).toFixed(8)} QBTC, fee ${(fee / 1e8).toFixed(8)} QBTC)`)
    } catch (err: any) {
      if (err.message?.includes('already claimed')) {
        const match = err.message.match(/UTXO ([0-9a-f]+:\d+)/)
        if (match) pendingSpent.add(match[1])
      } else {
        console.log(`Error: ${err.message}`)
      }
    }
  }

  // Send one per UTXO immediately, then on interval
  await sendTx()
  setInterval(sendTx, INTERVAL_MS)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
