import { describe, it, expect } from 'vitest'
import { Node } from '../node.js'
import { Blockchain } from '../chain.js'
import { computeBlockHash, computeMerkleRoot, hashMeetsTarget } from '../block.js'
import { createTransaction, createCoinbaseTransaction, validateTransaction, utxoKey, CLAIM_MATURITY, type UTXO } from '../transaction.js'
import { createClaimTransaction } from '../claim.js'
import { createMockSnapshot } from '../snapshot.js'
import { walletA, walletB } from './fixtures.js'

describe('Claim maturity', () => {
  const TEST_TARGET = '0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

  function mineEmpty(node: Node) {
    node.mine(walletA.address, false)
  }

  function mineBlockOnChain(chain: Blockchain, extraTxs: any[] = []) {
    const tip = chain.getChainTip()
    const height = chain.getHeight() + 1
    const coinbase = createCoinbaseTransaction('f'.repeat(64), height, 0)
    const txs = [coinbase, ...extraTxs]
    const merkleRoot = computeMerkleRoot(txs.map(t => t.id))
    const header = {
      version: 1,
      previousHash: tip.hash,
      merkleRoot,
      timestamp: tip.header.timestamp + 1,
      target: TEST_TARGET,
      nonce: 0,
    }
    let hash = computeBlockHash(header)
    while (!hashMeetsTarget(hash, TEST_TARGET)) {
      header.nonce++
      hash = computeBlockHash(header)
    }
    return { header, hash, transactions: txs, height }
  }

  it('should reject spending claim UTXO at age 1 (validateTransaction)', () => {
    const claimUtxo: UTXO = {
      txId: 'c'.repeat(63) + '1',
      outputIndex: 0,
      address: walletA.address,
      amount: 100_000_000,
      height: 5,
      isClaim: true,
    }
    const utxoSet = new Map<string, UTXO>()
    utxoSet.set(utxoKey(claimUtxo.txId, 0), claimUtxo)

    const spendTx = createTransaction(
      walletA,
      [claimUtxo],
      [{ address: walletB.address, amount: 100_000_000 - 10000 }],
      10000
    )

    const result = validateTransaction(spendTx, utxoSet, 6) // age=1
    expect(result.valid).toBe(false)
    expect(result.error).toContain('Claim UTXO')
    expect(result.error).toContain('not mature')
    expect(result.error).toContain('age 1')
  })

  it('should reject spending claim UTXO at age 9 (one block short)', () => {
    const claimUtxo: UTXO = {
      txId: 'c'.repeat(63) + '2',
      outputIndex: 0,
      address: walletA.address,
      amount: 50_000_000,
      height: 1,
      isClaim: true,
    }
    const utxoSet = new Map<string, UTXO>()
    utxoSet.set(utxoKey(claimUtxo.txId, 0), claimUtxo)

    const spendTx = createTransaction(
      walletA,
      [claimUtxo],
      [{ address: walletB.address, amount: 50_000_000 - 10000 }],
      10000
    )

    // currentHeight=10, height=1, age=9 < CLAIM_MATURITY(10)
    const result = validateTransaction(spendTx, utxoSet, 10)
    expect(result.valid).toBe(false)
    expect(result.error).toContain('age 9')
    expect(result.error).toContain(`need ${CLAIM_MATURITY}`)
  })

  it('should allow spending claim UTXO at exactly CLAIM_MATURITY age', () => {
    const claimUtxo: UTXO = {
      txId: 'c'.repeat(63) + '3',
      outputIndex: 0,
      address: walletA.address,
      amount: 100_000_000,
      height: 1,
      isClaim: true,
    }
    const utxoSet = new Map<string, UTXO>()
    utxoSet.set(utxoKey(claimUtxo.txId, 0), claimUtxo)

    const spendTx = createTransaction(
      walletA,
      [claimUtxo],
      [{ address: walletB.address, amount: 100_000_000 - 10000 }],
      10000
    )

    // currentHeight=11, height=1, age=10 == CLAIM_MATURITY
    const result = validateTransaction(spendTx, utxoSet, 1 + CLAIM_MATURITY)
    expect(result.valid).toBe(true)
  })

  it('should allow spending claim UTXO well past maturity', () => {
    const claimUtxo: UTXO = {
      txId: 'c'.repeat(63) + '4',
      outputIndex: 0,
      address: walletA.address,
      amount: 100_000_000,
      height: 1,
      isClaim: true,
    }
    const utxoSet = new Map<string, UTXO>()
    utxoSet.set(utxoKey(claimUtxo.txId, 0), claimUtxo)

    const spendTx = createTransaction(
      walletA,
      [claimUtxo],
      [{ address: walletB.address, amount: 100_000_000 - 10000 }],
      10000
    )

    // age = 500, well past maturity
    const result = validateTransaction(spendTx, utxoSet, 501)
    expect(result.valid).toBe(true)
  })

  it('should not apply claim maturity to non-claim UTXOs', () => {
    // Regular UTXO (not isClaim, not isCoinbase) — should be spendable immediately
    const utxo: UTXO = {
      txId: 'a'.repeat(64),
      outputIndex: 0,
      address: walletA.address,
      amount: 100_000_000,
      height: 10,
      // no isClaim flag
    }
    const utxoSet = new Map<string, UTXO>()
    utxoSet.set(utxoKey(utxo.txId, 0), utxo)

    const spendTx = createTransaction(
      walletA,
      [utxo],
      [{ address: walletB.address, amount: 100_000_000 - 10000 }],
      10000
    )

    // currentHeight=11, age=1 — would fail if claim maturity applied
    const result = validateTransaction(spendTx, utxoSet, 11)
    expect(result.valid).toBe(true)
  })

  it('should set isClaim=true on UTXOs created by claim transactions (chain level)', () => {
    const { snapshot, holders } = createMockSnapshot()
    const chain = new Blockchain(snapshot)
    chain.difficulty = TEST_TARGET
    const genesisHash = chain.blocks[0].hash

    const claimTx = createClaimTransaction(
      holders[0].secretKey, holders[0].publicKey,
      snapshot.entries[0], walletA, snapshot.btcBlockHash, genesisHash
    )

    const block = mineBlockOnChain(chain, [claimTx])
    expect(chain.addBlock(block).success).toBe(true)

    // Check the UTXO created by the claim has isClaim=true
    const key = utxoKey(claimTx.id, 0)
    const utxo = chain.utxoSet.get(key)
    expect(utxo).toBeDefined()
    expect(utxo!.isClaim).toBe(true)
    expect(utxo!.height).toBe(1)
  })

  it('should NOT set isClaim on coinbase UTXOs', () => {
    const node = new Node('cb-flag')
    node.chain.difficulty = TEST_TARGET
    node.mine(walletA.address, false)

    // Get the coinbase UTXO
    const coinbaseTx = node.chain.blocks[1].transactions[0]
    const key = utxoKey(coinbaseTx.id, 0)
    const utxo = node.chain.utxoSet.get(key)
    expect(utxo).toBeDefined()
    expect(utxo!.isClaim).toBeUndefined()
    expect(utxo!.isCoinbase).toBe(true)
  })

  it('should reject immature claim spend at chain level (addBlock)', () => {
    const { snapshot, holders } = createMockSnapshot()
    const chain = new Blockchain(snapshot)
    chain.difficulty = TEST_TARGET
    const genesisHash = chain.blocks[0].hash

    // Mine a claim in block 1
    const claimTx = createClaimTransaction(
      holders[0].secretKey, holders[0].publicKey,
      snapshot.entries[0], walletA, snapshot.btcBlockHash, genesisHash
    )
    const block1 = mineBlockOnChain(chain, [claimTx])
    expect(chain.addBlock(block1).success).toBe(true)

    // Try spending immediately in block 2 (age=1, need 10)
    const utxos = chain.findUTXOs(walletA.address)
    expect(utxos.length).toBe(1)

    const spendTx = createTransaction(
      walletA,
      utxos,
      [{ address: walletB.address, amount: utxos[0].amount - 10000 }],
      10000
    )
    const block2 = mineBlockOnChain(chain, [spendTx])
    const result = chain.addBlock(block2)
    expect(result.success).toBe(false)
    expect(result.error).toContain('Claim UTXO')
    expect(result.error).toContain('not mature')
  })

  it('should accept mature claim spend at chain level (addBlock)', () => {
    const { snapshot, holders } = createMockSnapshot()
    const chain = new Blockchain(snapshot)
    chain.difficulty = TEST_TARGET
    const genesisHash = chain.blocks[0].hash

    // Mine a claim in block 1
    const claimTx = createClaimTransaction(
      holders[0].secretKey, holders[0].publicKey,
      snapshot.entries[0], walletA, snapshot.btcBlockHash, genesisHash
    )
    const block1 = mineBlockOnChain(chain, [claimTx])
    expect(chain.addBlock(block1).success).toBe(true)

    // Mine CLAIM_MATURITY empty blocks to mature the claim
    for (let i = 0; i < CLAIM_MATURITY; i++) {
      expect(chain.addBlock(mineBlockOnChain(chain)).success).toBe(true)
    }

    // Now spend at height 1 + CLAIM_MATURITY + 1 = 12 (age=11, need 10) — should succeed
    const utxos = chain.findUTXOs(walletA.address)
    expect(utxos.length).toBe(1)

    const spendTx = createTransaction(
      walletA,
      utxos,
      [{ address: walletB.address, amount: utxos[0].amount - 10000 }],
      10000
    )
    const spendBlock = mineBlockOnChain(chain, [spendTx])
    const result = chain.addBlock(spendBlock)
    expect(result.success).toBe(true)
    expect(chain.getBalance(walletB.address)).toBe(utxos[0].amount - 10000)
  })

  it('should reject immature claim spend in mempool', () => {
    const { snapshot, holders } = createMockSnapshot()
    const node = new Node('mempool-mat', snapshot)
    node.chain.difficulty = TEST_TARGET
    const genesisHash = node.chain.blocks[0].hash

    // Mine a claim in block 1
    const claimTx = createClaimTransaction(
      holders[0].secretKey, holders[0].publicKey,
      snapshot.entries[0], walletA, snapshot.btcBlockHash, genesisHash
    )
    const tip = node.chain.getChainTip()
    const height = node.chain.getHeight() + 1
    const coinbase = createCoinbaseTransaction('f'.repeat(64), height, 0)
    const txs = [coinbase, claimTx]
    const merkleRoot = computeMerkleRoot(txs.map(t => t.id))
    const header = {
      version: 1, previousHash: tip.hash, merkleRoot,
      timestamp: tip.header.timestamp + 1, target: TEST_TARGET, nonce: 0,
    }
    let hash = computeBlockHash(header)
    while (!hashMeetsTarget(hash, TEST_TARGET)) {
      header.nonce++
      hash = computeBlockHash(header)
    }
    expect(node.chain.addBlock({ header, hash, transactions: txs, height }).success).toBe(true)

    // Try spending immediately via receiveTransaction (mempool validates against chain height)
    const utxos = node.chain.findUTXOs(walletA.address)
    const spendTx = createTransaction(
      walletA, utxos,
      [{ address: walletB.address, amount: utxos[0].amount - 10000 }],
      10000
    )
    const result = node.receiveTransaction(spendTx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('Claim UTXO')
  })
})
