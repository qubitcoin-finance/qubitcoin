/**
 * Interactive BTC → QBTC claim tool
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
import { generateWallet, hash160, deriveP2shP2wpkhAddress, getSchnorrPublicKey, deriveP2trAddress, deriveP2wshAddress, parseWitnessScript, bytesToHex, hexToBytes } from '../crypto.js'
import { createClaimTransaction, createP2wshClaimTransaction } from '../claim.js'
import { sanitize } from '../rpc.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { HDKey } from '@scure/bip32'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RPC_BASE = process.env.QBTC_RPC ?? 'http://127.0.0.1:3001'

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
    { path: "m/49'/0'/0'/0/0", label: 'BIP49 P2SH-P2WPKH (wrapped segwit, address starts with 3)' },
    { path: "m/49'/0'/0'/0/1", label: 'BIP49 P2SH-P2WPKH index 1' },
    { path: "m/49'/0'/0'/0/2", label: 'BIP49 P2SH-P2WPKH index 2' },
    { path: "m/86'/0'/0'/0/0", label: 'BIP86 P2TR (taproot, address starts with bc1p)' },
    { path: "m/86'/0'/0'/0/1", label: 'BIP86 P2TR index 1' },
    { path: "m/86'/0'/0'/0/2", label: 'BIP86 P2TR index 2' },
  ]
  const results: DerivedKey[] = []
  for (const { path, label } of paths) {
    const child = master.derive(path)
    if (!child.privateKey) continue
    const secretKey = child.privateKey
    if (path.startsWith("m/86'")) {
      // BIP86 P2TR: use x-only Schnorr pubkey + Taproot tweaked address
      const publicKey = getSchnorrPublicKey(secretKey)
      const address = deriveP2trAddress(publicKey)
      results.push({ path, label, secretKey, publicKey, address })
    } else {
      const publicKey = secp256k1.getPublicKey(secretKey, true)
      // BIP49 paths use P2SH-P2WPKH address derivation
      const address = path.startsWith("m/49'")
        ? deriveP2shP2wpkhAddress(publicKey)
        : bytesToHex(hash160(publicKey))
      results.push({ path, label, secretKey, publicKey, address })
    }
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
  const keyhashAddr = bytesToHex(hash160(publicKey))
  const p2shAddr = deriveP2shP2wpkhAddress(publicKey)
  const schnorrPubkey = getSchnorrPublicKey(secretKey)
  const p2trAddr = deriveP2trAddress(schnorrPubkey)
  console.log(`\n  ✓ ${format === 'wif' ? 'WIF' : 'Hex'} key parsed`)
  console.log(`  P2PKH/P2WPKH address: ${keyhashAddr}`)
  console.log(`  P2SH-P2WPKH address:  ${p2shAddr}`)
  console.log(`  P2TR address:         ${p2trAddr}`)
  console.log()
  console.log(`  Which address type do you want to claim?`)
  console.log(`    [1] P2PKH / P2WPKH (HASH160 of pubkey)`)
  console.log(`    [2] P2SH-P2WPKH (wrapped segwit, address starts with 3)`)
  console.log(`    [3] P2TR (taproot, address starts with bc1p)`)
  console.log()
  const choice = await ask(rl, '  Select [1-3] (default 1): ')
  if (choice.trim() === '3') {
    return { secretKey, publicKey: schnorrPubkey, address: p2trAddr }
  }
  const address = choice.trim() === '2' ? p2shAddr : keyhashAddr
  return { secretKey, publicKey, address }
}

/** Resolve P2WSH credentials: witness script + signer keys */
async function resolveP2wshCredentials(rl: readline.Interface): Promise<{ witnessScript: Uint8Array; signerSecretKeys: Uint8Array[]; address: string }> {
  console.log('  Enter the witness script as a hex string.')
  console.log('  (e.g. from your multisig wallet setup)')
  console.log()

  const scriptHex = await ask(rl, '  Witness script (hex): ')
  let witnessScript: Uint8Array
  try {
    witnessScript = hexToBytes(scriptHex.trim())
  } catch {
    console.error('\n  ✗ Invalid hex string.\n')
    process.exit(1)
  }

  let parsed: ReturnType<typeof parseWitnessScript>
  try {
    parsed = parseWitnessScript(witnessScript)
  } catch (err) {
    console.error(`\n  ✗ ${(err as Error).message}\n`)
    process.exit(1)
  }

  const address = deriveP2wshAddress(witnessScript)
  console.log(`\n  ✓ Witness script parsed`)

  if (parsed.type === 'single-key') {
    console.log(`    Type:    single-key P2WSH`)
    console.log(`    Pubkey:  ${bytesToHex(parsed.pubkey)}`)
  } else {
    console.log(`    Type:    ${parsed.m}-of-${parsed.n} multisig`)
    for (let i = 0; i < parsed.pubkeys.length; i++) {
      console.log(`    Key [${i}]: ${bytesToHex(parsed.pubkeys[i])}`)
    }
  }
  console.log(`    Address: ${address}`)
  console.log()

  const requiredSigs = parsed.type === 'single-key' ? 1 : parsed.m
  const signerSecretKeys: Uint8Array[] = []

  for (let i = 0; i < requiredSigs; i++) {
    const label = requiredSigs === 1 ? '  Signer key' : `  Signer key ${i + 1}/${requiredSigs}`
    console.log(`  ${label} (WIF or hex):`)
    const keyInput = await ask(rl, '  Input: ')

    let format: InputFormat
    try {
      format = detectFormat(keyInput)
    } catch (err) {
      console.error(`\n  ✗ ${(err as Error).message}\n`)
      process.exit(1)
    }
    if (format === 'seed') {
      console.error('\n  ✗ Seed phrases not supported for individual signer keys. Use WIF or hex.\n')
      process.exit(1)
    }

    let sk: Uint8Array
    try {
      sk = format === 'wif' ? decodeWIF(keyInput.trim()) : hexToBytes(keyInput.trim())
    } catch (err) {
      console.error(`\n  ✗ ${(err as Error).message}\n`)
      process.exit(1)
    }

    const pubkey = secp256k1.getPublicKey(sk, true)
    const pubkeyHex = bytesToHex(pubkey)

    // Verify this pubkey exists in the script
    if (parsed.type === 'single-key') {
      if (pubkeyHex !== bytesToHex(parsed.pubkey)) {
        console.error(`\n  ✗ Key does not match the pubkey in the witness script.\n`)
        process.exit(1)
      }
      console.log(`  ✓ Key matches script pubkey`)
    } else {
      const idx = parsed.pubkeys.findIndex(pk => bytesToHex(pk) === pubkeyHex)
      if (idx === -1) {
        console.error(`\n  ✗ Key does not match any pubkey in the witness script.\n`)
        process.exit(1)
      }
      console.log(`  ✓ Matched pubkey index [${idx}]`)
    }
    console.log()

    signerSecretKeys.push(sk)
  }

  // Sort signer keys to match pubkey order in script (CHECKMULTISIG ordering)
  if (parsed.type === 'multisig') {
    const pubkeyOrder = parsed.pubkeys.map(pk => bytesToHex(pk))
    signerSecretKeys.sort((a, b) => {
      const aPk = bytesToHex(secp256k1.getPublicKey(a, true))
      const bPk = bytesToHex(secp256k1.getPublicKey(b, true))
      return pubkeyOrder.indexOf(aPk) - pubkeyOrder.indexOf(bPk)
    })
  }

  return { witnessScript, signerSecretKeys, address }
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
    // Claim type selection
    console.log('  ── Step 1: BTC Credentials ──────────────────────────────')
    console.log('  What type of claim?')
    console.log('    [1] Single-key (P2PKH, P2WPKH, P2SH-P2WPKH, P2TR) (default)')
    console.log('    [2] P2WSH (witness script — multisig or single-key)')
    console.log()
    const claimTypeChoice = await ask(rl, '  Select [1-2] (default 1): ')
    const isP2wsh = claimTypeChoice.trim() === '2'

    let btcAddress: string
    let btc: { secretKey: Uint8Array; publicKey: Uint8Array; address: string } | undefined
    let p2wsh: { witnessScript: Uint8Array; signerSecretKeys: Uint8Array[]; address: string } | undefined

    if (isP2wsh) {
      console.log()
      p2wsh = await resolveP2wshCredentials(rl)
      btcAddress = p2wsh.address
      console.log(`  P2WSH address: ${btcAddress}`)
    } else {
      btc = await resolveBtcCredentials(rl)
      btcAddress = btc.address
      console.log(`  Public key (compressed): ${bytesToHex(btc.publicKey)}`)
      console.log(`  BTC address (HASH160):   ${btcAddress}`)
    }

    // Snapshot block hash — user must provide it for offline mode
    console.log('\n  ── Step 2: Snapshot Info ─────────────────────────────────')
    console.log('  You need the snapshot block hash and genesis block hash.')
    console.log('  Get them from an online node:')
    console.log('    curl -s http://127.0.0.1:3001/api/v1/block-by-height/0 | jq .transactions[0].inputs[0].publicKey')
    console.log('    curl -s http://127.0.0.1:3001/api/v1/block-by-height/0 | jq .hash')
    console.log()
    const snapshotBlockHash = await ask(rl, '  Snapshot block hash: ')
    if (!/^[0-9a-fA-F]{64}$/.test(snapshotBlockHash.trim())) {
      console.error('\n  ✗ Expected a 64-char hex hash.\n')
      process.exit(1)
    }
    const genesisHashInput = await ask(rl, '  Genesis block hash: ')
    if (!/^[0-9a-fA-F]{64}$/.test(genesisHashInput.trim())) {
      console.error('\n  ✗ Expected a 64-char hex hash.\n')
      process.exit(1)
    }
    const genesisHash = genesisHashInput.trim()

    // Amount
    console.log('\n  You need your exact BTC snapshot balance.')
    console.log('  The node will reject the claim if the amount doesn\'t match.')
    console.log('  Enter the amount in QBTC (e.g. 1.5 for 1.5 QBTC).')
    console.log()
    const amountStr = await ask(rl, '  Snapshot balance (QBTC): ')
    const amountFloat = parseFloat(amountStr.trim())
    if (isNaN(amountFloat) || amountFloat <= 0) {
      console.error('\n  ✗ Invalid amount.\n')
      process.exit(1)
    }
    const amount = Math.round(amountFloat * 100_000_000) // convert to satoshis

    // Generate QBTC wallet
    console.log('\n  ── Step 3: Generate QBTC Wallet ───────────────────────────')
    console.log('  Generating ML-DSA-65 keypair (this may take a moment)...')
    const qbtcWallet = generateWallet()
    console.log(`  ✓ QBTC address: ${qbtcWallet.address}`)

    // Build claim tx
    console.log('\n  ── Step 4: Build Transaction ─────────────────────────────')
    const entry = { btcAddress, amount, ...(isP2wsh ? { type: 'p2wsh' as const } : {}) }
    const tx = isP2wsh
      ? createP2wshClaimTransaction(p2wsh!.signerSecretKeys, p2wsh!.witnessScript, entry, qbtcWallet, snapshotBlockHash.trim(), genesisHash)
      : createClaimTransaction(btc!.secretKey, btc!.publicKey, entry, qbtcWallet, snapshotBlockHash.trim(), genesisHash)
    const serialized = JSON.stringify(sanitize(tx), null, 2)

    // Save to file
    const filename = `claim-${btcAddress.slice(0, 8)}-${Date.now()}.json`
    const filepath = path.resolve(filename)
    fs.writeFileSync(filepath, serialized + '\n')

    console.log(`\n  ✓ Signed claim transaction saved to:`)
    console.log(`    ${filepath}`)
    console.log(`\n  To broadcast:`)
    console.log(`    pnpm run claim:send ${filename}`)
    console.log()
    console.log('  ┌─────────────────────────────────────────────────────────┐')
    console.log('  │  IMPORTANT: Save your QBTC wallet secret key securely!   │')
    console.log('  │  Without it you cannot spend your claimed QBTC.          │')
    console.log('  └─────────────────────────────────────────────────────────┘')
    console.log()
    console.log(`  QBTC address:    ${qbtcWallet.address}`)
    console.log(`  Public key:     ${bytesToHex(qbtcWallet.publicKey).slice(0, 40)}...`)
    console.log(`  Secret key len: ${qbtcWallet.secretKey.length} bytes`)
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
  console.log(`  QBTC address: ${tx.claimData?.qbtcAddress ?? 'unknown'}`)
  const rawAmount = tx.outputs?.[0]?.amount ?? 0
  console.log(`  Amount:      ${(rawAmount / 1e8).toFixed(8)} QBTC (${rawAmount} sat)`)
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
    console.error(`    Make sure qbtcd is running, or set QBTC_RPC=http://host:port.\n`)
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
    console.log(`\n  Your QBTC will appear once the transaction is mined.\n`)
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
  console.log('  ║   QubitCoin — BTC → QBTC Claim Tool                    ║')
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
    console.error(`    Make sure qbtcd is running: pnpm run qbtcd -- --mine --full`)
    console.error(`    Or set QBTC_RPC=http://host:port to use a different node.\n`)
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
  console.log(`  Snapshot: ${(claimStats.totalEntries as number).toLocaleString()} addresses, ${((claimStats.unclaimedAmount as number) / 1e8).toFixed(8)} QBTC claimable`)
  console.log()

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

  try {
    // Claim type selection
    console.log('  ── Step 1: BTC Credentials ──────────────────────────────')
    console.log('  What type of claim?')
    console.log('    [1] Single-key (P2PKH, P2WPKH, P2SH-P2WPKH, P2TR) (default)')
    console.log('    [2] P2WSH (witness script — multisig or single-key)')
    console.log()
    const claimTypeChoice = await ask(rl, '  Select [1-2] (default 1): ')
    const isP2wsh = claimTypeChoice.trim() === '2'

    let btcAddress: string
    let btc: { secretKey: Uint8Array; publicKey: Uint8Array; address: string } | undefined
    let p2wsh: { witnessScript: Uint8Array; signerSecretKeys: Uint8Array[]; address: string } | undefined

    if (isP2wsh) {
      console.log()
      p2wsh = await resolveP2wshCredentials(rl)
      btcAddress = p2wsh.address
      console.log(`  P2WSH address: ${btcAddress}`)
    } else {
      btc = await resolveBtcCredentials(rl)
      btcAddress = btc.address
      console.log(`  Public key (compressed): ${bytesToHex(btc.publicKey)}`)
      console.log(`  BTC address (HASH160):   ${btcAddress}`)
    }

    // Generate QBTC wallet
    console.log('\n  ── Step 2: Generate QBTC Wallet ───────────────────────────')
    console.log('  Generating ML-DSA-65 keypair (this may take a moment)...')
    const qbtcWallet = generateWallet()
    console.log(`  ✓ QBTC address: ${qbtcWallet.address}`)
    console.log()

    // Confirm
    console.log('  ── Step 3: Confirm ──────────────────────────────────────')
    console.log(`  BTC address:  ${btcAddress}`)
    console.log(`  QBTC address:  ${qbtcWallet.address}`)
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

    // Get snapshot block hash and genesis hash from genesis block
    let snapshotBlockHash: string
    let genesisHash: string
    try {
      const genesisRes = await fetch(`${rpcUrl}/block-by-height/0`)
      const genesis = await genesisRes.json() as Record<string, unknown>
      genesisHash = (genesis as { hash: string }).hash
      const txs = (genesis as { transactions: Array<{ inputs: Array<{ publicKey: string }> }> }).transactions
      const coinbasePk = txs?.[0]?.inputs?.[0]?.publicKey ?? ''
      const parts = coinbasePk.split(':')
      if (parts[0] === 'QBTC_FORK' && parts[2]) {
        snapshotBlockHash = parts[2]
      } else {
        snapshotBlockHash = genesisHash
      }
    } catch {
      console.error('  ✗ Could not fetch genesis block to extract snapshot hash.\n')
      process.exit(1)
    }

    // Helper to build claim tx for the resolved type
    const buildClaimTx = (amount: number) => {
      if (isP2wsh) {
        const entry = { btcAddress, amount, type: 'p2wsh' as const }
        return createP2wshClaimTransaction(p2wsh!.signerSecretKeys, p2wsh!.witnessScript, entry, qbtcWallet, snapshotBlockHash, genesisHash)
      }
      const entry = { btcAddress, amount }
      return createClaimTransaction(btc!.secretKey, btc!.publicKey, entry, qbtcWallet, snapshotBlockHash, genesisHash)
    }

    // Probe with amount=0 to discover real balance
    const testTx = buildClaimTx(0)
    const testPayload = JSON.stringify(sanitize(testTx))

    let testRes = await fetch(`${rpcUrl}/tx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: testPayload,
    })

    if (testRes.ok) {
      const result = await testRes.json() as { txid: string }
      printSuccess(result.txid, 0, qbtcWallet)
      process.exit(0)
    }

    const errBody = await testRes.json() as { error?: string }
    const amountMatch = errBody.error?.match(/expected\s+([\d.]+)/)
    if (!amountMatch) {
      console.error(`\n  ✗ ${errBody.error ?? 'Unknown error'}`)
      if (errBody.error?.includes('not found in snapshot')) {
        console.error(`\n  The address ${btcAddress} is not in the BTC snapshot.`)
        console.error(`  Only P2PKH, P2PK, P2WPKH, P2SH-P2WPKH, P2TR, and P2WSH addresses from block 935,941 are eligible.\n`)
      } else if (errBody.error?.includes('already claimed')) {
        console.error(`\n  This BTC address has already been claimed.\n`)
      }
      process.exit(1)
    }

    const realAmount = Number(amountMatch[1])
    console.log(`  Snapshot balance: ${(realAmount / 1e8).toFixed(8)} QBTC (${realAmount} sat)`)

    const tx = buildClaimTx(realAmount)
    const payload = JSON.stringify(sanitize(tx))

    const res = await fetch(`${rpcUrl}/tx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    })

    if (res.ok) {
      const result = await res.json() as { txid: string }
      printSuccess(result.txid, realAmount, qbtcWallet)
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

function printSuccess(txid: string, amount: number, qbtcWallet: { address: string; publicKey: Uint8Array; secretKey: Uint8Array }) {
  console.log(`\n  ✓ Claim transaction broadcast!`)
  console.log(`    txid:   ${txid}`)
  if (amount > 0) console.log(`    amount: ${(amount / 1e8).toFixed(8)} QBTC (${amount} sat)`)
  console.log(`\n  Your QBTC will appear at ${qbtcWallet.address} once mined.`)
  console.log()
  console.log('  ┌─────────────────────────────────────────────────────────┐')
  console.log('  │  IMPORTANT: Save your QBTC wallet secret key securely!   │')
  console.log('  │  Without it you cannot spend your claimed QBTC.          │')
  console.log('  └─────────────────────────────────────────────────────────┘')
  console.log()
  console.log(`  QBTC address:    ${qbtcWallet.address}`)
  console.log(`  Public key:     ${bytesToHex(qbtcWallet.publicKey).slice(0, 40)}...`)
  console.log(`  Secret key len: ${qbtcWallet.secretKey.length} bytes`)
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
