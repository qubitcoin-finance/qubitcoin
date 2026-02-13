/**
 * qbtc Blockchain Simulation
 *
 * Multi-node demonstration of a Bitcoin-like blockchain
 * using ML-DSA-65 (Dilithium) post-quantum signatures.
 *
 * Phases:
 * 1. Wallet generation (ML-DSA-65 keypairs)
 * 2. Mining coinbase blocks (PoW with SHA-256)
 * 3. Transactions (UTXO model, PQC-signed)
 * 4. Mining transaction blocks
 * 5. Balance verification across nodes
 * 6. Chain inspection
 * 7. PQC size analysis
 * 8. Tamper detection
 */
import { generateWallet, type Wallet } from './crypto.js'
import { createTransaction, type UTXO } from './transaction.js'
import { Node } from './node.js'
import type { Block } from './block.js'
import { banner, sizeLabel, timeIt } from './utils.js'

function printWallet(name: string, wallet: Wallet) {
  console.log(`  ${name}:`)
  console.log(`    Address:    ${wallet.address.slice(0, 24)}...`)
  console.log(`    Public key: ${wallet.publicKey.length} bytes (ML-DSA-65)`)
  console.log(`    Secret key: ${wallet.secretKey.length} bytes`)
}

function printBalances(
  nodes: Node[],
  wallets: Array<{ name: string; wallet: Wallet }>
) {
  for (const { name, wallet } of wallets) {
    const balances = nodes.map((n) => n.chain.getBalance(wallet.address))
    const allMatch = balances.every((b) => b === balances[0])
    console.log(
      `  ${name}: ${balances[0]} coins ${allMatch ? '(all nodes agree)' : '(MISMATCH: ' + balances.join(', ') + ')'}`
    )
  }
}

function propagateBlock(block: Block, nodes: Node[], excludeNode: Node) {
  for (const node of nodes) {
    if (node !== excludeNode) {
      const result = node.receiveBlock(block)
      if (!result.success) {
        console.log(`  [${node.name}] Failed to receive block: ${result.error}`)
      }
    }
  }
}

function runSimulation() {
  console.log('╔══════════════════════════════════════════════════════════╗')
  console.log('║  qbtc: Post-Quantum Bitcoin-like Blockchain            ║')
  console.log('║  ML-DSA-65 (Dilithium) signatures + SHA-256 PoW        ║')
  console.log('╚══════════════════════════════════════════════════════════╝')

  // ============================================================
  // Phase 1: Wallet Generation
  // ============================================================
  banner('Phase 1: Wallet Generation')
  console.log('Generating ML-DSA-65 keypairs (replaces ECDSA secp256k1)...\n')

  const { result: alice, ms: aliceMs } = timeIt(() => generateWallet())
  printWallet('Alice', alice)
  console.log(`    Keygen:     ${aliceMs.toFixed(1)} ms\n`)

  const { result: bob, ms: bobMs } = timeIt(() => generateWallet())
  printWallet('Bob', bob)
  console.log(`    Keygen:     ${bobMs.toFixed(1)} ms\n`)

  const { result: charlie, ms: charlieMs } = timeIt(() => generateWallet())
  printWallet('Charlie', charlie)
  console.log(`    Keygen:     ${charlieMs.toFixed(1)} ms\n`)

  console.log('  Size comparison vs Bitcoin:')
  console.log('    ECDSA pubkey:    33 bytes  |  ML-DSA-65 pubkey: 1,952 bytes  (59x)')
  console.log('    ECDSA signature: 72 bytes  |  ML-DSA-65 sig:    3,309 bytes  (46x)')

  // ============================================================
  // Phase 2: Create Nodes
  // ============================================================
  banner('Phase 2: Network Setup')
  const node1 = new Node('Node-1')
  const node2 = new Node('Node-2')
  const node3 = new Node('Node-3')
  const nodes = [node1, node2, node3]

  console.log('  Created 3 nodes, each with identical genesis block')
  console.log(`  Genesis hash: ${node1.chain.getChainTip().hash.slice(0, 32)}...`)
  console.log(
    `  All genesis match: ${nodes.every((n) => n.chain.getChainTip().hash === node1.chain.getChainTip().hash)}`
  )

  // ============================================================
  // Phase 3: Mine Coinbase Blocks
  // ============================================================
  banner('Phase 3: Mining Coinbase Blocks')
  console.log("Mining 3 blocks on Node-1, coinbase reward → Alice's address\n")

  for (let i = 0; i < 3; i++) {
    const block = node1.mine(alice.address)
    propagateBlock(block, nodes, node1)
  }

  console.log()
  printBalances(nodes, [
    { name: 'Alice', wallet: alice },
    { name: 'Bob', wallet: bob },
    { name: 'Charlie', wallet: charlie },
  ])
  console.log(`\n  Chain height: ${node1.chain.getHeight()}`)
  console.log(`  Alice has 3 coinbase UTXOs (50 coins each = 150 total)`)

  // ============================================================
  // Phase 4: Transactions
  // ============================================================
  banner('Phase 4: Creating Transactions')

  // Alice → Bob: 30 coins (1 coin fee)
  console.log('  Alice → Bob: 30 coins (1 coin fee)')
  const aliceUtxos1 = node1.chain.findUTXOs(alice.address, 31)
  const { result: tx1, ms: tx1Ms } = timeIt(() =>
    createTransaction(alice, aliceUtxos1, [{ address: bob.address, amount: 30 }], 1)
  )
  console.log(`    TxID:     ${tx1.id.slice(0, 24)}...`)
  console.log(`    Inputs:   ${tx1.inputs.length} (spending ${aliceUtxos1.reduce((s, u) => s + u.amount, 0)} coins)`)
  console.log(`    Outputs:  ${tx1.outputs.length} (30 to Bob, ${tx1.outputs.length > 1 ? tx1.outputs[1].amount + ' change to Alice' : 'no change'})`)
  console.log(`    Sig size: ${tx1.inputs[0].signature.length} bytes per input`)
  console.log(`    Sign time: ${tx1Ms.toFixed(1)} ms\n`)

  // Submit to all nodes
  for (const node of nodes) {
    node.receiveTransaction(tx1)
  }

  // Alice → Charlie: 20 coins (1 coin fee)
  // Must use a different UTXO than tx1 (tx1 hasn't been mined yet)
  console.log('\n  Alice → Charlie: 20 coins (1 coin fee)')
  const spentByTx1 = new Set(
    tx1.inputs.map((i) => `${i.txId}:${i.outputIndex}`)
  )
  const aliceUtxos2 = node1.chain
    .findUTXOs(alice.address)
    .filter((u) => !spentByTx1.has(`${u.txId}:${u.outputIndex}`))
    .slice(0, 1) // just need 1 UTXO (50 coins) for 20 + 1 fee
  const { result: tx2, ms: tx2Ms } = timeIt(() =>
    createTransaction(
      alice,
      aliceUtxos2,
      [{ address: charlie.address, amount: 20 }],
      1
    )
  )
  console.log(`    TxID:     ${tx2.id.slice(0, 24)}...`)
  console.log(`    Sig size: ${tx2.inputs[0].signature.length} bytes per input`)
  console.log(`    Sign time: ${tx2Ms.toFixed(1)} ms`)

  for (const node of nodes) {
    node.receiveTransaction(tx2)
  }

  // ============================================================
  // Phase 5: Mine Transaction Block
  // ============================================================
  banner('Phase 5: Mining Transaction Block')
  console.log("Node-2 mines a block with pending transactions (coinbase → Bob)\n")

  const txBlock = node2.mine(bob.address)
  propagateBlock(txBlock, nodes, node2)

  console.log(`\n  Block #${txBlock.height} contains ${txBlock.transactions.length} transactions:`)
  for (let i = 0; i < txBlock.transactions.length; i++) {
    const tx = txBlock.transactions[i]
    const label = i === 0 ? 'coinbase' : `tx ${i}`
    console.log(
      `    [${label}] ${tx.id.slice(0, 20)}... → ${tx.outputs.map((o) => `${o.amount} coins`).join(', ')}`
    )
  }

  // ============================================================
  // Phase 6: Balance Verification
  // ============================================================
  banner('Phase 6: Balance Verification')
  console.log('  Checking all nodes agree on balances:\n')

  printBalances(nodes, [
    { name: 'Alice  ', wallet: alice },
    { name: 'Bob    ', wallet: bob },
    { name: 'Charlie', wallet: charlie },
  ])

  const aliceBal = node1.chain.getBalance(alice.address)
  const bobBal = node1.chain.getBalance(bob.address)
  const charlieBal = node1.chain.getBalance(charlie.address)

  const totalCoins = aliceBal + bobBal + charlieBal
  console.log(`\n  Total coins in circulation: ${totalCoins}`)
  console.log(`  Minted: ${50 * 4} (4 blocks × 50 coin subsidy)`)

  // ============================================================
  // Phase 7: UTXO Set
  // ============================================================
  banner('Phase 7: UTXO Set')

  for (const { name, wallet } of [
    { name: 'Alice', wallet: alice },
    { name: 'Bob', wallet: bob },
    { name: 'Charlie', wallet: charlie },
  ]) {
    const utxos = node1.chain.findUTXOs(wallet.address)
    console.log(`  ${name} (${utxos.length} UTXOs):`)
    for (const u of utxos) {
      console.log(`    ${u.amount} coins ← tx ${u.txId.slice(0, 16)}...[${u.outputIndex}]`)
    }
  }

  // ============================================================
  // Phase 8: Chain State
  // ============================================================
  banner('Phase 8: Chain State')

  for (const block of node1.chain.blocks) {
    console.log(
      `  Block #${block.height} | hash=${block.hash.slice(0, 20)}... | txs=${block.transactions.length} | nonce=${block.header.nonce}`
    )
  }

  console.log(`\n  Total blocks: ${node1.chain.blocks.length}`)
  console.log(`  Total UTXOs:  ${node1.chain.utxoSet.size}`)
  console.log(`  Difficulty:   ${node1.chain.getDifficulty().slice(0, 20)}...`)

  // ============================================================
  // Phase 9: PQC Size Analysis
  // ============================================================
  banner('Phase 9: Post-Quantum Size Analysis')

  let totalSigBytes = 0
  let totalPubKeyBytes = 0
  let totalTxCount = 0

  for (const block of node1.chain.blocks) {
    for (const tx of block.transactions) {
      totalTxCount++
      for (const input of tx.inputs) {
        totalSigBytes += input.signature.length
        totalPubKeyBytes += input.publicKey.length
      }
    }
  }

  console.log(`  Total transactions:        ${totalTxCount}`)
  console.log(`  Total signature bytes:     ${totalSigBytes.toLocaleString()} (ML-DSA-65)`)
  console.log(`  Total public key bytes:    ${totalPubKeyBytes.toLocaleString()} (ML-DSA-65)`)
  console.log(`  Total PQC witness data:    ${(totalSigBytes + totalPubKeyBytes).toLocaleString()} bytes`)

  // What it would be with ECDSA
  const ecdsaSigBytes = Math.ceil(totalSigBytes / 3309) * 72
  const ecdsaPubKeyBytes = Math.ceil(totalPubKeyBytes / 1952) * 33
  console.log(`\n  With ECDSA (Bitcoin):`)
  console.log(`    Signature bytes:         ${ecdsaSigBytes.toLocaleString()}`)
  console.log(`    Public key bytes:        ${ecdsaPubKeyBytes.toLocaleString()}`)
  console.log(`    Total witness data:      ${(ecdsaSigBytes + ecdsaPubKeyBytes).toLocaleString()} bytes`)

  const factor = (totalSigBytes + totalPubKeyBytes) / (ecdsaSigBytes + ecdsaPubKeyBytes)
  console.log(
    `\n  PQC overhead: ${factor.toFixed(1)}x larger signatures for quantum resistance`
  )
  console.log('  This is the fundamental trade-off of post-quantum cryptography.')

  // ============================================================
  // Phase 10: Tamper Detection
  // ============================================================
  banner('Phase 10: Tamper Detection')

  // First, validate clean chain
  console.log('  1. Validating untampered chain...')
  const cleanResult = node1.chain.validateChain()
  console.log(`     Result: ${cleanResult.valid ? 'VALID' : 'INVALID'}`)

  // Tamper with a transaction amount
  console.log('\n  2. Tampering with transaction amount in block #4...')
  const tamperedBlock = node1.chain.blocks[4]
  if (tamperedBlock && tamperedBlock.transactions.length > 1) {
    const originalAmount = tamperedBlock.transactions[1].outputs[0].amount
    tamperedBlock.transactions[1].outputs[0].amount = 999999

    const tamperResult = node1.chain.validateChain()
    console.log(`     Modified output from ${originalAmount} → 999999`)
    console.log(
      `     Result: ${tamperResult.valid ? 'VALID (BAD!)' : `INVALID at block #${tamperResult.invalidAtHeight}: ${tamperResult.error}`}`
    )

    // Restore
    tamperedBlock.transactions[1].outputs[0].amount = originalAmount
  } else {
    // Tamper with block hash instead
    console.log('     (Block #4 has no user txs, tampering with block #1 hash)')
    const origHash = node1.chain.blocks[1].hash
    node1.chain.blocks[1].hash = '0'.repeat(64)

    const tamperResult = node1.chain.validateChain()
    console.log(`     Modified block #1 hash to all zeros`)
    console.log(
      `     Result: ${tamperResult.valid ? 'VALID (BAD!)' : `INVALID at block #${tamperResult.invalidAtHeight}: ${tamperResult.error}`}`
    )

    // Restore
    node1.chain.blocks[1].hash = origHash
  }

  // Tamper with previous hash link
  console.log('\n  3. Breaking hash chain (modifying previousHash in block #2)...')
  const origPrevHash = node1.chain.blocks[2].header.previousHash
  node1.chain.blocks[2].header.previousHash = 'deadbeef'.repeat(8)

  const chainResult = node1.chain.validateChain()
  console.log(
    `     Result: ${chainResult.valid ? 'VALID (BAD!)' : `INVALID at block #${chainResult.invalidAtHeight}: ${chainResult.error}`}`
  )

  // Restore
  node1.chain.blocks[2].header.previousHash = origPrevHash

  // Final validation after restoring
  console.log('\n  4. Validating restored chain...')
  const finalResult = node1.chain.validateChain()
  console.log(`     Result: ${finalResult.valid ? 'VALID' : 'INVALID'}`)

  // ============================================================
  // Summary
  // ============================================================
  banner('Simulation Complete')
  console.log('  Demonstrated:')
  console.log('    - ML-DSA-65 (Dilithium) transaction signatures')
  console.log('    - SHA-256 double-hash Proof of Work (Bitcoin-compatible)')
  console.log('    - UTXO transaction model')
  console.log('    - Merkle tree block structure')
  console.log('    - Multi-node block propagation')
  console.log('    - Difficulty adjustment')
  console.log('    - Tamper detection (hash chain + merkle root + signatures)')
  console.log('    - Post-quantum size analysis')
  console.log()
  console.log('  qbtc: Bitcoin-compatible consensus, quantum-resistant signatures.')
  console.log()
}

runSimulation()
