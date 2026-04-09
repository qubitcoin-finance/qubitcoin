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
  schnorrSign,
  verifySchnorrSignature,
  getSchnorrPublicKey,
  computeTaprootOutputKey,
  deriveP2trAddress,
  buildMultisigScript,
  parseWitnessScript,
  deriveP2wshAddress,
  deriveP2shMultisigAddress,
  deriveP2shP2wpkhAddress,
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

describe('Schnorr wrappers', () => {
  it('getSchnorrPublicKey returns 32-byte x-only pubkey', () => {
    const kp = generateBtcKeypair()
    const xOnlyPubkey = getSchnorrPublicKey(kp.secretKey)
    expect(xOnlyPubkey).toBeInstanceOf(Uint8Array)
    expect(xOnlyPubkey.length).toBe(32)
  })

  it('schnorrSign returns 64-byte signature', () => {
    const kp = generateBtcKeypair()
    const msgHash = doubleSha256(new Uint8Array([1, 2, 3]))
    const sig = schnorrSign(msgHash, kp.secretKey)
    expect(sig).toBeInstanceOf(Uint8Array)
    expect(sig.length).toBe(64)
  })

  it('sign and verify round-trip', () => {
    const kp = generateBtcKeypair()
    const pubkey = getSchnorrPublicKey(kp.secretKey)
    const msgHash = doubleSha256(new Uint8Array([10, 20, 30]))
    const sig = schnorrSign(msgHash, kp.secretKey)
    expect(verifySchnorrSignature(sig, msgHash, pubkey)).toBe(true)
  })

  it('rejects tampered message', () => {
    const kp = generateBtcKeypair()
    const pubkey = getSchnorrPublicKey(kp.secretKey)
    const msgHash = doubleSha256(new Uint8Array([1, 2, 3]))
    const sig = schnorrSign(msgHash, kp.secretKey)
    const tampered = doubleSha256(new Uint8Array([4, 5, 6]))
    expect(verifySchnorrSignature(sig, tampered, pubkey)).toBe(false)
  })

  it('rejects wrong public key', () => {
    const kp1 = generateBtcKeypair()
    const kp2 = generateBtcKeypair()
    const pubkey2 = getSchnorrPublicKey(kp2.secretKey)
    const msgHash = doubleSha256(new Uint8Array([1, 2, 3]))
    const sig = schnorrSign(msgHash, kp1.secretKey)
    expect(verifySchnorrSignature(sig, msgHash, pubkey2)).toBe(false)
  })
})

describe('Taproot key derivation', () => {
  it('computeTaprootOutputKey returns 32 bytes', () => {
    const kp = generateBtcKeypair()
    const internalPubkey = getSchnorrPublicKey(kp.secretKey)
    const outputKey = computeTaprootOutputKey(internalPubkey)
    expect(outputKey).toBeInstanceOf(Uint8Array)
    expect(outputKey.length).toBe(32)
  })

  it('computeTaprootOutputKey is deterministic', () => {
    const kp = generateBtcKeypair()
    const internalPubkey = getSchnorrPublicKey(kp.secretKey)
    const a = computeTaprootOutputKey(internalPubkey)
    const b = computeTaprootOutputKey(internalPubkey)
    expect(bytesToHex(a)).toBe(bytesToHex(b))
  })

  it('different internal keys produce different output keys', () => {
    const kp1 = generateBtcKeypair()
    const kp2 = generateBtcKeypair()
    const pk1 = getSchnorrPublicKey(kp1.secretKey)
    const pk2 = getSchnorrPublicKey(kp2.secretKey)
    const out1 = computeTaprootOutputKey(pk1)
    const out2 = computeTaprootOutputKey(pk2)
    expect(bytesToHex(out1)).not.toBe(bytesToHex(out2))
  })

  it('deriveP2trAddress returns 64-char hex', () => {
    const kp = generateBtcKeypair()
    const internalPubkey = getSchnorrPublicKey(kp.secretKey)
    const addr = deriveP2trAddress(internalPubkey)
    expect(addr.length).toBe(64)
    expect(/^[0-9a-f]+$/.test(addr)).toBe(true)
  })
})

describe('buildMultisigScript', () => {
  it('builds a 1-of-1 script', () => {
    const kp = generateBtcKeypair()
    const script = buildMultisigScript(1, [kp.publicKey])
    expect(script).toBeInstanceOf(Uint8Array)
    // OP_1 + PUSH33 + 33 bytes + OP_1 + OP_CHECKMULTISIG = 37 bytes
    expect(script.length).toBe(1 + 1 + 33 + 1 + 1)
    expect(script[0]).toBe(0x51) // OP_1
    expect(script[script.length - 1]).toBe(0xae) // OP_CHECKMULTISIG
  })

  it('builds a 2-of-3 script', () => {
    const kps = [generateBtcKeypair(), generateBtcKeypair(), generateBtcKeypair()]
    const script = buildMultisigScript(2, kps.map(k => k.publicKey))
    expect(script[0]).toBe(0x52) // OP_2
    // OP_2 + 3×(PUSH33 + 33 bytes) + OP_3 + OP_CHECKMULTISIG
    expect(script.length).toBe(1 + 3 * (1 + 33) + 1 + 1)
    expect(script[script.length - 2]).toBe(0x53) // OP_3
  })

  it('throws when m < 1', () => {
    const kp = generateBtcKeypair()
    expect(() => buildMultisigScript(0, [kp.publicKey])).toThrow('Invalid multisig params')
  })

  it('throws when m > n', () => {
    const kp = generateBtcKeypair()
    expect(() => buildMultisigScript(2, [kp.publicKey])).toThrow('Invalid multisig params')
  })

  it('throws when n > 16', () => {
    const keys = Array.from({ length: 17 }, () => generateBtcKeypair().publicKey)
    expect(() => buildMultisigScript(1, keys)).toThrow('Invalid multisig params')
  })

  it('throws when pubkey is not 33 bytes', () => {
    expect(() => buildMultisigScript(1, [new Uint8Array(32)])).toThrow('Pubkey must be 33 bytes')
  })
})

describe('parseWitnessScript', () => {
  it('round-trips a 2-of-3 multisig script', () => {
    const kps = [generateBtcKeypair(), generateBtcKeypair(), generateBtcKeypair()]
    const pubkeys = kps.map(k => k.publicKey)
    const script = buildMultisigScript(2, pubkeys)
    const parsed = parseWitnessScript(script)
    expect(parsed.type).toBe('multisig')
    if (parsed.type === 'multisig') {
      expect(parsed.m).toBe(2)
      expect(parsed.n).toBe(3)
      expect(parsed.pubkeys.length).toBe(3)
      expect(bytesToHex(parsed.pubkeys[0])).toBe(bytesToHex(pubkeys[0]))
    }
  })

  it('round-trips a 1-of-2 multisig script', () => {
    const kps = [generateBtcKeypair(), generateBtcKeypair()]
    const script = buildMultisigScript(1, kps.map(k => k.publicKey))
    const parsed = parseWitnessScript(script)
    expect(parsed.type).toBe('multisig')
    if (parsed.type === 'multisig') {
      expect(parsed.m).toBe(1)
      expect(parsed.n).toBe(2)
    }
  })

  it('parses a single-key script (PUSH33 <pk> OP_CHECKSIG)', () => {
    const kp = generateBtcKeypair()
    // Build single-key script: 0x21 <33-byte-pk> 0xac
    const script = new Uint8Array(35)
    script[0] = 0x21
    script.set(kp.publicKey, 1)
    script[34] = 0xac
    const parsed = parseWitnessScript(script)
    expect(parsed.type).toBe('single-key')
    if (parsed.type === 'single-key') {
      expect(bytesToHex(parsed.pubkey)).toBe(bytesToHex(kp.publicKey))
    }
  })

  it('throws on script too short', () => {
    expect(() => parseWitnessScript(new Uint8Array(2))).toThrow('Script too short')
  })

  it('throws on invalid OP_m at start', () => {
    // 3 bytes, but starts with 0x50 (OP_0, not OP_1..OP_16)
    expect(() => parseWitnessScript(new Uint8Array([0x50, 0x00, 0xae]))).toThrow('Invalid witness script')
  })

  it('throws on no pubkeys found', () => {
    // OP_1 followed immediately by OP_CHECKMULTISIG with no pubkeys
    // script: [0x51, <non-0x21 byte>, 0xae] — will parse 0 pubkeys
    expect(() => parseWitnessScript(new Uint8Array([0x51, 0x00, 0xae]))).toThrow('No pubkeys found')
  })
})

describe('P2WSH and P2SH address derivation', () => {
  it('deriveP2wshAddress returns 64-char hex (SHA256 of script)', () => {
    const kps = [generateBtcKeypair(), generateBtcKeypair()]
    const script = buildMultisigScript(1, kps.map(k => k.publicKey))
    const addr = deriveP2wshAddress(script)
    expect(addr.length).toBe(64)
    expect(/^[0-9a-f]+$/.test(addr)).toBe(true)
  })

  it('deriveP2wshAddress is deterministic', () => {
    const script = new Uint8Array([0x51, 0x21, ...generateBtcKeypair().publicKey, 0x51, 0xae])
    const a = deriveP2wshAddress(script)
    const b = deriveP2wshAddress(script)
    expect(a).toBe(b)
  })

  it('deriveP2shMultisigAddress returns 40-char hex (HASH160 of script)', () => {
    const kps = [generateBtcKeypair(), generateBtcKeypair()]
    const script = buildMultisigScript(1, kps.map(k => k.publicKey))
    const addr = deriveP2shMultisigAddress(script)
    expect(addr.length).toBe(40)
    expect(/^[0-9a-f]+$/.test(addr)).toBe(true)
  })

  it('deriveP2shP2wpkhAddress returns 40-char hex (HASH160 of redeemScript)', () => {
    const kp = generateBtcKeypair()
    const addr = deriveP2shP2wpkhAddress(kp.publicKey)
    expect(addr.length).toBe(40)
    expect(/^[0-9a-f]+$/.test(addr)).toBe(true)
  })

  it('deriveP2shP2wpkhAddress is deterministic', () => {
    const kp = generateBtcKeypair()
    expect(deriveP2shP2wpkhAddress(kp.publicKey)).toBe(deriveP2shP2wpkhAddress(kp.publicKey))
  })

  it('different keys produce different P2SH-P2WPKH addresses', () => {
    const kp1 = generateBtcKeypair()
    const kp2 = generateBtcKeypair()
    expect(deriveP2shP2wpkhAddress(kp1.publicKey)).not.toBe(deriveP2shP2wpkhAddress(kp2.publicKey))
  })
})
