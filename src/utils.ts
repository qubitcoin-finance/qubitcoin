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
