/**
 * Bitcoin address balance snapshot for qbtc claim mechanism
 *
 * Represents aggregated balances per BTC address at a specific block height.
 * Supports P2PKH, P2WPKH, P2SH-P2WPKH (wrapped SegWit), P2TR, and P2WSH addresses.
 * BTC holders prove ownership of their address to claim qbtc equivalents.
 */
import { sha256 } from '@noble/hashes/sha2.js'
import {
  hash160,
  generateBtcKeypair,
  deriveP2shP2wpkhAddress,
  deriveP2shMultisigAddress,
  getSchnorrPublicKey,
  deriveP2trAddress,
  buildMultisigScript,
  deriveP2wshAddress,
  doubleSha256Hex,
  bytesToHex,
  concatBytes,
} from './crypto.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'

export interface BtcAddressBalance {
  btcAddress: string  // 40-char hex HASH160(compressed pubkey), HASH160(redeemScript) for P2SH, or 64-char hex for P2TR/P2WSH/multisig
  amount: number      // total satoshis for this address
  type?: 'p2sh' | 'p2tr' | 'p2wsh' | 'multisig'  // absent = P2PKH/P2WPKH (keyhash), 'p2sh' = P2SH-P2WPKH, 'p2tr' = Taproot, 'p2wsh' = P2WSH, 'multisig' = bare multisig
}

export interface BtcSnapshot {
  btcBlockHeight: number  // Bitcoin block height at snapshot
  btcBlockHash: string    // Bitcoin block hash at snapshot
  btcTimestamp: number     // Bitcoin block timestamp (unix seconds)
  entries: BtcAddressBalance[]
  merkleRoot: string      // commitment hash over all entries
}

/** Derive a Bitcoin-style address (hex of HASH160) from a compressed public key */
export function deriveBtcAddress(compressedPubKey: Uint8Array): string {
  return bytesToHex(hash160(compressedPubKey))
}

/** Compute a commitment hash over all snapshot entries (streaming — constant memory) */
export function computeSnapshotMerkleRoot(entries: BtcAddressBalance[]): string {
  if (entries.length === 0) return '0'.repeat(64)

  const encoder = new TextEncoder()
  const inner = sha256.create()
  for (const entry of entries) {
    const prefix = entry.type ? `${entry.type}:` : ''
    inner.update(encoder.encode(`${prefix}${entry.btcAddress}:${entry.amount};`))
  }
  return bytesToHex(sha256(inner.digest()))
}

/**
 * Sharded address index — O(1) lookups, no V8 Map size limit.
 * Splits entries across 256 Maps keyed by first 2 hex chars of address.
 */
export class ShardedIndex {
  private shards: Map<string, BtcAddressBalance>[] = new Array(256)

  constructor() {
    for (let i = 0; i < 256; i++) {
      this.shards[i] = new Map()
    }
  }

  private shard(key: string): Map<string, BtcAddressBalance> {
    const idx = parseInt(key.slice(0, 2), 16)
    return this.shards[idx] ?? this.shards[0]
  }

  set(key: string, value: BtcAddressBalance): void {
    this.shard(key).set(key, value)
  }

  get(key: string): BtcAddressBalance | undefined {
    return this.shard(key).get(key)
  }

  has(key: string): boolean {
    return this.shard(key).has(key)
  }
}

/** WeakMap-cached index for O(1) address lookups */
const snapshotIndexCache = new WeakMap<BtcAddressBalance[], ShardedIndex>()

export function getSnapshotIndex(snapshot: BtcSnapshot): ShardedIndex {
  let index = snapshotIndexCache.get(snapshot.entries)
  if (index) return index

  index = new ShardedIndex()
  for (const entry of snapshot.entries) {
    index.set(entry.btcAddress, entry)
  }
  snapshotIndexCache.set(snapshot.entries, index)
  return index
}

/**
 * Create a mock BTC snapshot for demo purposes.
 * Returns the snapshot plus the secret keys (so the demo can sign claims).
 */
export interface MockHolder {
  secretKey: Uint8Array
  publicKey: Uint8Array
  address: string
  amount: number
  type?: 'p2sh' | 'p2tr' | 'p2wsh'
  witnessScript?: Uint8Array
  signerKeys?: Array<{ secretKey: Uint8Array; publicKey: Uint8Array }>
}

export function createMockSnapshot(): {
  snapshot: BtcSnapshot
  holders: MockHolder[]
} {
  const holderAmounts = [100, 250, 50, 500, 75] // BTC amounts for 5 P2PKH/P2WPKH holders
  const p2shAmounts = [200] // BTC amounts for P2SH-P2WPKH holders
  const p2shMultisigAmounts = [350] // BTC amounts for P2SH multisig (2-of-3) holders
  const p2trAmounts = [300] // BTC amounts for P2TR (Taproot) holders
  const p2wshAmounts = [400] // BTC amounts for P2WSH (2-of-3 multisig) holders
  const holders: MockHolder[] = []
  const entries: BtcAddressBalance[] = []

  for (let i = 0; i < holderAmounts.length; i++) {
    const kp = generateBtcKeypair()
    const address = deriveBtcAddress(kp.publicKey)
    holders.push({
      secretKey: kp.secretKey,
      publicKey: kp.publicKey,
      address,
      amount: holderAmounts[i],
    })

    entries.push({
      btcAddress: address,
      amount: holderAmounts[i],
    })
  }

  // Add P2SH-P2WPKH holders
  for (let i = 0; i < p2shAmounts.length; i++) {
    const kp = generateBtcKeypair()
    const address = deriveP2shP2wpkhAddress(kp.publicKey)
    holders.push({
      secretKey: kp.secretKey,
      publicKey: kp.publicKey,
      address,
      amount: p2shAmounts[i],
      type: 'p2sh',
    })

    entries.push({
      btcAddress: address,
      amount: p2shAmounts[i],
      type: 'p2sh',
    })
  }

  // Add P2SH multisig (2-of-3) holders
  for (let i = 0; i < p2shMultisigAmounts.length; i++) {
    const signerKeys = [generateBtcKeypair(), generateBtcKeypair(), generateBtcKeypair()]
    const pubkeys = signerKeys.map(kp => kp.publicKey)
    const redeemScript = buildMultisigScript(2, pubkeys)
    const address = deriveP2shMultisigAddress(redeemScript)
    holders.push({
      secretKey: signerKeys[0].secretKey,
      publicKey: signerKeys[0].publicKey,
      address,
      amount: p2shMultisigAmounts[i],
      type: 'p2sh',
      witnessScript: redeemScript,
      signerKeys,
    })

    entries.push({
      btcAddress: address,
      amount: p2shMultisigAmounts[i],
      type: 'p2sh',
    })
  }

  // Add P2TR (Taproot) holders
  for (let i = 0; i < p2trAmounts.length; i++) {
    const secretKey = secp256k1.utils.randomSecretKey()
    const internalPubkey = getSchnorrPublicKey(secretKey)
    const address = deriveP2trAddress(internalPubkey)
    holders.push({
      secretKey,
      publicKey: internalPubkey, // 32-byte x-only for P2TR
      address,
      amount: p2trAmounts[i],
      type: 'p2tr',
    })

    entries.push({
      btcAddress: address,
      amount: p2trAmounts[i],
      type: 'p2tr',
    })
  }

  // Add P2WSH (2-of-3 multisig) holders
  for (let i = 0; i < p2wshAmounts.length; i++) {
    const signerKeys = [generateBtcKeypair(), generateBtcKeypair(), generateBtcKeypair()]
    const pubkeys = signerKeys.map(kp => kp.publicKey)
    const witnessScript = buildMultisigScript(2, pubkeys)
    const address = deriveP2wshAddress(witnessScript)
    holders.push({
      secretKey: signerKeys[0].secretKey, // first key as default
      publicKey: signerKeys[0].publicKey,
      address,
      amount: p2wshAmounts[i],
      type: 'p2wsh',
      witnessScript,
      signerKeys,
    })

    entries.push({
      btcAddress: address,
      amount: p2wshAmounts[i],
      type: 'p2wsh',
    })
  }

  const merkleRoot = computeSnapshotMerkleRoot(entries)

  const snapshot: BtcSnapshot = {
    btcBlockHeight: 850_000,
    btcBlockHash: doubleSha256Hex(new TextEncoder().encode('mock-btc-block-850000')),
    btcTimestamp: Math.floor(Date.now() / 1000),
    entries,
    merkleRoot,
  }

  return { snapshot, holders }
}
