/** Validate that a value is a 64-character lowercase hex string (SHA-256 hash) */
export function isValidHash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

export function hexEncode(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export function truncHex(bytes: Uint8Array, len = 32): string {
  const hex = hexEncode(bytes)
  return hex.length > len * 2 ? hex.slice(0, len * 2) + '...' : hex
}

export function banner(title: string): void {
  const line = '='.repeat(60)
  console.log(`\n${line}`)
  console.log(`  ${title}`)
  console.log(`${line}\n`)
}

export function sizeLabel(bytes: Uint8Array): string {
  const size = bytes.length
  if (size < 1024) return `${size} B`
  return `${(size / 1024).toFixed(1)} KB`
}

export function timeIt<T>(fn: () => T): { result: T; ms: number } {
  const start = performance.now()
  const result = fn()
  const ms = performance.now() - start
  return { result, ms }
}

/** Recursively convert Uint8Array fields to hex strings for JSON serialization */
export function sanitize(obj: unknown): unknown {
  if (obj instanceof Uint8Array) return hexEncode(obj)
  if (Array.isArray(obj)) return obj.map(sanitize)
  if (obj !== null && typeof obj === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) {
      out[k] = sanitize(v)
    }
    return out
  }
  return obj
}
