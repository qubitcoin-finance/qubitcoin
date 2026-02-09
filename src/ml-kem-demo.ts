/**
 * ML-KEM (FIPS 203) - Module-Lattice-Based Key Encapsulation
 *
 * Replaces: RSA key exchange, ECDH
 * Based on: CRYSTALS-Kyber
 * Security: Lattice-based (Learning With Errors problem)
 *
 * Flow: Alice generates keypair → Bob encapsulates shared secret with Alice's
 *       public key → Alice decapsulates to derive same shared secret
 */
import { ml_kem512, ml_kem768, ml_kem1024 } from '@noble/post-quantum/ml-kem.js'
import { banner, truncHex, sizeLabel, timeIt } from './utils.js'

const variants = [
  { name: 'ML-KEM-512', algo: ml_kem512, security: 'AES-128 equivalent' },
  { name: 'ML-KEM-768', algo: ml_kem768, security: 'AES-192 equivalent' },
  { name: 'ML-KEM-1024', algo: ml_kem1024, security: 'AES-256 equivalent' },
] as const

export function runMlKemDemo() {
  banner('ML-KEM (FIPS 203) - Key Encapsulation')

  for (const { name, algo, security } of variants) {
    console.log(`--- ${name} (${security}) ---`)

    // Alice generates a keypair
    const { result: keys, ms: keygenMs } = timeIt(() => algo.keygen())
    console.log(`  Keygen:       ${keygenMs.toFixed(2)} ms`)
    console.log(`  Public key:   ${sizeLabel(keys.publicKey)}  ${truncHex(keys.publicKey)}`)
    console.log(`  Secret key:   ${sizeLabel(keys.secretKey)}  ${truncHex(keys.secretKey)}`)

    // Bob encapsulates a shared secret using Alice's public key
    const { result: encap, ms: encapMs } = timeIt(() => algo.encapsulate(keys.publicKey))
    console.log(`  Encapsulate:  ${encapMs.toFixed(2)} ms`)
    console.log(`  Ciphertext:   ${sizeLabel(encap.cipherText)}`)
    console.log(`  Shared (Bob): ${truncHex(encap.sharedSecret)}`)

    // Alice decapsulates to derive the same shared secret
    const { result: decap, ms: decapMs } = timeIt(() =>
      algo.decapsulate(encap.cipherText, keys.secretKey)
    )
    console.log(`  Decapsulate:  ${decapMs.toFixed(2)} ms`)
    console.log(`  Shared (Ali): ${truncHex(decap)}`)

    // Verify both parties derived the same secret
    const match =
      encap.sharedSecret.length === decap.length &&
      encap.sharedSecret.every((b, i) => b === decap[i])
    console.log(`  Match:        ${match ? 'YES' : 'FAILED'}\n`)
  }
}

// Run directly
runMlKemDemo()
