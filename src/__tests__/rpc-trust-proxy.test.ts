import { describe, it, expect } from 'vitest'
import { DEFAULT_TRUSTED_PROXIES, parseRpcTrustProxy } from '../rpc-trust-proxy.js'

describe('parseRpcTrustProxy', () => {
  it('uses the default trusted proxy ranges when unset', () => {
    expect(parseRpcTrustProxy(undefined)).toEqual([...DEFAULT_TRUSTED_PROXIES])
    expect(parseRpcTrustProxy('   ')).toEqual([...DEFAULT_TRUSTED_PROXIES])
  })

  it('parses booleans and hop counts into Express-compatible types', () => {
    expect(parseRpcTrustProxy('false')).toBe(false)
    expect(parseRpcTrustProxy('0')).toBe(false)
    expect(parseRpcTrustProxy('true')).toBe(true)
    expect(parseRpcTrustProxy('on')).toBe(true)
    expect(parseRpcTrustProxy('1')).toBe(1)
    expect(parseRpcTrustProxy('2')).toBe(2)
    expect(parseRpcTrustProxy('12')).toBe(12)
  })

  it('parses proxy lists', () => {
    expect(parseRpcTrustProxy('loopback, 10.0.0.0/8')).toEqual(['loopback', '10.0.0.0/8'])
  })

  it('rejects invalid numeric-like values instead of treating them as proxy labels', () => {
    expect(() => parseRpcTrustProxy('-1')).toThrow('hop count must be a positive integer')
    expect(() => parseRpcTrustProxy('1.5')).toThrow('hop count must be a positive integer')
  })
})
