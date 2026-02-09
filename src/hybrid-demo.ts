/**
 * Hybrid Key Exchange - X25519 + ML-KEM
 *
 * Why hybrid?
 *   - If ML-KEM has an undiscovered weakness, X25519 still protects you
 *   - If quantum computers arrive, ML-KEM still protects you
 *   - Defense-in-depth: attacker must break BOTH to decrypt
 *
 * This is what Chrome/Cloudflare already deploy in TLS 1.3
 */
import { ml_kem768_x25519 } from '@noble/post-quantum/hybrid.js'
import { banner, truncHex, sizeLabel, timeIt } from './utils.js'

export function runHybridDemo() {
  banner('Hybrid Key Exchange - X25519 + ML-KEM-768')

  console.log('This combines classical ECDH (X25519) with post-quantum ML-KEM.')
  console.log('Already deployed in Chrome and Cloudflare TLS 1.3.\n')

  // Alice generates a keypair
  const { result: keys, ms: keygenMs } = timeIt(() => ml_kem768_x25519.keygen())
  console.log(`Keygen:       ${keygenMs.toFixed(2)} ms`)
  console.log(`Public key:   ${sizeLabel(keys.publicKey)}`)
  console.log(`Secret key:   ${sizeLabel(keys.secretKey)}`)

  // Bob encapsulates
  const { result: encap, ms: encapMs } = timeIt(() =>
    ml_kem768_x25519.encapsulate(keys.publicKey)
  )
  console.log(`Encapsulate:  ${encapMs.toFixed(2)} ms`)
  console.log(`Ciphertext:   ${sizeLabel(encap.cipherText)}`)
  console.log(`Shared (Bob): ${truncHex(encap.sharedSecret)}`)

  // Alice decapsulates
  const { result: decap, ms: decapMs } = timeIt(() =>
    ml_kem768_x25519.decapsulate(encap.cipherText, keys.secretKey)
  )
  console.log(`Decapsulate:  ${decapMs.toFixed(2)} ms`)
  console.log(`Shared (Ali): ${truncHex(decap)}`)

  const match =
    encap.sharedSecret.length === decap.length &&
    encap.sharedSecret.every((b, i) => b === decap[i])
  console.log(`Match:        ${match ? 'YES' : 'FAILED'}`)

  // Size comparison
  console.log('\n--- Size Comparison vs Classical ---')
  console.log(`  X25519 public key:          32 B`)
  console.log(`  X25519 + ML-KEM-768 pubkey: ${sizeLabel(keys.publicKey)}`)
  console.log(`  Overhead:                   ${keys.publicKey.length - 32} B`)
}

// Run directly
runHybridDemo()
