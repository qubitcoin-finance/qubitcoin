/**
 * qbtc - Post-Quantum Cryptography Proof of Concept
 *
 * Demonstrates all NIST FIPS 203/204/205 algorithms:
 *   - ML-KEM (Kyber)     - Key encapsulation
 *   - ML-DSA (Dilithium) - Digital signatures
 *   - SLH-DSA (SPHINCS+) - Hash-based signatures
 *   - Hybrid             - X25519 + ML-KEM
 */
import { runMlKemDemo } from './ml-kem-demo.js'
import { runMlDsaDemo } from './ml-dsa-demo.js'
import { runSlhDsaDemo } from './slh-dsa-demo.js'
import { runHybridDemo } from './hybrid-demo.js'
import { runBenchmark } from './benchmark.js'

console.log('╔══════════════════════════════════════════════════════════╗')
console.log('║   qbtc: Post-Quantum Cryptography Proof of Concept   ║')
console.log('║   NIST FIPS 203 / 204 / 205                            ║')
console.log('╚══════════════════════════════════════════════════════════╝')

runMlKemDemo()
runMlDsaDemo()
runSlhDsaDemo()
runHybridDemo()
runBenchmark()
