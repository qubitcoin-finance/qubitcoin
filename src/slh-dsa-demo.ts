/**
 * SLH-DSA (FIPS 205) - Stateless Hash-Based Digital Signature Algorithm
 *
 * Replaces: RSA/ECDSA as ultra-conservative alternative to ML-DSA
 * Based on: SPHINCS+
 * Security: Hash-based (no lattice assumptions - only relies on hash function security)
 *
 * Trade-offs vs ML-DSA:
 *   - Much larger signatures (17-50 KB vs 2-4 KB)
 *   - Slower signing
 *   - More conservative security assumptions (hash functions are well-understood)
 *   - Good choice for high-value, infrequent signing (root CAs, firmware)
 *
 * Variants: f = fast (larger sig), s = small (smaller sig, slower)
 */
import {
  slh_dsa_sha2_128f,
  slh_dsa_sha2_128s,
  slh_dsa_sha2_256f,
} from '@noble/post-quantum/slh-dsa.js'
import { banner, sizeLabel, timeIt } from './utils.js'

const variants = [
  { name: 'SLH-DSA-SHA2-128f', algo: slh_dsa_sha2_128f, note: 'fast, ~128-bit' },
  { name: 'SLH-DSA-SHA2-128s', algo: slh_dsa_sha2_128s, note: 'small sig, ~128-bit' },
  { name: 'SLH-DSA-SHA2-256f', algo: slh_dsa_sha2_256f, note: 'fast, ~256-bit' },
] as const

export function runSlhDsaDemo() {
  banner('SLH-DSA (FIPS 205) - Hash-Based Signatures')

  const msg = new TextEncoder().encode('Hash-based sigs: no lattice assumptions needed.')

  for (const { name, algo, note } of variants) {
    console.log(`--- ${name} (${note}) ---`)

    const { result: keys, ms: keygenMs } = timeIt(() => algo.keygen())
    console.log(`  Keygen:     ${keygenMs.toFixed(2)} ms`)
    console.log(`  Public key: ${sizeLabel(keys.publicKey)}`)
    console.log(`  Secret key: ${sizeLabel(keys.secretKey)}`)

    const { result: sig, ms: signMs } = timeIt(() => algo.sign(msg, keys.secretKey))
    console.log(`  Sign:       ${signMs.toFixed(2)} ms`)
    console.log(`  Signature:  ${sizeLabel(sig)}`)

    const { result: valid, ms: verifyMs } = timeIt(() => algo.verify(sig, msg, keys.publicKey))
    console.log(`  Verify:     ${verifyMs.toFixed(2)} ms → ${valid ? 'VALID' : 'INVALID'}`)

    // Tampered
    const tampered = new TextEncoder().encode('Hash-based sigs: tampered message.')
    const { result: invalid } = timeIt(() => algo.verify(sig, tampered, keys.publicKey))
    console.log(`  Tampered:   → ${invalid ? 'VALID (BAD!)' : 'REJECTED (correct)'}\n`)
  }
}

// Run directly
runSlhDsaDemo()
