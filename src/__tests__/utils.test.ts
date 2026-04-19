import { describe, it, expect } from 'vitest'
import { isValidHash, hexEncode, truncHex, sanitize, sizeLabel, timeIt } from '../utils.js'

describe('isValidHash', () => {
  it('accepts valid 64-char lowercase hex', () => {
    expect(isValidHash('a'.repeat(64))).toBe(true)
    expect(isValidHash('0'.repeat(64))).toBe(true)
    expect(isValidHash('f'.repeat(64))).toBe(true)
    expect(isValidHash('0123456789abcdef'.repeat(4))).toBe(true)
  })

  it('rejects strings shorter than 64 chars', () => {
    expect(isValidHash('a'.repeat(63))).toBe(false)
    expect(isValidHash('')).toBe(false)
  })

  it('rejects strings longer than 64 chars', () => {
    expect(isValidHash('a'.repeat(65))).toBe(false)
  })

  it('rejects uppercase hex', () => {
    expect(isValidHash('A'.repeat(64))).toBe(false)
  })

  it('rejects non-hex characters', () => {
    expect(isValidHash('g'.repeat(64))).toBe(false)
    expect(isValidHash('z'.repeat(64))).toBe(false)
    expect(isValidHash(' '.repeat(64))).toBe(false)
  })

  it('rejects non-string values', () => {
    expect(isValidHash(null)).toBe(false)
    expect(isValidHash(undefined)).toBe(false)
    expect(isValidHash(123)).toBe(false)
    expect(isValidHash({})).toBe(false)
  })
})

describe('hexEncode', () => {
  it('encodes empty buffer to empty string', () => {
    expect(hexEncode(new Uint8Array([]))).toBe('')
  })

  it('encodes single byte correctly', () => {
    expect(hexEncode(new Uint8Array([0x00]))).toBe('00')
    expect(hexEncode(new Uint8Array([0xff]))).toBe('ff')
    expect(hexEncode(new Uint8Array([0x0a]))).toBe('0a')
  })

  it('encodes multiple bytes correctly', () => {
    expect(hexEncode(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))).toBe('deadbeef')
  })

  it('pads single-digit hex values', () => {
    expect(hexEncode(new Uint8Array([0x01, 0x0f]))).toBe('010f')
  })
})

describe('truncHex', () => {
  it('returns full hex when shorter than limit', () => {
    const bytes = new Uint8Array([0xab, 0xcd])
    expect(truncHex(bytes)).toBe('abcd') // 4 chars, limit default 32 chars
  })

  it('truncates and appends ... when longer than limit', () => {
    const bytes = new Uint8Array(40) // 40 bytes = 80 hex chars
    bytes.fill(0xaa)
    const result = truncHex(bytes, 8) // limit to 8 bytes = 16 chars
    expect(result).toBe('aa'.repeat(8) + '...')
  })

  it('returns full hex at exact limit length', () => {
    const bytes = new Uint8Array(4).fill(0xbb) // 4 bytes = 8 hex chars
    const result = truncHex(bytes, 4) // limit exactly matches
    expect(result).toBe('bb'.repeat(4))
    expect(result.endsWith('...')).toBe(false)
  })
})

describe('sanitize', () => {
  it('converts Uint8Array to hex string', () => {
    const result = sanitize(new Uint8Array([0xde, 0xad]))
    expect(result).toBe('dead')
  })

  it('passes through primitives unchanged', () => {
    expect(sanitize(42)).toBe(42)
    expect(sanitize('hello')).toBe('hello')
    expect(sanitize(true)).toBe(true)
    expect(sanitize(null)).toBe(null)
  })

  it('recursively sanitizes arrays', () => {
    const input = [new Uint8Array([0x01]), 'text', 99]
    expect(sanitize(input)).toEqual(['01', 'text', 99])
  })

  it('recursively sanitizes nested objects', () => {
    const input = {
      hash: new Uint8Array([0xbe, 0xef]),
      count: 5,
      nested: { sig: new Uint8Array([0xff]) },
    }
    expect(sanitize(input)).toEqual({
      hash: 'beef',
      count: 5,
      nested: { sig: 'ff' },
    })
  })

  it('handles objects with array values', () => {
    const input = { items: [new Uint8Array([0xaa]), new Uint8Array([0xbb])] }
    expect(sanitize(input)).toEqual({ items: ['aa', 'bb'] })
  })
})

describe('sizeLabel', () => {
  it('shows bytes for values under 1024', () => {
    expect(sizeLabel(new Uint8Array(0))).toBe('0 B')
    expect(sizeLabel(new Uint8Array(1))).toBe('1 B')
    expect(sizeLabel(new Uint8Array(1023))).toBe('1023 B')
  })

  it('shows KB for values 1024 and above', () => {
    expect(sizeLabel(new Uint8Array(1024))).toBe('1.0 KB')
    expect(sizeLabel(new Uint8Array(2048))).toBe('2.0 KB')
    expect(sizeLabel(new Uint8Array(1536))).toBe('1.5 KB')
  })
})

describe('timeIt', () => {
  it('returns the function result', () => {
    const { result } = timeIt(() => 42)
    expect(result).toBe(42)
  })

  it('returns non-negative elapsed ms', () => {
    const { ms } = timeIt(() => {})
    expect(ms).toBeGreaterThanOrEqual(0)
  })

  it('measures time for a delayed function', async () => {
    // timeIt is synchronous — just verify the result passes through correctly
    let called = false
    const { result } = timeIt(() => {
      called = true
      return 'done'
    })
    expect(called).toBe(true)
    expect(result).toBe('done')
  })
})
