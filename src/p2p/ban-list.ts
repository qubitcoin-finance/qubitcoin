/**
 * Ban list
 *
 * Tracks misbehaving peer IPs with timed expiry, persisted to disk.
 */
import fs from 'node:fs'
import { log } from '../log.js'
import { normalizeIP } from './address-book.js'

const BAN_DURATION_MS = 24 * 60 * 60 * 1000 // 24h

export class BanList {
  private bans: Map<string, number> = new Map() // IP -> expiry timestamp
  private path: string | null

  constructor(banListPath: string | null = null) {
    this.path = banListPath
    if (this.path) this.load()
  }

  isBanned(ip: string): boolean {
    const normalized = normalizeIP(ip)
    const expiry = this.bans.get(normalized)
    if (expiry === undefined) return false
    if (Date.now() > expiry) {
      this.bans.delete(normalized)
      return false
    }
    return true
  }

  ban(ip: string): void {
    const normalized = normalizeIP(ip)
    log.warn({ component: 'p2p', ip: normalized }, 'Banning peer for 24h')
    this.bans.set(normalized, Date.now() + BAN_DURATION_MS)
    this.save()
  }

  private load(): void {
    if (!this.path) return
    try {
      const raw = JSON.parse(fs.readFileSync(this.path, 'utf-8'))
      const now = Date.now()
      for (const [ip, expiry] of Object.entries(raw)) {
        if (typeof expiry === 'number' && expiry > now) {
          this.bans.set(ip, expiry)
        }
      }
    } catch (err) {
      log.debug({ component: 'p2p', err }, 'Could not load ban list — starting fresh')
    }
  }

  private save(): void {
    if (!this.path) return
    const obj: Record<string, number> = {}
    for (const [ip, expiry] of this.bans) {
      obj[ip] = expiry
    }
    fs.writeFileSync(this.path, JSON.stringify(obj, null, 2) + '\n')
  }
}
