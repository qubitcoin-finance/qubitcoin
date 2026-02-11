/**
 * Bitcoin address balance snapshot for qcoin claim mechanism
 *
 * Represents aggregated balances per BTC address at a specific block height.
 * BTC holders prove ownership of their address to claim qcoin equivalents.
 */
import { sha256 } from '@noble/hashes/sha2.js'
import {
  hash160,
  generateBtcKeypair,
  doubleSha256Hex,
  bytesToHex,
  concatBytes,
} from './crypto.js'

export interface BtcAddressBalance {
  btcAddress: string  // 40-char hex HASH160(compressed pubkey)
  amount: number      // total satoshis for this address
}

export interface BtcSnapshot {
  btcBlockHeight: number  // Bitcoin block height at snapshot
  btcBlockHash: string    // Bitcoin block hash at snapshot
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
    inner.update(encoder.encode(`${entry.btcAddress}:${entry.amount};`))
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
export function createMockSnapshot(): {
  snapshot: BtcSnapshot
  holders: Array<{ secretKey: Uint8Array; publicKey: Uint8Array; address: string; amount: number }>
} {
  const holderAmounts = [100, 250, 50, 500, 75] // BTC amounts for 5 holders
  const holders: Array<{
    secretKey: Uint8Array
    publicKey: Uint8Array
    address: string
    amount: number
  }> = []
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

  const merkleRoot = computeSnapshotMerkleRoot(entries)

  const snapshot: BtcSnapshot = {
    btcBlockHeight: 850_000,
    btcBlockHash: doubleSha256Hex(new TextEncoder().encode('mock-btc-block-850000')),
    entries,
    merkleRoot,
  }

  return { snapshot, holders }
}
