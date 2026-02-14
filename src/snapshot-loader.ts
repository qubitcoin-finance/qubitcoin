/**
 * Load a real BTC snapshot from an NDJSON file.
 *
 * Streams the file line-by-line (constant memory overhead for I/O).
 * First line is the header with metadata (merkleRoot, blockHash, count).
 * Remaining lines: {"a":"<hex hash160>","b":<satoshis>}
 */
import fs from 'node:fs'
import readline from 'node:readline'
import { type BtcSnapshot, type BtcAddressBalance } from './snapshot.js'

export async function loadSnapshot(filePath: string): Promise<BtcSnapshot> {
  const entries: BtcAddressBalance[] = []
  let merkleRoot = ''
  let btcBlockHash = ''
  let btcBlockHeight = 0
  let btcTimestamp = 0
  let isFirstLine = true

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  })

  for await (const line of rl) {
    if (!line) continue

    if (isFirstLine) {
      isFirstLine = false
      // Try to parse as header (has 'merkleRoot' field)
      const raw = JSON.parse(line)
      if (raw.merkleRoot) {
        merkleRoot = raw.merkleRoot
        btcBlockHash = raw.hash || ''
        btcBlockHeight = raw.height || 0
        btcTimestamp = raw.timestamp || 0
        continue
      }
      // No header — treat as a regular entry
    }

    const raw = JSON.parse(line) as { a: string; b: number; t?: string }
    entries.push({
      btcAddress: raw.a,
      amount: raw.b,
      ...(raw.t === 'p2sh' ? { type: 'p2sh' as const } : raw.t === 'p2tr' ? { type: 'p2tr' as const } : raw.t === 'p2wsh' ? { type: 'p2wsh' as const } : raw.t === 'multisig' ? { type: 'multisig' as const } : {}),
    })
  }

  const hasHeader = !!merkleRoot  // true if the file had an explicit header line

  if (!merkleRoot) {
    // Legacy format without header — compute merkle root
    const { computeSnapshotMerkleRoot } = await import('./snapshot.js')
    merkleRoot = computeSnapshotMerkleRoot(entries)
  }
  if (!btcBlockHash) {
    const { doubleSha256Hex } = await import('./crypto.js')
    btcBlockHash = doubleSha256Hex(new TextEncoder().encode('btc-snapshot'))
  }

  // Known block timestamps for snapshots missing the timestamp field
  // Block 935,941 (2025-02-13 21:29:42 UTC)
  if (!btcTimestamp && btcBlockHash === '3aafae11a317cdd4fa7802ad577e741501e1fa0e970101000000000000000000') {
    btcTimestamp = 1739482182
  }

  if (!btcTimestamp && hasHeader) {
    throw new Error('Snapshot missing btcTimestamp — cannot create deterministic genesis. Add "timestamp" to the snapshot header.')
  }

  // Legacy/test snapshots without a header get a fixed timestamp
  if (!btcTimestamp) {
    btcTimestamp = 1739482182
  }

  return {
    btcBlockHeight,
    btcBlockHash,
    btcTimestamp,
    entries,
    merkleRoot,
  }
}
