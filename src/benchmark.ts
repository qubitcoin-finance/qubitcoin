/**
 * Benchmark comparison of all PQC algorithms
 * Measures keygen, sign/encapsulate, verify/decapsulate across security levels
 */
import { ml_kem512, ml_kem768, ml_kem1024 } from '@noble/post-quantum/ml-kem.js'
import { ml_dsa44, ml_dsa65, ml_dsa87 } from '@noble/post-quantum/ml-dsa.js'
import { slh_dsa_sha2_128f, slh_dsa_sha2_128s } from '@noble/post-quantum/slh-dsa.js'
import { ml_kem768_x25519 } from '@noble/post-quantum/hybrid.js'
import { banner } from './utils.js'

interface BenchResult {
  name: string
  keygenMs: number
  op1Ms: number
  op1Label: string
  op2Ms: number
  op2Label: string
  pubKeySize: number
  secKeySize: number
  outputSize: number
  outputLabel: string
}

function benchKem(
  name: string,
  algo: { keygen: () => any; encapsulate: (pk: any) => any; decapsulate: (ct: any, sk: any) => any },
  iterations: number
): BenchResult {
  // Warmup
  const warmKeys = algo.keygen()
  algo.encapsulate(warmKeys.publicKey)

  let keygenTotal = 0
  let encapTotal = 0
  let decapTotal = 0
  let pubKeySize = 0
  let secKeySize = 0
  let ctSize = 0

  for (let i = 0; i < iterations; i++) {
    let start = performance.now()
    const keys = algo.keygen()
    keygenTotal += performance.now() - start
    pubKeySize = keys.publicKey.length
    secKeySize = keys.secretKey.length

    start = performance.now()
    const { cipherText, sharedSecret } = algo.encapsulate(keys.publicKey)
    encapTotal += performance.now() - start
    ctSize = cipherText.length

    start = performance.now()
    algo.decapsulate(cipherText, keys.secretKey)
    decapTotal += performance.now() - start
  }

  return {
    name,
    keygenMs: keygenTotal / iterations,
    op1Ms: encapTotal / iterations,
    op1Label: 'Encapsulate',
    op2Ms: decapTotal / iterations,
    op2Label: 'Decapsulate',
    pubKeySize,
    secKeySize,
    outputSize: ctSize,
    outputLabel: 'Ciphertext',
  }
}

function benchSig(
  name: string,
  algo: { keygen: () => any; sign: (msg: any, sk: any) => any; verify: (sig: any, msg: any, pk: any) => any },
  iterations: number
): BenchResult {
  const msg = new TextEncoder().encode('Benchmark message for PQC signature algorithms.')

  // Warmup
  const warmKeys = algo.keygen()
  const warmSig = algo.sign(msg, warmKeys.secretKey)
  algo.verify(warmSig, msg, warmKeys.publicKey)

  let keygenTotal = 0
  let signTotal = 0
  let verifyTotal = 0
  let pubKeySize = 0
  let secKeySize = 0
  let sigSize = 0

  for (let i = 0; i < iterations; i++) {
    let start = performance.now()
    const keys = algo.keygen()
    keygenTotal += performance.now() - start
    pubKeySize = keys.publicKey.length
    secKeySize = keys.secretKey.length

    start = performance.now()
    const sig = algo.sign(msg, keys.secretKey)
    signTotal += performance.now() - start
    sigSize = sig.length

    start = performance.now()
    algo.verify(sig, msg, keys.publicKey)
    verifyTotal += performance.now() - start
  }

  return {
    name,
    keygenMs: keygenTotal / iterations,
    op1Ms: signTotal / iterations,
    op1Label: 'Sign',
    op2Ms: verifyTotal / iterations,
    op2Label: 'Verify',
    pubKeySize,
    secKeySize,
    outputSize: sigSize,
    outputLabel: 'Signature',
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}

export function runBenchmark() {
  banner('PQC Algorithm Benchmark')

  const iterations = 10
  console.log(`Running ${iterations} iterations per algorithm...\n`)

  const results: BenchResult[] = []

  // KEM algorithms
  console.log('Benchmarking KEM algorithms...')
  results.push(benchKem('ML-KEM-512', ml_kem512, iterations))
  results.push(benchKem('ML-KEM-768', ml_kem768, iterations))
  results.push(benchKem('ML-KEM-1024', ml_kem1024, iterations))
  results.push(benchKem('X25519+ML-KEM-768', ml_kem768_x25519, iterations))

  // Signature algorithms
  console.log('Benchmarking signature algorithms...')
  results.push(benchSig('ML-DSA-44', ml_dsa44, iterations))
  results.push(benchSig('ML-DSA-65', ml_dsa65, iterations))
  results.push(benchSig('ML-DSA-87', ml_dsa87, iterations))
  results.push(benchSig('SLH-DSA-SHA2-128f', slh_dsa_sha2_128f, iterations))
  results.push(benchSig('SLH-DSA-SHA2-128s', slh_dsa_sha2_128s, iterations))

  // Print results table
  console.log('\n--- Performance (avg ms per operation) ---\n')
  console.log(
    'Algorithm'.padEnd(22) +
      'Keygen'.padStart(10) +
      'Op1'.padStart(10) +
      'Op2'.padStart(10)
  )
  console.log('-'.repeat(52))

  for (const r of results) {
    console.log(
      r.name.padEnd(22) +
        r.keygenMs.toFixed(2).padStart(10) +
        r.op1Ms.toFixed(2).padStart(10) +
        r.op2Ms.toFixed(2).padStart(10) +
        `  (${r.op1Label}/${r.op2Label})`
    )
  }

  // Size comparison
  console.log('\n--- Key & Output Sizes ---\n')
  console.log(
    'Algorithm'.padEnd(22) +
      'PubKey'.padStart(10) +
      'SecKey'.padStart(10) +
      'Output'.padStart(10) +
      '  Type'
  )
  console.log('-'.repeat(60))

  for (const r of results) {
    console.log(
      r.name.padEnd(22) +
        formatSize(r.pubKeySize).padStart(10) +
        formatSize(r.secKeySize).padStart(10) +
        formatSize(r.outputSize).padStart(10) +
        `  ${r.outputLabel}`
    )
  }

  // Classical comparison
  console.log('\n--- Classical Comparison (reference sizes) ---\n')
  console.log('  RSA-2048:    PubKey=256 B, Signature=256 B')
  console.log('  ECDSA-P256:  PubKey=33 B,  Signature=64 B')
  console.log('  Ed25519:     PubKey=32 B,  Signature=64 B')
  console.log('  X25519:      PubKey=32 B,  Shared=32 B')
  console.log('\n  ⚠  All of the above are broken by quantum computers.')
  console.log('  The PQC algorithms above are their replacements.\n')
}

// Run directly
runBenchmark()
