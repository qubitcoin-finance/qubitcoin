/**
 * Interactive BTC → QTC claim tool
 *
 * Three modes:
 *   pnpm run claim              — full flow (generate + send)
 *   pnpm run claim:generate     — offline: create signed claim tx, save to file
 *   pnpm run claim:send <file>  — online: broadcast a saved claim tx to the node
 *
 * Accepts BTC credentials in three formats:
 *   - BIP39 seed phrase (12 or 24 words)
 *   - WIF (starts with 5, K, or L)
 *   - Raw hex (64 characters)
 */
import * as readline from 'node:readline'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { generateWallet, hash160, bytesToHex, hexToBytes } from '../crypto.js'
import { createClaimTransaction } from '../claim.js'
import { sanitize } from '../rpc.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { HDKey } from '@scure/bip32'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RPC_BASE = process.env.QTC_RPC ?? 'http://127.0.0.1:3001'

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, resolve))
}

function decodeWIF(wif: string): Uint8Array {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  let num = 0n
  for (const ch of wif) {
    const idx = ALPHABET.indexOf(ch)
    if (idx === -1) throw new Error(`Invalid WIF character: ${ch}`)
    num = num * 58n + BigInt(idx)
  }
  const hex = num.toString(16).padStart(76, '0')
  const raw = hexToBytes(hex.length % 2 ? '0' + hex : hex)
  const payload = raw.slice(0, raw.length - 4)
  const checksum = raw.slice(raw.length - 4)
  const hash = sha256(sha256(payload))
  for (let i = 0; i < 4; i++) {
    if (hash[i] !== checksum[i]) throw new Error('WIF checksum mismatch')
  }
  if (payload[0] !== 0x80) throw new Error(`Unexpected WIF version byte: 0x${payload[0].toString(16)}`)
  if (payload.length === 34) return payload.slice(1, 33)
  if (payload.length === 33) return payload.slice(1, 33)
  throw new Error(`Unexpected WIF payload length: ${payload.length}`)
}

interface DerivedKey {
  path: string
  label: string
  secretKey: Uint8Array
  publicKey: Uint8Array
  address: string
}

function deriveFromSeed(mnemonic: string): DerivedKey[] {
  const seed = mnemonicToSeedSync(mnemonic)
  const master = HDKey.fromMasterSeed(seed)
  const paths = [
    { path: "m/44'/0'/0'/0/0", label: 'BIP44 P2PKH (legacy, address starts with 1)' },
    { path: "m/44'/0'/0'/0/1", label: 'BIP44 P2PKH index 1' },
    { path: "m/44'/0'/0'/0/2", label: 'BIP44 P2PKH index 2' },
    { path: "m/84'/0'/0'/0/0", label: 'BIP84 P2WPKH (native segwit, address starts with bc1q)' },
    { path: "m/84'/0'/0'/0/1", label: 'BIP84 P2WPKH index 1' },
    { path: "m/84'/0'/0'/0/2", label: 'BIP84 P2WPKH index 2' },
  ]
  const results: DerivedKey[] = []
  for (const { path, label } of paths) {
    const child = master.derive(path)
    if (!child.privateKey) continue
    const secretKey = child.privateKey
    const publicKey = secp256k1.getPublicKey(secretKey, true)
    const address = bytesToHex(hash160(publicKey))
    results.push({ path, label, secretKey, publicKey, address })
  }
  return results
}

type InputFormat = 'seed' | 'wif' | 'hex'

function detectFormat(input: string): InputFormat {
  const trimmed = input.trim()
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return 'hex'
  if (/^[5KL][1-9A-HJ-NP-Za-km-z]{50,51}$/.test(trimmed)) return 'wif'
  if (trimmed.includes(' ') && trimmed.split(/\s+/).length >= 12) return 'seed'
  throw new Error('Unrecognized format. Expected: seed phrase (12/24 words), WIF key, or 64-char hex.')
}

/** Resolve BTC credentials from user input, returns { secretKey, publicKey, address } */
async function resolveBtcCredentials(rl: readline.Interface): Promise<{ secretKey: Uint8Array; publicKey: Uint8Array; address: string }> {
  console.log('  Enter your Bitcoin private key or seed phrase.')
  console.log('  Supported formats:')
  console.log('    • Seed phrase  (12 or 24 words)')
  console.log('    • WIF key      (starts with 5, K, or L)')
  console.log('    • Hex key      (64 hex characters)')
  console.log()

  const keyInput = await ask(rl, '  Input: ')

  let format: InputFormat
  try {
    format = detectFormat(keyInput)
  } catch (err) {
    console.error(`\n  ✗ ${(err as Error).message}\n`)
    process.exit(1)
  }

  if (format === 'seed') {
    const mnemonic = keyInput.trim().toLowerCase().replace(/\s+/g, ' ')
    if (!validateMnemonic(mnemonic, wordlist)) {
      console.error('\n  ✗ Invalid seed phrase. Check spelling and word count (12 or 24 words).\n')
      process.exit(1)
    }

    console.log('\n  ✓ Valid seed phrase detected')
    console.log('  Deriving addresses from common BIP paths...\n')

    const derived = deriveFromSeed(mnemonic)
    for (let i = 0; i < derived.length; i++) {
      const d = derived[i]
      console.log(`    [${i + 1}] ${d.path}`)
      console.log(`        ${d.label}`)
      console.log(`        HASH160: ${d.address}`)
      console.log()
    }

    const choice = await ask(rl, `  Select address [1-${derived.length}]: `)
    const idx = parseInt(choice.trim(), 10) - 1
    if (isNaN(idx) || idx < 0 || idx >= derived.length) {
      console.error('\n  ✗ Invalid selection.\n')
      process.exit(1)
    }

    const s = derived[idx]
    console.log(`\n  Selected: ${s.path}`)
    return { secretKey: s.secretKey, publicKey: s.publicKey, address: s.address }
  }

  // WIF or hex
  let secretKey: Uint8Array
  try {
    secretKey = format === 'wif' ? decodeWIF(keyInput.trim()) : hexToBytes(keyInput.trim())
  } catch (err) {
    console.error(`\n  ✗ ${(err as Error).message}\n`)
    process.exit(1)
  }
  const publicKey = secp256k1.getPublicKey(secretKey, true)
  const address = bytesToHex(hash160(publicKey))
  console.log(`\n  ✓ ${format === 'wif' ? 'WIF' : 'Hex'} key parsed`)
  return { secretKey, publicKey, address }
}

// ---------------------------------------------------------------------------
// Mode: generate (offline)
// ---------------------------------------------------------------------------

async function modeGenerate() {
  console.log()
  console.log('  ╔═══════════════════════════════════════════════════════╗')
  console.log('  ║   QubitCoin — Claim Generator (offline)               ║')
  console.log('  ╚═══════════════════════════════════════════════════════╝')
  console.log()
  console.log('  This creates a signed claim transaction that can be')
  console.log('  broadcast later with: pnpm run claim:send <file>')
  console.log()

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

  try {
    // BTC credentials
    console.log('  ── Step 1: BTC Credentials ──────────────────────────────')
    const btc = await resolveBtcCredentials(rl)
    console.log(`  Public key (compressed): ${bytesToHex(btc.publicKey)}`)
    console.log(`  BTC address (HASH160):   ${btc.address}`)

    // Snapshot block hash — user must provide it for offline mode
    console.log('\n  ── Step 2: Snapshot Info ─────────────────────────────────')
    console.log('  You need the snapshot block hash from the genesis block.')
    console.log('  Get it from an online node:')
    console.log('    curl -s http://127.0.0.1:3001/api/v1/block-by-height/0 | jq .transactions[0].inputs[0].publicKey')
    console.log()
    const snapshotBlockHash = await ask(rl, '  Snapshot block hash: ')
    if (!/^[0-9a-fA-F]{64}$/.test(snapshotBlockHash.trim())) {
      console.error('\n  ✗ Expected a 64-char hex hash.\n')
      process.exit(1)
    }

    // Amount
    console.log('\n  You need your exact BTC snapshot balance.')
    console.log('  The node will reject the claim if the amount doesn\'t match.')
    console.log()
    const amountStr = await ask(rl, '  Snapshot balance (QTC): ')
    const amount = parseFloat(amountStr.trim())
    if (isNaN(amount) || amount <= 0) {
      console.error('\n  ✗ Invalid amount.\n')
      process.exit(1)
    }

    // Generate QTC wallet
    console.log('\n  ── Step 3: Generate QTC Wallet ───────────────────────────')
    console.log('  Generating ML-DSA-65 keypair (this may take a moment)...')
    const qtcWallet = generateWallet()
    console.log(`  ✓ QTC address: ${qtcWallet.address}`)

    // Build claim tx
    console.log('\n  ── Step 4: Build Transaction ─────────────────────────────')
    const entry = { btcAddress: btc.address, amount }
    const tx = createClaimTransaction(btc.secretKey, btc.publicKey, entry, qtcWallet, snapshotBlockHash.trim())
    const serialized = JSON.stringify(sanitize(tx), null, 2)

    // Save to file
    const filename = `claim-${btc.address.slice(0, 8)}-${Date.now()}.json`
    const filepath = path.resolve(filename)
    fs.writeFileSync(filepath, serialized + '\n')

    console.log(`\n  ✓ Signed claim transaction saved to:`)
    console.log(`    ${filepath}`)
    console.log(`\n  To broadcast:`)
    console.log(`    pnpm run claim:send ${filename}`)
    console.log()
    console.log('  ┌─────────────────────────────────────────────────────────┐')
    console.log('  │  IMPORTANT: Save your QTC wallet secret key securely!   │')
    console.log('  │  Without it you cannot spend your claimed QTC.          │')
    console.log('  └─────────────────────────────────────────────────────────┘')
    console.log()
    console.log(`  QTC address:    ${qtcWallet.address}`)
    console.log(`  Public key:     ${bytesToHex(qtcWallet.publicKey).slice(0, 40)}...`)
    console.log(`  Secret key len: ${qtcWallet.secretKey.length} bytes`)
    console.log()
  } finally {
    rl.close()
  }
}

// ---------------------------------------------------------------------------
// Mode: send (online)
// ---------------------------------------------------------------------------

async function modeSend(filepath: string) {
  console.log()
  console.log('  ╔═══════════════════════════════════════════════════════╗')
  console.log('  ║   QubitCoin — Claim Sender (online)                   ║')
  console.log('  ╚═══════════════════════════════════════════════════════╝')
  console.log()

  // Load transaction from file
  if (!fs.existsSync(filepath)) {
    console.error(`  ✗ File not found: ${filepath}\n`)
    process.exit(1)
  }

  let txPayload: string
  try {
    txPayload = fs.readFileSync(filepath, 'utf-8')
    JSON.parse(txPayload) // validate JSON
  } catch {
    console.error(`  ✗ Failed to parse claim transaction file.\n`)
    process.exit(1)
  }

  const tx = JSON.parse(txPayload)
  console.log(`  Loaded claim transaction: ${tx.id?.slice(0, 16)}...`)
  console.log(`  BTC address: ${tx.claimData?.btcAddress ?? 'unknown'}`)
  console.log(`  QTC address: ${tx.claimData?.qcoinAddress ?? 'unknown'}`)
  console.log(`  Amount:      ${tx.outputs?.[0]?.amount ?? '?'} QTC`)
  console.log()

  // Connect to node
  const rpcUrl = `${RPC_BASE}/api/v1`
  console.log(`  Connecting to node at ${RPC_BASE} ...`)
  try {
    const res = await fetch(`${rpcUrl}/status`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const status = await res.json() as Record<string, unknown>
    console.log(`  ✓ Connected — chain height: ${status.height}\n`)
  } catch {
    console.error('\n  ✗ Could not connect to the QubitCoin node.')
    console.error(`    Make sure qtcd is running, or set QTC_RPC=http://host:port.\n`)
    process.exit(1)
  }

  // Broadcast
  console.log('  Broadcasting...')
  const res = await fetch(`${rpcUrl}/tx`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: txPayload,
  })

  if (res.ok) {
    const result = await res.json() as { txid: string }
    console.log(`\n  ✓ Claim transaction broadcast!`)
    console.log(`    txid: ${result.txid}`)
    console.log(`\n  Your QTC will appear once the transaction is mined.\n`)
  } else {
    const err = await res.json() as { error?: string }
    console.error(`\n  ✗ Claim rejected: ${err.error ?? 'Unknown error'}`)
    if (err.error?.includes('already claimed')) {
      console.error(`  This BTC address has already been claimed.`)
    }
    console.error()
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// Mode: full (generate + send in one step)
// ---------------------------------------------------------------------------

async function modeFull() {
  console.log()
  console.log('  ╔═══════════════════════════════════════════════════════╗')
  console.log('  ║   QubitCoin — BTC → QTC Claim Tool                    ║')
  console.log('  ╚═══════════════════════════════════════════════════════╝')
  console.log()

  const rpcUrl = `${RPC_BASE}/api/v1`

  // Check node is reachable
  console.log(`  Connecting to node at ${RPC_BASE} ...`)
  let status: Record<string, unknown>
  try {
    const res = await fetch(`${rpcUrl}/status`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    status = await res.json() as Record<string, unknown>
  } catch {
    console.error('\n  ✗ Could not connect to the QubitCoin node.')
    console.error(`    Make sure qtcd is running: pnpm run qtcd -- --mine --full`)
    console.error(`    Or set QTC_RPC=http://host:port to use a different node.\n`)
    process.exit(1)
  }
  console.log(`  ✓ Connected — chain height: ${status.height}\n`)

  // Check snapshot
  let claimStats: Record<string, unknown>
  try {
    const res = await fetch(`${rpcUrl}/claims/stats`)
    claimStats = await res.json() as Record<string, unknown>
    if (!claimStats.totalEntries || (claimStats.totalEntries as number) === 0) {
      console.error('  ✗ Node has no BTC snapshot loaded. Start with --snapshot or --full.\n')
      process.exit(1)
    }
  } catch {
    console.error('  ✗ Could not fetch claim stats.\n')
    process.exit(1)
  }
  console.log(`  Snapshot: ${(claimStats.totalEntries as number).toLocaleString()} addresses, ${(claimStats.unclaimedAmount as number).toLocaleString()} QTC claimable`)
  console.log()

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

  try {
    // BTC credentials
    console.log('  ── Step 1: BTC Credentials ──────────────────────────────')
    const btc = await resolveBtcCredentials(rl)
    console.log(`  Public key (compressed): ${bytesToHex(btc.publicKey)}`)
    console.log(`  BTC address (HASH160):   ${btc.address}`)

    // Generate QTC wallet
    console.log('\n  ── Step 2: Generate QTC Wallet ───────────────────────────')
    console.log('  Generating ML-DSA-65 keypair (this may take a moment)...')
    const qtcWallet = generateWallet()
    console.log(`  ✓ QTC address: ${qtcWallet.address}`)
    console.log()

    // Confirm
    console.log('  ── Step 3: Confirm ──────────────────────────────────────')
    console.log(`  BTC address:  ${btc.address}`)
    console.log(`  QTC address:  ${qtcWallet.address}`)
    console.log(`  Node:         ${RPC_BASE}`)
    console.log()

    const confirm = await ask(rl, '  Broadcast claim transaction? (y/N): ')
    if (confirm.trim().toLowerCase() !== 'y') {
      console.log('\n  Aborted.\n')
      process.exit(0)
    }

    // Build and broadcast
    console.log('\n  ── Step 4: Broadcast ─────────────────────────────────────')
    console.log('  Building claim transaction...')

    // Get snapshot block hash from genesis
    let snapshotBlockHash: string
    try {
      const genesisRes = await fetch(`${rpcUrl}/block-by-height/0`)
      const genesis = await genesisRes.json() as Record<string, unknown>
      const txs = (genesis as { transactions: Array<{ inputs: Array<{ publicKey: string }> }> }).transactions
      const coinbasePk = txs?.[0]?.inputs?.[0]?.publicKey ?? ''
      const parts = coinbasePk.split(':')
      if (parts[0] === 'QCOIN_FORK' && parts[2]) {
        snapshotBlockHash = parts[2]
      } else {
        snapshotBlockHash = (genesis as { hash: string }).hash
      }
    } catch {
      console.error('  ✗ Could not fetch genesis block to extract snapshot hash.\n')
      process.exit(1)
    }

    // Probe with amount=0 to discover real balance
    const testEntry = { btcAddress: btc.address, amount: 0 }
    const testTx = createClaimTransaction(btc.secretKey, btc.publicKey, testEntry, qtcWallet, snapshotBlockHash)
    const testPayload = JSON.stringify(sanitize(testTx))

    let testRes = await fetch(`${rpcUrl}/tx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: testPayload,
    })

    if (testRes.ok) {
      const result = await testRes.json() as { txid: string }
      printSuccess(result.txid, 0, qtcWallet)
      process.exit(0)
    }

    const errBody = await testRes.json() as { error?: string }
    const amountMatch = errBody.error?.match(/expected\s+([\d.]+)/)
    if (!amountMatch) {
      console.error(`\n  ✗ ${errBody.error ?? 'Unknown error'}`)
      if (errBody.error?.includes('not found in snapshot')) {
        console.error(`\n  The address ${btc.address} is not in the BTC snapshot.`)
        console.error(`  Only P2PKH and P2WPKH addresses from block 935,941 are eligible.\n`)
      } else if (errBody.error?.includes('already claimed')) {
        console.error(`\n  This BTC address has already been claimed.\n`)
      }
      process.exit(1)
    }

    const realAmount = parseFloat(amountMatch[1])
    console.log(`  Snapshot balance: ${realAmount} QTC`)

    const entry = { btcAddress: btc.address, amount: realAmount }
    const tx = createClaimTransaction(btc.secretKey, btc.publicKey, entry, qtcWallet, snapshotBlockHash)
    const payload = JSON.stringify(sanitize(tx))

    const res = await fetch(`${rpcUrl}/tx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    })

    if (res.ok) {
      const result = await res.json() as { txid: string }
      printSuccess(result.txid, realAmount, qtcWallet)
    } else {
      const err = await res.json() as { error?: string }
      console.error(`\n  ✗ Claim rejected: ${err.error ?? 'Unknown error'}`)
      if (err.error?.includes('already claimed')) {
        console.error(`  This BTC address has already been claimed.`)
      }
      console.error()
      process.exit(1)
    }
  } finally {
    rl.close()
  }
}

function printSuccess(txid: string, amount: number, qtcWallet: { address: string; publicKey: Uint8Array; secretKey: Uint8Array }) {
  console.log(`\n  ✓ Claim transaction broadcast!`)
  console.log(`    txid:   ${txid}`)
  if (amount > 0) console.log(`    amount: ${amount} QTC`)
  console.log(`\n  Your QTC will appear at ${qtcWallet.address} once mined.`)
  console.log()
  console.log('  ┌─────────────────────────────────────────────────────────┐')
  console.log('  │  IMPORTANT: Save your QTC wallet secret key securely!   │')
  console.log('  │  Without it you cannot spend your claimed QTC.          │')
  console.log('  └─────────────────────────────────────────────────────────┘')
  console.log()
  console.log(`  QTC address:    ${qtcWallet.address}`)
  console.log(`  Public key:     ${bytesToHex(qtcWallet.publicKey).slice(0, 40)}...`)
  console.log(`  Secret key len: ${qtcWallet.secretKey.length} bytes`)
  console.log()
}

// ---------------------------------------------------------------------------
// Entry point — dispatch based on CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
const mode = args[0]

if (mode === 'generate') {
  modeGenerate().catch(err => { console.error('Fatal error:', err); process.exit(1) })
} else if (mode === 'send') {
  const file = args[1]
  if (!file) {
    console.error('\n  Usage: pnpm run claim:send <claim-file.json>\n')
    process.exit(1)
  }
  modeSend(file).catch(err => { console.error('Fatal error:', err); process.exit(1) })
} else {
  modeFull().catch(err => { console.error('Fatal error:', err); process.exit(1) })
}
