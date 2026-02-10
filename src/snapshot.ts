/**
 * Bitcoin address balance snapshot for qcoin claim mechanism
 *
 * Represents aggregated balances per BTC address at a specific block height.
 * BTC holders prove ownership of their address to claim qcoin equivalents.
 */
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

/** Compute a commitment hash over all snapshot entries */
export function computeSnapshotMerkleRoot(entries: BtcAddressBalance[]): string {
  if (entries.length === 0) return '0'.repeat(64)

  const encoder = new TextEncoder()
  let totalLen = 0
  const parts: Uint8Array[] = []

  for (const entry of entries) {
    const chunk = encoder.encode(`${entry.btcAddress}:${entry.amount};`)
    parts.push(chunk)
    totalLen += chunk.length
  }

  const buf = new Uint8Array(totalLen)
  let offset = 0
  for (const chunk of parts) {
    buf.set(chunk, offset)
    offset += chunk.length
  }

  return doubleSha256Hex(buf)
}

/** WeakMap-cached index for O(1) address lookups */
const snapshotIndexCache = new WeakMap<BtcAddressBalance[], Map<string, BtcAddressBalance>>()

export function getSnapshotIndex(snapshot: BtcSnapshot): Map<string, BtcAddressBalance> {
  let index = snapshotIndexCache.get(snapshot.entries)
  if (index) return index

  index = new Map<string, BtcAddressBalance>()
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
