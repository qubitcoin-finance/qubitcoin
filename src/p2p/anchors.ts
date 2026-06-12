/**
 * Anchor peers
 *
 * Persist and reload the most-recently-seen known addresses so a restarted
 * node has working peers without waiting on seeds.
 */
import fs from 'node:fs'
import { log } from '../log.js'
import { type KnownAddress, parseAddressEntry } from './address-book.js'

export const MAX_ANCHORS = 10

/** Read anchor entries from disk (returns [] on missing/corrupt file) */
export function readAnchors(
  anchorsPath: string,
): Array<{ host: string; port: number; lastSeen?: number }> {
  try {
    const data = fs.readFileSync(anchorsPath, 'utf-8')
    const anchors: unknown = JSON.parse(data)
    if (!Array.isArray(anchors)) return []
    const result: Array<{ host: string; port: number; lastSeen?: number }> = []
    for (const a of anchors) {
      const parsed = parseAddressEntry(a)
      if (parsed) {
        result.push(parsed)
      } else {
        log.warn({ component: 'p2p' }, 'Skipping malformed anchor entry')
      }
    }
    return result
  } catch (err) {
    log.debug({ component: 'p2p', err }, 'Could not load anchors — starting fresh')
    return []
  }
}

/** Persist the most-recently-seen known addresses as anchor peers */
export function writeAnchors(
  anchorsPath: string,
  knownAddresses: ReadonlyMap<string, KnownAddress>,
  maxAnchors = MAX_ANCHORS,
): void {
  const entries = Array.from(knownAddresses.values())
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .slice(0, maxAnchors)
  try {
    fs.writeFileSync(anchorsPath, JSON.stringify(entries, null, 2) + '\n')
  } catch (err) {
    log.debug({ component: 'p2p', err }, 'Could not save anchors — data dir may not be writable')
  }
}
