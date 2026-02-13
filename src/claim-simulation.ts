/**
 * Bitcoin → QubitCoin (QBTC) Fork Simulation
 *
 * Demonstrates forking from Bitcoin's UTXO set:
 * 1. Snapshot Bitcoin's ledger at block #850,000
 * 2. Genesis block commits to the snapshot (tiny block)
 * 3. BTC holders prove ECDSA ownership → get ML-DSA-65 (quantum-safe) UTXOs
 * 4. Post-claim transactions use pure PQC signatures
 */
import { generateWallet, bytesToHex, type Wallet } from './crypto.js'
import { createTransaction } from './transaction.js'
import { createClaimTransaction } from './claim.js'
import { createMockSnapshot } from './snapshot.js'
import { Node } from './node.js'
import type { Block } from './block.js'
import { banner, timeIt } from './utils.js'

const NAMES = ['Alice', 'Bob', 'Charlie', 'Dave', 'Eve']

function propagateBlock(block: Block, nodes: Node[], excludeNode: Node) {
  for (const node of nodes) {
    if (node !== excludeNode) {
      node.receiveBlock(block)
    }
  }
}

function runForkSimulation() {
  console.log('╔══════════════════════════════════════════════════════════╗')
  console.log('║  QubitCoin (QBTC): Bitcoin Fork with Quantum Resistance  ║')
  console.log('║  ECDSA claim proofs → ML-DSA-65 native signatures      ║')
  console.log('╚══════════════════════════════════════════════════════════╝')

  // ============================================================
  // Phase 1: Bitcoin UTXO Snapshot
  // ============================================================
  banner('Phase 1: Bitcoin UTXO Snapshot')

  const { result: mockData, ms: snapshotMs } = timeIt(() => createMockSnapshot())
  const { snapshot, holders } = mockData
  const totalBtc = holders.reduce((s, h) => s + h.amount, 0)

  console.log(`  This represents Bitcoin's ledger at block #${snapshot.btcBlockHeight.toLocaleString()}`)
  console.log(`  Snapshot created in ${snapshotMs.toFixed(1)} ms\n`)
  console.log(`  Block hash:      ${snapshot.btcBlockHash.slice(0, 32)}...`)
  console.log(`  Commitment hash: ${snapshot.merkleRoot.slice(0, 32)}...`)
  console.log(`  Address entries: ${snapshot.entries.length}\n`)

  for (let i = 0; i < holders.length; i++) {
    console.log(
      `  ${NAMES[i].padEnd(8)} ${holders[i].amount.toString().padStart(4)} BTC  addr=${holders[i].address.slice(0, 20)}...`
    )
  }
  console.log(`  ${''.padEnd(8)} ────`)
  console.log(`  ${'Total'.padEnd(8)} ${totalBtc.toString().padStart(4)} BTC locked in snapshot`)

  // ============================================================
  // Phase 2: Fork Genesis
  // ============================================================
  banner('Phase 2: Fork Genesis')

  console.log('  Creating 3 QBTC nodes with fork genesis block...\n')

  const node1 = new Node('QBTC-1', snapshot)
  const node2 = new Node('QBTC-2', snapshot)
  const node3 = new Node('QBTC-3', snapshot)
  const nodes = [node1, node2, node3]

  const genesis = node1.chain.getChainTip()
  console.log(`  Genesis hash:    ${genesis.hash.slice(0, 32)}...`)
  console.log(`  Genesis version: ${genesis.header.version} (fork genesis)`)
  console.log(`  Coinbase amount: ${genesis.transactions[0].outputs[0].amount} (no free coins)`)
  console.log(`  Block size:      ~${JSON.stringify(genesis).length} bytes (tiny — no UTXO data)`)
  console.log(`  All nodes match: ${nodes.every((n) => n.chain.getChainTip().hash === genesis.hash)}`)
  console.log()
  console.log('  Genesis embeds only the commitment hash.')
  console.log('  The full snapshot is verified off-chain against this commitment.')

  // ============================================================
  // Phase 3: BTC Holders Generate PQC Wallets
  // ============================================================
  banner('Phase 3: BTC Holders Generate ML-DSA-65 Wallets')

  console.log('  Quantum-safe migration: ECDSA secp256k1 → ML-DSA-65 (Dilithium)\n')

  const qbtcWallets: Wallet[] = []
  for (let i = 0; i < holders.length; i++) {
    const { result: wallet, ms } = timeIt(() => generateWallet())
    qbtcWallets.push(wallet)
    console.log(
      `  ${NAMES[i].padEnd(8)} QBTC addr: ${wallet.address.slice(0, 24)}...  (${ms.toFixed(0)} ms)`
    )
  }

  console.log(`\n  ECDSA pubkey:  33 bytes  →  ML-DSA-65 pubkey: ${qbtcWallets[0].publicKey.length.toLocaleString()} bytes`)
  console.log(`  ECDSA secret:  32 bytes  →  ML-DSA-65 secret: ${qbtcWallets[0].secretKey.length.toLocaleString()} bytes`)

  // ============================================================
  // Phase 4: Claim Transactions (3 of 5)
  // ============================================================
  banner('Phase 4: Claim Transactions')

  console.log('  3 of 5 BTC holders claim — prove ECDSA ownership, get QBTC UTXOs\n')

  const minerWallet = generateWallet()

  for (let i = 0; i < 3; i++) {
    const { result: claimTx, ms } = timeIt(() =>
      createClaimTransaction(
        holders[i].secretKey,
        holders[i].publicKey,
        snapshot.entries[i],
        qbtcWallets[i],
        snapshot.btcBlockHash
      )
    )

    console.log(`  ${NAMES[i]} claims ${holders[i].amount} BTC → QBTC:`)
    console.log(`    ECDSA sig:   ${bytesToHex(claimTx.claimData!.ecdsaSignature).slice(0, 24)}... (${claimTx.claimData!.ecdsaSignature.length}B)`)
    console.log(`    QBTC dest:    ${qbtcWallets[i].address.slice(0, 24)}...`)
    console.log(`    Claim TX:    ${claimTx.id.slice(0, 24)}... (${ms.toFixed(0)} ms)`)

    for (const node of nodes) {
      node.receiveTransaction(claimTx)
    }
    console.log()
  }

  console.log('  Mining block with 3 claim transactions...\n')
  const claimBlock = node1.mine(minerWallet.address)
  propagateBlock(claimBlock, nodes, node1)

  console.log(`\n  Block #${claimBlock.height}: ${claimBlock.transactions.length} txs (1 coinbase + 3 claims)`)
  for (let i = 0; i < claimBlock.transactions.length; i++) {
    const tx = claimBlock.transactions[i]
    const label = i === 0 ? 'coinbase' : 'claim  '
    console.log(`    [${label}] ${tx.id.slice(0, 20)}... → ${tx.outputs.map((o) => o.amount).join(', ')} coins`)
  }

  // ============================================================
  // Phase 5: Post-Claim Transactions (pure ML-DSA-65)
  // ============================================================
  banner('Phase 5: Post-Claim Transactions (Pure ML-DSA-65)')

  console.log('  Claimed coins are PQ-native. All spending uses ML-DSA-65.\n')

  // Alice → Bob: 30 QBTC
  const aliceUtxos = node1.chain.findUTXOs(qbtcWallets[0].address, 31)
  const { result: sendTx1, ms: send1Ms } = timeIt(() =>
    createTransaction(
      qbtcWallets[0],
      aliceUtxos,
      [{ address: qbtcWallets[1].address, amount: 30 }],
      1
    )
  )
  console.log(`  Alice → Bob: 30 QBTC (1 fee)`)
  console.log(`    ML-DSA-65 sig: ${sendTx1.inputs[0].signature.length.toLocaleString()} bytes | ${send1Ms.toFixed(0)} ms`)

  for (const node of nodes) {
    node.receiveTransaction(sendTx1)
  }

  // Bob → Charlie: 10 QBTC
  const bobUtxos = node1.chain.findUTXOs(qbtcWallets[1].address, 11)
  const { result: sendTx2, ms: send2Ms } = timeIt(() =>
    createTransaction(
      qbtcWallets[1],
      bobUtxos,
      [{ address: qbtcWallets[2].address, amount: 10 }],
      1
    )
  )
  console.log(`  Bob → Charlie: 10 QBTC (1 fee)`)
  console.log(`    ML-DSA-65 sig: ${sendTx2.inputs[0].signature.length.toLocaleString()} bytes | ${send2Ms.toFixed(0)} ms`)

  for (const node of nodes) {
    node.receiveTransaction(sendTx2)
  }

  console.log('\n  Mining block with PQ transactions...\n')
  const transferBlock = node2.mine(minerWallet.address)
  propagateBlock(transferBlock, nodes, node2)

  console.log(`\n  Block #${transferBlock.height}: ${transferBlock.transactions.length} txs (all ML-DSA-65 signed)`)

  // ============================================================
  // Phase 6: Claim Stats
  // ============================================================
  banner('Phase 6: Claim Statistics')

  const stats = node1.chain.getClaimStats()
  console.log(`  Snapshot entries: ${stats.totalEntries}`)
  console.log(`  Claimed:         ${stats.claimed} entries (${stats.claimedAmount} coins migrated)`)
  console.log(`  Unclaimed:       ${stats.unclaimed} entries (${stats.unclaimedAmount} coins locked)`)
  console.log(`  Migration rate:  ${((stats.claimed / stats.totalEntries) * 100).toFixed(0)}%`)

  console.log('\n  Balances:')
  for (let i = 0; i < holders.length; i++) {
    const bal = node1.chain.getBalance(qbtcWallets[i].address)
    const status = i < 3 ? 'claimed' : 'not claimed'
    console.log(`    ${NAMES[i].padEnd(8)} ${bal.toString().padStart(4)} QBTC  (${status})`)
  }
  const minerBal = node1.chain.getBalance(minerWallet.address)
  console.log(`    ${'Miner'.padEnd(8)} ${minerBal.toString().padStart(4)} QBTC  (block rewards + fees)`)

  // All nodes agree?
  const allAgree = nodes.every((n) =>
    holders.every(
      (_, i) =>
        n.chain.getBalance(qbtcWallets[i].address) ===
        node1.chain.getBalance(qbtcWallets[i].address)
    )
  )
  console.log(`\n  All 3 nodes agree on balances: ${allAgree}`)

  // ============================================================
  // Phase 7: Late Claimer
  // ============================================================
  banner('Phase 7: Late Claimer')

  console.log('  Dave claims his 500 BTC — claims work at any time after the fork.\n')

  const { result: lateClaim, ms: lateMs } = timeIt(() =>
    createClaimTransaction(
      holders[3].secretKey,
      holders[3].publicKey,
      snapshot.entries[3],
      qbtcWallets[3],
      snapshot.btcBlockHash
    )
  )
  console.log(`  Dave claims ${holders[3].amount} BTC → QBTC (${lateMs.toFixed(0)} ms)`)

  for (const node of nodes) {
    node.receiveTransaction(lateClaim)
  }

  const lateBlock = node3.mine(minerWallet.address)
  propagateBlock(lateBlock, nodes, node3)

  console.log(`  Dave's balance: ${node1.chain.getBalance(qbtcWallets[3].address)} QBTC`)

  const stats2 = node1.chain.getClaimStats()
  console.log(`  Migration rate: ${((stats2.claimed / stats2.totalEntries) * 100).toFixed(0)}% (${stats2.claimed}/${stats2.totalEntries})`)

  // ============================================================
  // Phase 8: Double-Claim Prevention
  // ============================================================
  banner('Phase 8: Double-Claim Prevention')

  console.log("  Attempting to re-claim Alice's already-claimed BTC address...\n")

  const doubleClaim = createClaimTransaction(
    holders[0].secretKey,
    holders[0].publicKey,
    snapshot.entries[0],
    qbtcWallets[0],
    snapshot.btcBlockHash
  )

  const doubleResult = node1.receiveTransaction(doubleClaim)
  console.log(
    `  Result: ${doubleResult.success ? 'ACCEPTED (BAD!)' : `REJECTED — ${doubleResult.error}`}`
  )
  console.log('\n  3 layers of protection:')
  console.log('    1. Chain-level:   claimedBtcAddresses set')
  console.log('    2. Mempool-level: pendingBtcClaims set')
  console.log('    3. Block-level:   structural validation')

  // ============================================================
  // Phase 9: Summary
  // ============================================================
  banner('Fork Simulation Complete')

  const finalStats = node1.chain.getClaimStats()

  console.log('  Total BTC migrated to quantum-safe keys:')
  console.log(`    Claimed:    ${finalStats.claimed}/${finalStats.totalEntries} addresses (${finalStats.claimedAmount} of ${totalBtc} coins)`)
  console.log(`    Unclaimed:  ${finalStats.unclaimed} addresses (${finalStats.unclaimedAmount} coins — Eve hasn't claimed)`)
  console.log(`    Chain:      ${node1.chain.getHeight()} blocks, ${node1.chain.utxoSet.size} live UTXOs`)
  console.log()

  // Size comparison
  console.log('  Size comparison — ECDSA claim proofs vs ML-DSA-65 ongoing sigs:')
  console.log('    ┌────────────────┬──────────────┬──────────────┐')
  console.log('    │                │ ECDSA (claim)│ ML-DSA-65    │')
  console.log('    ├────────────────┼──────────────┼──────────────┤')
  console.log('    │ Public key     │     33 bytes │  1,952 bytes │')
  console.log('    │ Signature      │     64 bytes │  3,309 bytes │')
  console.log('    │ Total witness  │     97 bytes │  5,261 bytes │')
  console.log('    │ Overhead       │          1x  │        ~54x  │')
  console.log('    └────────────────┴──────────────┴──────────────┘')
  console.log()
  console.log('  ECDSA is used exactly once (claim proof).')
  console.log('  ML-DSA-65 is used for all ongoing transactions.')
  console.log('  ~54x larger signatures is the cost of quantum resistance.')
  console.log()

  // Chain validation
  const chainValid = node1.chain.validateChain()
  console.log(`  Full chain re-validation: ${chainValid.valid ? 'VALID' : `INVALID: ${chainValid.error}`}`)
  console.log()
  console.log("  Fork complete: Bitcoin's ledger, quantum-resistant signatures.")
  console.log()
}

runForkSimulation()
