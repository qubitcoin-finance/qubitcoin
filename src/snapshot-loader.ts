/**
 * Load a real BTC snapshot from an NDJSON file.
 *
 * Each line: {"a":"<hex hash160>","b":<satoshis>}
 * Returns a BtcSnapshot suitable for the Blockchain constructor.
 */
import fs from 'node:fs'
import { type BtcSnapshot, type BtcAddressBalance, computeSnapshotMerkleRoot } from './snapshot.js'
import { doubleSha256Hex } from './crypto.js'

export function loadSnapshot(filePath: string): BtcSnapshot {
  const content = fs.readFileSync(filePath, 'utf-8').trimEnd()
  const lines = content.split('\n')

  const entries: BtcAddressBalance[] = []
  for (const line of lines) {
    if (!line) continue
    const raw = JSON.parse(line) as { a: string; b: number }
    entries.push({ btcAddress: raw.a, amount: raw.b })
  }

  // The snapshot doesn't carry its own block height/hash, so use placeholders.
  // A real deployment would embed these in the NDJSON header line.
  const merkleRoot = computeSnapshotMerkleRoot(entries)

  const snapshot: BtcSnapshot = {
    btcBlockHeight: 0,     // overridden by caller if known
    btcBlockHash: doubleSha256Hex(new TextEncoder().encode('btc-snapshot')),
    entries,
    merkleRoot,
  }

  return snapshot
}
