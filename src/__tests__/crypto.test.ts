import { describe, it, expect } from 'vitest'
import {
  doubleSha256,
  doubleSha256Hex,
  deriveAddress,
  generateWallet,
  signData,
  verifySignature,
  uint32LE,
  uint64LE,
  hash160,
  generateBtcKeypair,
  ecdsaSign,
  verifyEcdsaSignature,
  bytesToHex,
} from '../crypto.js'
import { walletA, walletB } from './fixtures.js'

describe('doubleSha256', () => {
  it('returns 32 bytes', () => {
    const result = doubleSha256(new Uint8Array([1, 2, 3]))
    expect(result).toBeInstanceOf(Uint8Array)
    expect(result.length).toBe(32)
  })

  it('is deterministic', () => {
    const data = new Uint8Array([1, 2, 3])
    const a = doubleSha256(data)
    const b = doubleSha256(data)
    expect(bytesToHex(a)).toBe(bytesToHex(b))
  })

  it('different inputs produce different outputs', () => {
    const a = doubleSha256(new Uint8Array([1]))
    const b = doubleSha256(new Uint8Array([2]))
    expect(bytesToHex(a)).not.toBe(bytesToHex(b))
  })

  it('hex variant returns 64-char string', () => {
    const hex = doubleSha256Hex(new Uint8Array([1, 2, 3]))
    expect(hex.length).toBe(64)
    expect(/^[0-9a-f]+$/.test(hex)).toBe(true)
  })
})

describe('generateWallet', () => {
  it('creates wallet with correct key sizes', () => {
    expect(walletA.publicKey.length).toBe(1952)
    expect(walletA.secretKey.length).toBe(4032)
    expect(walletA.address.length).toBe(64)
  })

  it('generates unique addresses', () => {
    expect(walletA.address).not.toBe(walletB.address)
  })

  it('address matches deriveAddress(publicKey)', () => {
    expect(walletA.address).toBe(deriveAddress(walletA.publicKey))
  })
})

describe('signData / verifySignature', () => {
  it('round-trip sign and verify', () => {
    const data = new Uint8Array([1, 2, 3, 4, 5])
    const sig = signData(data, walletA.secretKey)
    expect(verifySignature(sig, data, walletA.publicKey)).toBe(true)
  })

  it('detects tampered data', () => {
    const data = new Uint8Array([1, 2, 3])
    const sig = signData(data, walletA.secretKey)
    const tampered = new Uint8Array([1, 2, 4])
    expect(verifySignature(sig, tampered, walletA.publicKey)).toBe(false)
  })

  it('rejects wrong public key', () => {
    const data = new Uint8Array([1, 2, 3])
    const sig = signData(data, walletA.secretKey)
    expect(verifySignature(sig, data, walletB.publicKey)).toBe(false)
  })
})

describe('uint32LE', () => {
  it('encodes 0', () => {
    const buf = uint32LE(0)
    expect(buf.length).toBe(4)
    expect(Array.from(buf)).toEqual([0, 0, 0, 0])
  })

  it('encodes 1 as little-endian', () => {
    expect(Array.from(uint32LE(1))).toEqual([1, 0, 0, 0])
  })

  it('encodes 0xFFFFFFFF', () => {
    expect(Array.from(uint32LE(0xffffffff))).toEqual([255, 255, 255, 255])
  })

  it('encodes 256', () => {
    expect(Array.from(uint32LE(256))).toEqual([0, 1, 0, 0])
  })
})

describe('uint64LE', () => {
  it('encodes 0', () => {
    const buf = uint64LE(0)
    expect(buf.length).toBe(8)
    expect(Array.from(buf)).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  })

  it('encodes 1', () => {
    expect(Array.from(uint64LE(1))).toEqual([1, 0, 0, 0, 0, 0, 0, 0])
  })

  it('encodes values above 32-bit', () => {
    const buf = uint64LE(0x100000000)
    expect(Array.from(buf)).toEqual([0, 0, 0, 0, 1, 0, 0, 0])
  })
})

describe('ECDSA wrappers', () => {
  it('generates keypair with correct sizes', () => {
    const kp = generateBtcKeypair()
    expect(kp.secretKey.length).toBe(32)
    expect(kp.publicKey.length).toBe(33) // compressed
  })

  it('sign and verify round-trip', () => {
    const kp = generateBtcKeypair()
    const msgHash = doubleSha256(new Uint8Array([1, 2, 3]))
    const sig = ecdsaSign(msgHash, kp.secretKey)
    expect(verifyEcdsaSignature(sig, msgHash, kp.publicKey)).toBe(true)
  })

  it('rejects wrong message', () => {
    const kp = generateBtcKeypair()
    const msgHash = doubleSha256(new Uint8Array([1, 2, 3]))
    const sig = ecdsaSign(msgHash, kp.secretKey)
    const wrongHash = doubleSha256(new Uint8Array([4, 5, 6]))
    expect(verifyEcdsaSignature(sig, wrongHash, kp.publicKey)).toBe(false)
  })

  it('rejects wrong key', () => {
    const kp1 = generateBtcKeypair()
    const kp2 = generateBtcKeypair()
    const msgHash = doubleSha256(new Uint8Array([1, 2, 3]))
    const sig = ecdsaSign(msgHash, kp1.secretKey)
    expect(verifyEcdsaSignature(sig, msgHash, kp2.publicKey)).toBe(false)
  })
})

describe('hash160', () => {
  it('returns 20 bytes (RIPEMD-160)', () => {
    const result = hash160(new Uint8Array([1, 2, 3]))
    expect(result.length).toBe(20)
  })

  it('is deterministic', () => {
    const data = new Uint8Array([1, 2, 3])
    expect(bytesToHex(hash160(data))).toBe(bytesToHex(hash160(data)))
  })
})
