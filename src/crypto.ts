/**
 * Cryptographic primitives for qcoin
 * Uses ML-DSA-65 (Dilithium) instead of ECDSA secp256k1
 * Uses SHA-256 (double) for hashing, same as Bitcoin
 */
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { ripemd160 } from '@noble/hashes/legacy.js'
import { bytesToHex, concatBytes } from '@noble/hashes/utils.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'

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

export { bytesToHex, concatBytes }
export { hexToBytes } from '@noble/hashes/utils.js'
