/**
 * ML-DSA (FIPS 204) - Module-Lattice-Based Digital Signature Algorithm
 *
 * Replaces: RSA signatures, ECDSA, Ed25519
 * Based on: CRYSTALS-Dilithium
 * Security: Lattice-based (Module-LWE + Module-SIS)
 *
 * Flow: Signer generates keypair → signs message → verifier checks signature
 *       with public key
 */
import { ml_dsa44, ml_dsa65, ml_dsa87 } from '@noble/post-quantum/ml-dsa.js'
import { banner, truncHex, sizeLabel, timeIt } from './utils.js'

const variants = [
  { name: 'ML-DSA-44', algo: ml_dsa44, security: '~128-bit' },
  { name: 'ML-DSA-65', algo: ml_dsa65, security: '~192-bit' },
  { name: 'ML-DSA-87', algo: ml_dsa87, security: '~256-bit' },
] as const

const testMessages = [
  'Post-quantum signatures protect against Shor algorithm attacks.',
  '', // empty message edge case
  'A'.repeat(10_000), // large message
]

export function runMlDsaDemo() {
  banner('ML-DSA (FIPS 204) - Digital Signatures')

  for (const { name, algo, security } of variants) {
    console.log(`--- ${name} (${security}) ---`)

    // Generate signing keypair
    const { result: keys, ms: keygenMs } = timeIt(() => algo.keygen())
    console.log(`  Keygen:      ${keygenMs.toFixed(2)} ms`)
    console.log(`  Public key:  ${sizeLabel(keys.publicKey)}`)
    console.log(`  Secret key:  ${sizeLabel(keys.secretKey)}`)

    for (const msg of testMessages) {
      const label = msg.length === 0 ? '(empty)' : msg.length > 60 ? `(${msg.length} chars)` : msg
      const msgBytes = new TextEncoder().encode(msg)

      // Sign
      const { result: sig, ms: signMs } = timeIt(() => algo.sign(msgBytes, keys.secretKey))
      console.log(`  Sign [${label}]: ${signMs.toFixed(2)} ms, sig=${sizeLabel(sig)}`)

      // Verify (valid)
      const { result: valid, ms: verifyMs } = timeIt(() =>
        algo.verify(sig, msgBytes, keys.publicKey)
      )
      console.log(`  Verify:      ${verifyMs.toFixed(2)} ms → ${valid ? 'VALID' : 'INVALID'}`)

      // Verify (tampered message)
      const tampered = new TextEncoder().encode(msg + 'x')
      const { result: invalid } = timeIt(() => algo.verify(sig, tampered, keys.publicKey))
      console.log(`  Tampered:    → ${invalid ? 'VALID (BAD!)' : 'REJECTED (correct)'}`)
    }

    console.log()
  }
}

// Run directly
runMlDsaDemo()
