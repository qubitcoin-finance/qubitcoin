import net from 'node:net'

export interface KnownAddress {
  host: string
  port: number
  lastSeen: number
}

export interface ParsedAddressEntry {
  host: string
  port: number
  lastSeen?: number
}

/** Extract /16 subnet prefix from an IPv4 address (e.g., "1.2" from "1.2.3.4") */
export function getSubnet16(ip: string): string {
  const normalized = ip.replace(/^::ffff:/i, '')
  const match = normalized.match(/^(\d+\.\d+)\.\d+\.\d+$/)
  return match ? match[1] : ip
}

/** Returns true if host is a valid IPv4 or IPv6 address string */
export function isValidIPAddress(host: string): boolean {
  return net.isIP(host) !== 0
}

/** Check if an IP address is publicly routable (not private/loopback/link-local) */
export function isRoutableAddress(host: string): boolean {
  if (host === '::1' || host === '::') return false
  if (host.startsWith('fc') || host.startsWith('fd')) return false
  if (host.startsWith('fe80')) return false

  const ipv4Match = host.match(/(?:::ffff:)?(\d+\.\d+\.\d+\.\d+)$/i)
  if (ipv4Match) {
    const parts = ipv4Match[1].split('.').map(Number)
    const [a, b] = parts
    if (a === 127) return false
    if (a === 10) return false
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 192 && b === 168) return false
    if (a === 169 && b === 254) return false
    if (a === 0) return false
  }

  return true
}

/** Strip ::ffff: prefix from IPv4-mapped IPv6 addresses */
export function normalizeIP(ip: string): string {
  return ip.replace(/^::ffff:/i, '')
}

/** Check if a peer matches a given host:port, with IPv6 normalization */
export function peerMatchesHost(peer: { id: string; address: string }, host: string, port: number): boolean {
  if (peer.id === `${host}:${port}`) return true
  return normalizeIP(peer.address) === normalizeIP(host)
}

export function parseAddressEntry(entry: unknown): ParsedAddressEntry | null {
  if (entry == null || typeof entry !== 'object') return null

  const candidate = entry as {
    host?: unknown
    port?: unknown
    lastSeen?: unknown
  }

  if (typeof candidate.host !== 'string' || !isValidIPAddress(candidate.host)) return null
  if (typeof candidate.port !== 'number' || !Number.isInteger(candidate.port) || candidate.port <= 0 || candidate.port > 65535) return null
  if (candidate.lastSeen !== undefined && (typeof candidate.lastSeen !== 'number' || !Number.isFinite(candidate.lastSeen))) return null

  const parsed: ParsedAddressEntry = {
    host: candidate.host,
    port: candidate.port,
  }
  if (candidate.lastSeen !== undefined) parsed.lastSeen = candidate.lastSeen
  return parsed
}

export function upsertKnownAddress(
  knownAddresses: Map<string, KnownAddress>,
  host: string,
  port: number,
  lastSeen: number | undefined,
  options: {
    localMode: boolean
    enforceRoutability: boolean
    maxAddresses: number
    now?: number
  },
): void {
  if (options.enforceRoutability && !options.localMode && !isRoutableAddress(host)) return

  const key = `${host}:${port}`
  const existing = knownAddresses.get(key)
  const currentTime = options.now ?? Date.now()
  const maxFuture = currentTime + 2 * 3600_000
  const updatedLastSeen = Math.min(lastSeen ?? currentTime, maxFuture)
  if (existing && existing.lastSeen >= updatedLastSeen) return

  knownAddresses.set(key, { host, port, lastSeen: updatedLastSeen })

  if (knownAddresses.size > options.maxAddresses) {
    let oldestKey = ''
    let oldestTime = Infinity
    for (const [k, v] of knownAddresses) {
      if (v.lastSeen < oldestTime) {
        oldestTime = v.lastSeen
        oldestKey = k
      }
    }
    if (oldestKey) knownAddresses.delete(oldestKey)
  }
}
