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

    const raw = JSON.parse(line) as { a: string; b: number }
    entries.push({ btcAddress: raw.a, amount: raw.b })
  }

  if (!merkleRoot) {
    // Legacy format without header — compute merkle root
    const { computeSnapshotMerkleRoot } = await import('./snapshot.js')
    merkleRoot = computeSnapshotMerkleRoot(entries)
  }

  if (!btcBlockHash) {
    const { doubleSha256Hex } = await import('./crypto.js')
    btcBlockHash = doubleSha256Hex(new TextEncoder().encode('btc-snapshot'))
  }

  return {
    btcBlockHeight,
    btcBlockHash,
    btcTimestamp,
    entries,
    merkleRoot,
  }
}
