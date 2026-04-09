import { describe, it, expect } from 'vitest'
import type { KemAlgorithm, SigAlgorithm } from '../benchmark.js'

/**
 * Tests for the benchmark module's typed algorithm interfaces.
 * These verify that the KemAlgorithm and SigAlgorithm interfaces
 * correctly describe the PQC algorithm contract, and that mock
 * implementations satisfying them produce correct BenchResult shapes.
 */

describe('KemAlgorithm interface', () => {
  it('accepts a conforming mock KEM implementation', () => {
    const sharedSecret = new Uint8Array(32).fill(0xab)
    const cipherText = new Uint8Array(768).fill(0xcd)

    const mockKem: KemAlgorithm = {
      keygen() {
        return {
          publicKey: new Uint8Array(1184).fill(0x01),
          secretKey: new Uint8Array(2400).fill(0x02),
        }
      },
      encapsulate(_pk: Uint8Array) {
        return { cipherText, sharedSecret }
      },
      decapsulate(_ct: Uint8Array, _sk: Uint8Array) {
        return sharedSecret
      },
    }

    const keys = mockKem.keygen()
    expect(keys.publicKey).toBeInstanceOf(Uint8Array)
    expect(keys.secretKey).toBeInstanceOf(Uint8Array)
    expect(keys.publicKey.length).toBe(1184)
    expect(keys.secretKey.length).toBe(2400)

    const encap = mockKem.encapsulate(keys.publicKey)
    expect(encap.cipherText).toBeInstanceOf(Uint8Array)
    expect(encap.sharedSecret).toBeInstanceOf(Uint8Array)
    expect(encap.cipherText.length).toBe(768)
    expect(encap.sharedSecret.length).toBe(32)

    const decapped = mockKem.decapsulate(encap.cipherText, keys.secretKey)
    expect(decapped).toBeInstanceOf(Uint8Array)
    expect(decapped).toEqual(sharedSecret)
  })

  it('enforces that publicKey and secretKey are Uint8Array', () => {
    const mockKem: KemAlgorithm = {
      keygen() {
        return {
          publicKey: new Uint8Array([1, 2, 3]),
          secretKey: new Uint8Array([4, 5, 6]),
        }
      },
      encapsulate(_pk: Uint8Array) {
        return { cipherText: new Uint8Array(1), sharedSecret: new Uint8Array(1) }
      },
      decapsulate(_ct: Uint8Array, _sk: Uint8Array) {
        return new Uint8Array(1)
      },
    }

    const keys = mockKem.keygen()
    expect(keys.publicKey).toBeInstanceOf(Uint8Array)
    expect(keys.secretKey).toBeInstanceOf(Uint8Array)
  })
})

describe('SigAlgorithm interface', () => {
  it('accepts a conforming mock signature implementation', () => {
    const mockSig: Uint8Array = new Uint8Array(3309).fill(0xee)

    const impl: SigAlgorithm = {
      keygen() {
        return {
          publicKey: new Uint8Array(1952).fill(0x01),
          secretKey: new Uint8Array(4032).fill(0x02),
        }
      },
      sign(_msg: Uint8Array, _sk: Uint8Array) {
        return mockSig
      },
      verify(_sig: Uint8Array, _msg: Uint8Array, _pk: Uint8Array) {
        return true
      },
    }

    const keys = impl.keygen()
    expect(keys.publicKey).toBeInstanceOf(Uint8Array)
    expect(keys.secretKey).toBeInstanceOf(Uint8Array)
    expect(keys.publicKey.length).toBe(1952) // ML-DSA-65 public key size
    expect(keys.secretKey.length).toBe(4032) // ML-DSA-65 secret key size

    const msg = new TextEncoder().encode('test message')
    const sig = impl.sign(msg, keys.secretKey)
    expect(sig).toBeInstanceOf(Uint8Array)
    expect(sig.length).toBe(3309) // ML-DSA-65 signature size

    const valid = impl.verify(sig, msg, keys.publicKey)
    expect(valid).toBe(true)
  })

  it('verify returns boolean, not truthy value', () => {
    const impl: SigAlgorithm = {
      keygen() {
        return { publicKey: new Uint8Array(1), secretKey: new Uint8Array(1) }
      },
      sign(_msg: Uint8Array, _sk: Uint8Array) {
        return new Uint8Array(1)
      },
      verify(_sig: Uint8Array, _msg: Uint8Array, _pk: Uint8Array) {
        return false
      },
    }

    const result = impl.verify(new Uint8Array(1), new Uint8Array(1), new Uint8Array(1))
    expect(typeof result).toBe('boolean')
    expect(result).toBe(false)
  })
})

describe('SigAlgorithm with real ML-DSA-65', () => {
  it('ml_dsa65 satisfies SigAlgorithm interface', async () => {
    const { ml_dsa65 } = await import('@noble/post-quantum/ml-dsa.js')
    // TypeScript compile-time check: ml_dsa65 must satisfy SigAlgorithm
    const algo: SigAlgorithm = ml_dsa65

    const keys = algo.keygen()
    expect(keys.publicKey).toBeInstanceOf(Uint8Array)
    expect(keys.secretKey).toBeInstanceOf(Uint8Array)
    expect(keys.publicKey.length).toBe(1952)
    expect(keys.secretKey.length).toBe(4032)

    const msg = new TextEncoder().encode('qubitcoin benchmark test')
    const sig = algo.sign(msg, keys.secretKey)
    expect(sig).toBeInstanceOf(Uint8Array)
    expect(sig.length).toBe(3309)

    const valid = algo.verify(sig, msg, keys.publicKey)
    expect(valid).toBe(true)
  })
})

describe('KemAlgorithm with real ML-KEM-768', () => {
  it('ml_kem768 satisfies KemAlgorithm interface', async () => {
    const { ml_kem768 } = await import('@noble/post-quantum/ml-kem.js')
    // TypeScript compile-time check: ml_kem768 must satisfy KemAlgorithm
    const algo: KemAlgorithm = ml_kem768

    const keys = algo.keygen()
    expect(keys.publicKey).toBeInstanceOf(Uint8Array)
    expect(keys.secretKey).toBeInstanceOf(Uint8Array)

    const { cipherText, sharedSecret } = algo.encapsulate(keys.publicKey)
    expect(cipherText).toBeInstanceOf(Uint8Array)
    expect(sharedSecret).toBeInstanceOf(Uint8Array)
    expect(sharedSecret.length).toBe(32)

    const decapped = algo.decapsulate(cipherText, keys.secretKey)
    expect(decapped).toBeInstanceOf(Uint8Array)
    expect(decapped).toEqual(sharedSecret)
  })
})
