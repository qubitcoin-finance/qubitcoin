/**
 * Cryptographic primitives for qbtc
 * Uses ML-DSA-65 (Dilithium) instead of ECDSA secp256k1
 * Uses SHA-256 (double) for hashing, same as Bitcoin
 */
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { ripemd160 } from '@noble/hashes/legacy.js'
import { bytesToHex, concatBytes } from '@noble/hashes/utils.js'
import { secp256k1, schnorr } from '@noble/curves/secp256k1.js'

export interface Wallet {
  publicKey: Uint8Array  // 1,952 bytes (ML-DSA-65)
  secretKey: Uint8Array  // 4,032 bytes (ML-DSA-65)
  address: string        // 64-char hex (SHA-256 of publicKey)
}

/** SHA-256(SHA-256(data)) - Bitcoin's standard double-hash */
export function doubleSha256(data: Uint8Array): Uint8Array {
  return sha256(sha256(data))
}

/** doubleSha256 returning hex string */
export function doubleSha256Hex(data: Uint8Array): string {
  return bytesToHex(doubleSha256(data))
}

/** Derive address from ML-DSA-65 public key: SHA-256(pubkey) as hex */
export function deriveAddress(publicKey: Uint8Array): string {
  return bytesToHex(sha256(publicKey))
}

/** Generate a new wallet with ML-DSA-65 keypair */
export function generateWallet(): Wallet {
  const keys = ml_dsa65.keygen()
  return {
    publicKey: keys.publicKey,
    secretKey: keys.secretKey,
    address: deriveAddress(keys.publicKey),
  }
}

/** Sign data with ML-DSA-65 */
export function signData(data: Uint8Array, secretKey: Uint8Array): Uint8Array {
  return ml_dsa65.sign(data, secretKey)
}

/** Verify ML-DSA-65 signature */
export function verifySignature(
  signature: Uint8Array,
  data: Uint8Array,
  publicKey: Uint8Array
): boolean {
  return ml_dsa65.verify(signature, data, publicKey)
}

/** Encode a number as 4-byte little-endian Uint8Array */
export function uint32LE(n: number): Uint8Array {
  const buf = new Uint8Array(4)
  const view = new DataView(buf.buffer)
  view.setUint32(0, n >>> 0, true)
  return buf
}

/** Encode a number as 8-byte little-endian Uint8Array (up to Number.MAX_SAFE_INTEGER) */
export function uint64LE(n: number): Uint8Array {
  const buf = new Uint8Array(8)
  const view = new DataView(buf.buffer)
  view.setUint32(0, n >>> 0, true)
  view.setUint32(4, Math.floor(n / 0x100000000) >>> 0, true)
  return buf
}

/** RIPEMD-160(SHA-256(data)) - Bitcoin's address hash */
export function hash160(data: Uint8Array): Uint8Array {
  return ripemd160(sha256(data))
}

/** Derive P2SH-P2WPKH address: HASH160(0x0014 || HASH160(pubkey)) */
export function deriveP2shP2wpkhAddress(compressedPubKey: Uint8Array): string {
  const keyhash = hash160(compressedPubKey) // 20 bytes
  const redeemScript = concatBytes(new Uint8Array([0x00, 0x14]), keyhash) // 22 bytes
  return bytesToHex(hash160(redeemScript)) // 20 bytes → 40 hex
}

/** Generate a Bitcoin-style secp256k1 keypair */
export function generateBtcKeypair(): { secretKey: Uint8Array; publicKey: Uint8Array } {
  const secretKey = secp256k1.utils.randomSecretKey()
  const publicKey = secp256k1.getPublicKey(secretKey, true) // compressed 33 bytes
  return { secretKey, publicKey }
}

/** Sign a message hash with ECDSA secp256k1 */
export function ecdsaSign(msgHash: Uint8Array, secretKey: Uint8Array): Uint8Array {
  return secp256k1.sign(msgHash, secretKey)
}

/** Verify an ECDSA secp256k1 signature */
export function verifyEcdsaSignature(
  signature: Uint8Array,
  msgHash: Uint8Array,
  publicKey: Uint8Array
): boolean {
  return secp256k1.verify(signature, msgHash, publicKey)
}

/** Sign a message hash with Schnorr (BIP340) */
export function schnorrSign(msgHash: Uint8Array, secretKey: Uint8Array): Uint8Array {
  return schnorr.sign(msgHash, secretKey)
}

/** Verify a Schnorr (BIP340) signature */
export function verifySchnorrSignature(
  signature: Uint8Array,
  msgHash: Uint8Array,
  publicKey: Uint8Array
): boolean {
  return schnorr.verify(signature, msgHash, publicKey)
}

/** Get 32-byte x-only public key for Schnorr/Taproot */
export function getSchnorrPublicKey(secretKey: Uint8Array): Uint8Array {
  return schnorr.getPublicKey(secretKey)
}

/**
 * Compute Taproot output key Q from internal pubkey P (BIP341, BIP86 key-path).
 * Q = P + taggedHash("TapTweak", P) * G
 * Returns 32-byte x-only tweaked key.
 */
export function computeTaprootOutputKey(internalPubkey: Uint8Array): Uint8Array {
  const tweak = schnorr.utils.taggedHash('TapTweak', internalPubkey)
  const xBig = BigInt('0x' + bytesToHex(internalPubkey))
  const P = schnorr.utils.lift_x(xBig)
  const tBig = BigInt('0x' + bytesToHex(tweak))
  const tG = schnorr.Point.BASE.multiply(tBig)
  const Q = P.add(tG)
  return schnorr.utils.pointToBytes(Q)
}

/** Derive P2TR address: hex of tweaked output key Q */
export function deriveP2trAddress(internalPubkey: Uint8Array): string {
  return bytesToHex(computeTaprootOutputKey(internalPubkey))
}

/**
 * Build a standard m-of-n multisig witness script.
 * Format: OP_m [PUSH33 <compressed-pubkey>]×n OP_n OP_CHECKMULTISIG
 */
export function buildMultisigScript(m: number, pubkeys: Uint8Array[]): Uint8Array {
  const n = pubkeys.length
  if (m < 1 || m > n || n > 16) throw new Error(`Invalid multisig params: ${m}-of-${n}`)
  for (const pk of pubkeys) {
    if (pk.length !== 33) throw new Error(`Pubkey must be 33 bytes, got ${pk.length}`)
  }
  // OP_m (0x51..0x60 for 1..16), then each pubkey with PUSH33 prefix, OP_n, OP_CHECKMULTISIG
  const parts: Uint8Array[] = [new Uint8Array([0x50 + m])]
  for (const pk of pubkeys) {
    parts.push(new Uint8Array([0x21])) // PUSH33
    parts.push(pk)
  }
  parts.push(new Uint8Array([0x50 + n, 0xae])) // OP_n + OP_CHECKMULTISIG
  return concatBytes(...parts)
}

/**
 * Parse a witness script into its constituent parts.
 * Supports multisig: OP_m [PUSH33 <pk>]×n OP_n OP_CHECKMULTISIG
 * Supports single-key: PUSH33 <pk> OP_CHECKSIG (35 bytes)
 */
export function parseWitnessScript(
  script: Uint8Array
): { type: 'multisig'; m: number; n: number; pubkeys: Uint8Array[] } | { type: 'single-key'; pubkey: Uint8Array } {
  // Single-key: 0x21 <33-byte-pubkey> 0xac (total 35 bytes)
  if (script.length === 35 && script[0] === 0x21 && script[34] === 0xac) {
    return { type: 'single-key', pubkey: script.slice(1, 34) }
  }

  // Multisig: OP_m [0x21 <33-byte-pk>]×n OP_n 0xae
  if (script.length < 3) throw new Error('Script too short')
  const opM = script[0]
  if (opM < 0x51 || opM > 0x60) throw new Error('Invalid witness script: expected OP_1..OP_16 at start')
  const m = opM - 0x50

  const pubkeys: Uint8Array[] = []
  let pos = 1
  while (pos < script.length - 2) {
    if (script[pos] !== 0x21) break
    pos++
    if (pos + 33 > script.length) throw new Error('Truncated pubkey in witness script')
    pubkeys.push(script.slice(pos, pos + 33))
    pos += 33
  }

  if (pubkeys.length === 0) throw new Error('No pubkeys found in witness script')
  if (pos + 2 !== script.length) throw new Error('Unexpected trailing data in witness script')
  const opN = script[pos]
  if (opN < 0x51 || opN > 0x60) throw new Error('Invalid witness script: expected OP_n')
  const n = opN - 0x50
  if (script[pos + 1] !== 0xae) throw new Error('Invalid witness script: expected OP_CHECKMULTISIG')
  if (pubkeys.length !== n) throw new Error(`Pubkey count mismatch: found ${pubkeys.length}, expected ${n}`)
  if (m > n) throw new Error(`Invalid m-of-n: ${m} > ${n}`)

  return { type: 'multisig', m, n, pubkeys }
}

/** Derive P2WSH address: hex of SHA256(witnessScript) */
export function deriveP2wshAddress(witnessScript: Uint8Array): string {
  return bytesToHex(sha256(witnessScript))
}

/** Derive P2SH multisig address: hex of HASH160(redeemScript) */
export function deriveP2shMultisigAddress(redeemScript: Uint8Array): string {
  return bytesToHex(hash160(redeemScript))
}

export { bytesToHex, concatBytes }
export { hexToBytes } from '@noble/hashes/utils.js'
