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

describe('Schnorr (BIP340) wrappers', () => {
  it('getSchnorrPublicKey returns 32-byte x-only key', () => {
    const { secretKey } = generateBtcKeypair()
    const pubKey = getSchnorrPublicKey(secretKey)
    expect(pubKey).toBeInstanceOf(Uint8Array)
    expect(pubKey.length).toBe(32)
  })

  it('getSchnorrPublicKey is deterministic', () => {
    const { secretKey } = generateBtcKeypair()
    const a = getSchnorrPublicKey(secretKey)
    const b = getSchnorrPublicKey(secretKey)
    expect(bytesToHex(a)).toBe(bytesToHex(b))
  })

  it('different secret keys produce different public keys', () => {
    const kp1 = generateBtcKeypair()
    const kp2 = generateBtcKeypair()
    expect(bytesToHex(getSchnorrPublicKey(kp1.secretKey))).not.toBe(
      bytesToHex(getSchnorrPublicKey(kp2.secretKey))
    )
  })

  it('schnorrSign returns 64-byte signature', () => {
    const { secretKey } = generateBtcKeypair()
    const msgHash = doubleSha256(new Uint8Array([1, 2, 3]))
    const sig = schnorrSign(msgHash, secretKey)
    expect(sig).toBeInstanceOf(Uint8Array)
    expect(sig.length).toBe(64)
  })

  it('sign and verify round-trip', () => {
    const { secretKey } = generateBtcKeypair()
    const pubKey = getSchnorrPublicKey(secretKey)
    const msgHash = doubleSha256(new Uint8Array([5, 10, 15]))
    const sig = schnorrSign(msgHash, secretKey)
    expect(verifySchnorrSignature(sig, msgHash, pubKey)).toBe(true)
  })

  it('detects tampered message', () => {
    const { secretKey } = generateBtcKeypair()
    const pubKey = getSchnorrPublicKey(secretKey)
    const msgHash = doubleSha256(new Uint8Array([1, 2, 3]))
    const sig = schnorrSign(msgHash, secretKey)
    const tamperedHash = doubleSha256(new Uint8Array([1, 2, 4]))
    expect(verifySchnorrSignature(sig, tamperedHash, pubKey)).toBe(false)
  })

  it('rejects wrong public key', () => {
    const kp1 = generateBtcKeypair()
    const kp2 = generateBtcKeypair()
    const msgHash = doubleSha256(new Uint8Array([1, 2, 3]))
    const sig = schnorrSign(msgHash, kp1.secretKey)
    expect(verifySchnorrSignature(sig, msgHash, getSchnorrPublicKey(kp2.secretKey))).toBe(false)
  })

  it('rejects truncated signature', () => {
    const { secretKey } = generateBtcKeypair()
    const pubKey = getSchnorrPublicKey(secretKey)
    const msgHash = doubleSha256(new Uint8Array([1, 2, 3]))
    const sig = schnorrSign(msgHash, secretKey)
    const truncated = sig.slice(0, 32) // half-length
    expect(verifySchnorrSignature(truncated, msgHash, pubKey)).toBe(false)
  })
})

describe('Taproot key derivation', () => {
  it('computeTaprootOutputKey returns 32-byte tweaked key', () => {
    const { secretKey } = generateBtcKeypair()
    const internalKey = getSchnorrPublicKey(secretKey)
    const outputKey = computeTaprootOutputKey(internalKey)
    expect(outputKey).toBeInstanceOf(Uint8Array)
    expect(outputKey.length).toBe(32)
  })

  it('computeTaprootOutputKey is deterministic', () => {
    const { secretKey } = generateBtcKeypair()
    const internalKey = getSchnorrPublicKey(secretKey)
    const a = computeTaprootOutputKey(internalKey)
    const b = computeTaprootOutputKey(internalKey)
    expect(bytesToHex(a)).toBe(bytesToHex(b))
  })

  it('different internal keys produce different output keys', () => {
    const kp1 = generateBtcKeypair()
    const kp2 = generateBtcKeypair()
    const out1 = computeTaprootOutputKey(getSchnorrPublicKey(kp1.secretKey))
    const out2 = computeTaprootOutputKey(getSchnorrPublicKey(kp2.secretKey))
    expect(bytesToHex(out1)).not.toBe(bytesToHex(out2))
  })

  it('tweaked output key differs from internal key', () => {
    const { secretKey } = generateBtcKeypair()
    const internalKey = getSchnorrPublicKey(secretKey)
    const outputKey = computeTaprootOutputKey(internalKey)
    // The TapTweak should change the key
    expect(bytesToHex(outputKey)).not.toBe(bytesToHex(internalKey))
  })

  it('deriveP2trAddress returns 64-char lowercase hex', () => {
    const { secretKey } = generateBtcKeypair()
    const internalKey = getSchnorrPublicKey(secretKey)
    const addr = deriveP2trAddress(internalKey)
    expect(typeof addr).toBe('string')
    expect(addr.length).toBe(64)
    expect(/^[0-9a-f]{64}$/.test(addr)).toBe(true)
  })

  it('deriveP2trAddress is consistent with computeTaprootOutputKey', () => {
    const { secretKey } = generateBtcKeypair()
    const internalKey = getSchnorrPublicKey(secretKey)
    expect(deriveP2trAddress(internalKey)).toBe(bytesToHex(computeTaprootOutputKey(internalKey)))
  })
})

describe('buildMultisigScript / parseWitnessScript', () => {
  it('1-of-1 round-trips through parse', () => {
    const { publicKey } = generateBtcKeypair()
    const script = buildMultisigScript(1, [publicKey])
    const parsed = parseWitnessScript(script)
    expect(parsed.type).toBe('multisig')
    if (parsed.type === 'multisig') {
      expect(parsed.m).toBe(1)
      expect(parsed.n).toBe(1)
      expect(parsed.pubkeys.length).toBe(1)
      expect(bytesToHex(parsed.pubkeys[0])).toBe(bytesToHex(publicKey))
    }
  })

  it('2-of-3 round-trips through parse', () => {
    const keys = [generateBtcKeypair(), generateBtcKeypair(), generateBtcKeypair()]
    const pubkeys = keys.map(k => k.publicKey)
    const script = buildMultisigScript(2, pubkeys)
    const parsed = parseWitnessScript(script)
    expect(parsed.type).toBe('multisig')
    if (parsed.type === 'multisig') {
      expect(parsed.m).toBe(2)
      expect(parsed.n).toBe(3)
      for (let i = 0; i < 3; i++) {
        expect(bytesToHex(parsed.pubkeys[i])).toBe(bytesToHex(pubkeys[i]))
      }
    }
  })

  it('rejects m > n', () => {
    const { publicKey } = generateBtcKeypair()
    expect(() => buildMultisigScript(2, [publicKey])).toThrow('Invalid multisig params')
  })

  it('rejects m < 1', () => {
    const { publicKey } = generateBtcKeypair()
    expect(() => buildMultisigScript(0, [publicKey])).toThrow('Invalid multisig params')
  })

  it('rejects more than 16 keys', () => {
    const pubkeys = Array.from({ length: 17 }, () => generateBtcKeypair().publicKey)
    expect(() => buildMultisigScript(1, pubkeys)).toThrow('Invalid multisig params')
  })

  it('rejects non-33-byte pubkeys', () => {
    const short = new Uint8Array(32) // 32 bytes instead of 33
    expect(() => buildMultisigScript(1, [short])).toThrow('Pubkey must be 33 bytes')
  })

  it('parseWitnessScript rejects too-short script', () => {
    expect(() => parseWitnessScript(new Uint8Array([0x51, 0xae]))).toThrow('Script too short')
  })

  it('parseWitnessScript rejects script not starting with OP_1..OP_16', () => {
    const badScript = new Uint8Array([0x00, 0x21, ...new Uint8Array(33), 0x51, 0xae])
    expect(() => parseWitnessScript(badScript)).toThrow('Invalid witness script')
  })

  it('parseWitnessScript handles single-key P2PK script (35-byte format)', () => {
    const { publicKey } = generateBtcKeypair()
    // Build: 0x21 <33-byte-pubkey> 0xac
    const script = new Uint8Array([0x21, ...publicKey, 0xac])
    const parsed = parseWitnessScript(script)
    expect(parsed.type).toBe('single-key')
    if (parsed.type === 'single-key') {
      expect(bytesToHex(parsed.pubkey)).toBe(bytesToHex(publicKey))
    }
  })
})

describe('P2WSH and P2SH multisig address derivation', () => {
  it('deriveP2wshAddress returns 64-char hex (SHA-256 of script)', () => {
    const { publicKey } = generateBtcKeypair()
    const script = buildMultisigScript(1, [publicKey])
    const addr = deriveP2wshAddress(script)
    expect(typeof addr).toBe('string')
    expect(addr.length).toBe(64)
    expect(/^[0-9a-f]{64}$/.test(addr)).toBe(true)
  })

  it('deriveP2wshAddress is deterministic', () => {
    const { publicKey } = generateBtcKeypair()
    const script = buildMultisigScript(1, [publicKey])
    expect(deriveP2wshAddress(script)).toBe(deriveP2wshAddress(script))
  })

  it('deriveP2shMultisigAddress returns 40-char hex (HASH160 of script)', () => {
    const { publicKey } = generateBtcKeypair()
    const script = buildMultisigScript(1, [publicKey])
    const addr = deriveP2shMultisigAddress(script)
    expect(typeof addr).toBe('string')
    expect(addr.length).toBe(40)
    expect(/^[0-9a-f]{40}$/.test(addr)).toBe(true)
  })

  it('different scripts produce different P2WSH addresses', () => {
    const kp1 = generateBtcKeypair()
    const kp2 = generateBtcKeypair()
    const s1 = buildMultisigScript(1, [kp1.publicKey])
    const s2 = buildMultisigScript(1, [kp2.publicKey])
    expect(deriveP2wshAddress(s1)).not.toBe(deriveP2wshAddress(s2))
  })
})

describe('deriveP2shP2wpkhAddress', () => {
  it('returns 40-char hex (HASH160 of redeemScript)', () => {
    const { publicKey } = generateBtcKeypair()
    const addr = deriveP2shP2wpkhAddress(publicKey)
    expect(typeof addr).toBe('string')
    expect(addr.length).toBe(40)
    expect(/^[0-9a-f]{40}$/.test(addr)).toBe(true)
  })

  it('is deterministic', () => {
    const { publicKey } = generateBtcKeypair()
    expect(deriveP2shP2wpkhAddress(publicKey)).toBe(deriveP2shP2wpkhAddress(publicKey))
  })

  it('different pubkeys produce different addresses', () => {
    const kp1 = generateBtcKeypair()
    const kp2 = generateBtcKeypair()
    expect(deriveP2shP2wpkhAddress(kp1.publicKey)).not.toBe(deriveP2shP2wpkhAddress(kp2.publicKey))
  })
})
