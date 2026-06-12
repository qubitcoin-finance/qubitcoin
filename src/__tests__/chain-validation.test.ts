import { describe, it, expect } from 'vitest'
import { Blockchain } from '../chain.js'
import { createCoinbaseTransaction, createTransaction, COINBASE_MATURITY } from '../transaction.js'
import { computeMerkleRoot, computeBlockHash, hashMeetsTarget, medianTimestamp, MAX_FUTURE_BLOCK_TIME_MS, MAX_BLOCK_SIZE, type Block, type BlockHeader } from '../block.js'
import { createMockSnapshot } from '../snapshot.js'
import { createClaimTransaction } from '../claim.js'
import { walletA, walletB } from './fixtures.js'
import { TEST_TARGET, mineOnChain } from './chain-test-helpers.js'

describe('Coinbase maturity', () => {
  it('rejects spending immature coinbase UTXO', () => {
    const chain = new Blockchain()

    // Mine block 1 to get a coinbase UTXO for walletA
    const block1 = mineOnChain(chain, walletA.address)
    chain.addBlock(block1)

    // Mine only 50 more blocks (not enough for maturity)
    for (let i = 0; i < 50; i++) {
      chain.addBlock(mineOnChain(chain, 'f'.repeat(64)))
    }
    expect(chain.getHeight()).toBe(51)

    // Try to spend walletA's coinbase — should fail (age=50 < 100)
    const utxos = chain.findUTXOs(walletA.address)
    expect(utxos.length).toBe(1)
    const tx = createTransaction(walletA, utxos, [{ address: walletB.address, amount: 200_000_000 }], 12_500_000)
    const spendBlock = mineOnChain(chain, 'f'.repeat(64), [tx])
    const result = chain.addBlock(spendBlock)
    expect(result.success).toBe(false)
    expect(result.error).toContain('not mature')
  })

  it('allows spending coinbase UTXO after 100 blocks', () => {
    const chain = new Blockchain()

    // Mine block 1 for walletA
    const block1 = mineOnChain(chain, walletA.address)
    chain.addBlock(block1)

    // Mine exactly 100 more blocks to reach maturity
    for (let i = 0; i < COINBASE_MATURITY; i++) {
      chain.addBlock(mineOnChain(chain, 'f'.repeat(64)))
    }
    expect(chain.getHeight()).toBe(101)

    // Spend walletA's coinbase — should succeed (age=100 >= 100)
    const utxos = chain.findUTXOs(walletA.address)
    expect(utxos.length).toBe(1)
    expect(utxos[0].isCoinbase).toBe(true)
    expect(utxos[0].height).toBe(1)
    const tx = createTransaction(walletA, utxos, [{ address: walletB.address, amount: 200_000_000 }], 12_500_000)
    const spendBlock = mineOnChain(chain, 'f'.repeat(64), [tx])
    const result = chain.addBlock(spendBlock)
    expect(result.success).toBe(true)
  })

  it('non-coinbase UTXOs are not affected by maturity', () => {
    const chain = new Blockchain()

    // Mine block 1 for walletA and mature it
    chain.addBlock(mineOnChain(chain, walletA.address))
    for (let i = 0; i < COINBASE_MATURITY; i++) {
      chain.addBlock(mineOnChain(chain, 'f'.repeat(64)))
    }

    // Spend walletA's coinbase → walletB (creates non-coinbase UTXO)
    const utxos = chain.findUTXOs(walletA.address)
    const tx = createTransaction(walletA, utxos, [{ address: walletB.address, amount: 200_000_000 }], 12_500_000)
    chain.addBlock(mineOnChain(chain, 'f'.repeat(64), [tx]))

    // walletB can spend immediately (non-coinbase, no maturity required)
    const utxosB = chain.findUTXOs(walletB.address)
    expect(utxosB.length).toBe(1)
    expect(utxosB[0].isCoinbase).toBeUndefined() // not a coinbase
    const tx2 = createTransaction(walletB, utxosB, [{ address: walletA.address, amount: 100_000_000 }], 50_000_000)
    const spendBlock = mineOnChain(chain, 'f'.repeat(64), [tx2])
    const result = chain.addBlock(spendBlock)
    expect(result.success).toBe(true)
  })

  it('rejects immature coinbase at height boundary (age=99)', () => {
    const chain = new Blockchain()

    // Mine block 1 for walletA
    chain.addBlock(mineOnChain(chain, walletA.address))

    // Mine 98 more blocks (total height 99, coinbase age = 98)
    for (let i = 0; i < 98; i++) {
      chain.addBlock(mineOnChain(chain, 'f'.repeat(64)))
    }
    expect(chain.getHeight()).toBe(99)

    // Spending at height 100 → age = 99, still immature
    const utxos = chain.findUTXOs(walletA.address)
    const tx = createTransaction(walletA, utxos, [{ address: walletB.address, amount: 200_000_000 }], 12_500_000)
    const spendBlock = mineOnChain(chain, 'f'.repeat(64), [tx])
    const result = chain.addBlock(spendBlock)
    expect(result.success).toBe(false)
    expect(result.error).toContain('not mature')
  })
})

describe('Block timestamp validation', () => {
  it('rejects block with timestamp in the past (below MTP)', () => {
    const chain = new Blockchain()

    // Mine 12 blocks with increasing timestamps
    for (let i = 0; i < 12; i++) {
      chain.addBlock(mineOnChain(chain, 'f'.repeat(64)))
    }

    // Try to add a block with a timestamp equal to the MTP (should fail — must be strictly greater)
    const tip = chain.getChainTip()
    const mtp = medianTimestamp(chain.blocks, chain.blocks.length - 1)
    const coinbase = createCoinbaseTransaction('f'.repeat(64), chain.getHeight() + 1, 0)
    const txs = [coinbase]
    const merkleRoot = computeMerkleRoot(txs.map(t => t.id))
    const header: BlockHeader = {
      version: 1,
      previousHash: tip.hash,
      merkleRoot,
      timestamp: mtp, // exactly MTP — invalid (must be > MTP)
      target: chain.getDifficulty(),
      nonce: 0,
    }
    let hash = computeBlockHash(header)
    while (!hashMeetsTarget(hash, header.target)) {
      header.nonce++
      hash = computeBlockHash(header)
    }
    const block: Block = { header, hash, transactions: txs, height: chain.getHeight() + 1 }
    const result = chain.addBlock(block)
    expect(result.success).toBe(false)
    expect(result.error).toContain('median time past')
  })

  it('rejects block with timestamp too far in the future', () => {
    const chain = new Blockchain()
    chain.addBlock(mineOnChain(chain, 'f'.repeat(64)))

    const tip = chain.getChainTip()
    const coinbase = createCoinbaseTransaction('f'.repeat(64), chain.getHeight() + 1, 0)
    const txs = [coinbase]
    const merkleRoot = computeMerkleRoot(txs.map(t => t.id))
    const header: BlockHeader = {
      version: 1,
      previousHash: tip.hash,
      merkleRoot,
      timestamp: Date.now() + MAX_FUTURE_BLOCK_TIME_MS + 60_000, // 2h1m in the future
      target: chain.getDifficulty(),
      nonce: 0,
    }
    let hash = computeBlockHash(header)
    while (!hashMeetsTarget(hash, header.target)) {
      header.nonce++
      hash = computeBlockHash(header)
    }
    const block: Block = { header, hash, transactions: txs, height: chain.getHeight() + 1 }
    const result = chain.addBlock(block)
    expect(result.success).toBe(false)
    expect(result.error).toContain('too far in the future')
  })

  it('accepts block with valid timestamp', () => {
    const chain = new Blockchain()

    // Mine several blocks — all should succeed with proper timestamps
    for (let i = 0; i < 15; i++) {
      const block = mineOnChain(chain, 'f'.repeat(64))
      const result = chain.addBlock(block)
      expect(result.success).toBe(true)
    }
    expect(chain.getHeight()).toBe(15)
  })

  it('medianTimestamp computes correctly', () => {
    // Build a fake chain with known timestamps
    const blocks: Block[] = []
    for (let i = 0; i <= 11; i++) {
      blocks.push({
        header: { version: 1, previousHash: '', merkleRoot: '', timestamp: (i + 1) * 1000, target: '', nonce: 0 },
        hash: '', transactions: [], height: i,
      })
    }
    // Timestamps: 1000,2000,...,12000 — median of last 11 (indices 1-11) = 7000
    expect(medianTimestamp(blocks, 11)).toBe(7000)
    // Median of all 12 (indices 0-11) with count=12 = (6000+7000)/2... no, it's floor(12/2)=6th = 7000
    // Actually: sorted [1000..12000], floor(12/2) = index 6 = 7000
    expect(medianTimestamp(blocks, 11, 12)).toBe(7000)
    // Median of first 3 (indices 0-2): [1000,2000,3000], floor(3/2)=1 → 2000
    expect(medianTimestamp(blocks, 2, 3)).toBe(2000)
  })
})

describe('validateChain completeness', () => {
  it('reports invalidAtHeight for tampered block', () => {
    const chain = new Blockchain()
    chain.addBlock(mineOnChain(chain, walletA.address))
    chain.addBlock(mineOnChain(chain, walletA.address))

    chain.blocks[1].hash = 'ff'.repeat(32)
    const result = chain.validateChain()
    expect(result.valid).toBe(false)
    expect(result.invalidAtHeight).toBe(1)
  })

  it('detects tampered block height field', () => {
    const chain = new Blockchain()
    chain.addBlock(mineOnChain(chain, walletA.address))

    // Tamper height without touching the hash
    chain.blocks[1].height = 99
    const result = chain.validateChain()
    expect(result.valid).toBe(false)
    expect(result.error).toContain('height field is 99')
    expect(result.invalidAtHeight).toBe(1)
  })

  it('detects coinbase overreach (more than subsidy)', () => {
    const chain = new Blockchain()
    chain.difficulty = TEST_TARGET
    chain.addBlock(mineOnChain(chain, walletA.address))

    // Inflate the coinbase output amount directly on the stored block
    chain.blocks[1].transactions[0].outputs[0].amount = 999_999_999_999

    // Recompute merkle root and rehash so hash/merkle checks still pass
    const txIds = chain.blocks[1].transactions.map((t) => t.id)
    chain.blocks[1].header.merkleRoot = computeMerkleRoot(txIds)
    chain.blocks[1].hash = computeBlockHash(chain.blocks[1].header)

    const result = chain.validateChain()
    expect(result.valid).toBe(false)
    expect(result.error).toContain('coinbase amount')
    expect(result.invalidAtHeight).toBe(1)
  })

  it('detects duplicate transaction IDs within a block', () => {
    const chain = new Blockchain()
    chain.difficulty = TEST_TARGET

    // Build a block with a duplicate txid manually, then mine a valid PoW
    const tip = chain.getChainTip()
    const height = 1
    const coinbase = createCoinbaseTransaction(walletA.address, height, 0)
    // Two copies of the same coinbase → duplicate txid
    const txs = [coinbase, { ...coinbase }]
    const merkleRoot = computeMerkleRoot(txs.map((t) => t.id))

    const header: BlockHeader = {
      version: 1,
      previousHash: tip.hash,
      merkleRoot,
      timestamp: tip.header.timestamp + 1,
      target: TEST_TARGET,
      nonce: 0,
    }

    let hash = computeBlockHash(header)
    while (!hashMeetsTarget(hash, header.target)) {
      header.nonce++
      hash = computeBlockHash(header)
    }

    // Push directly to bypass addBlock validation (which would catch the duplicate)
    chain.blocks.push({ header, hash, transactions: txs, height })
    chain.blocksByHash.set(hash, chain.blocks[1])

    const result = chain.validateChain()
    expect(result.valid).toBe(false)
    expect(result.error).toContain('duplicate transaction ID')
    expect(result.invalidAtHeight).toBe(1)
  })

  it('returns valid for a clean multi-block chain', () => {
    const chain = new Blockchain()
    for (let i = 0; i < 3; i++) {
      chain.addBlock(mineOnChain(chain, walletA.address))
    }
    expect(chain.validateChain().valid).toBe(true)
  })

  it('detects block whose hash does not meet target', () => {
    const chain = new Blockchain()
    const tip = chain.getChainTip()
    const coinbase = createCoinbaseTransaction(walletA.address, 1, 0)
    const IMPOSSIBLE_TARGET = '0'.repeat(64)
    const header: BlockHeader = {
      version: 1,
      previousHash: tip.hash,
      merkleRoot: computeMerkleRoot([coinbase.id]),
      timestamp: tip.header.timestamp + 1,
      target: IMPOSSIBLE_TARGET,
      nonce: 0,
    }
    const hash = computeBlockHash(header)
    // hash is consistent but cannot meet a target of 0
    chain.blocks.push({ header, hash, transactions: [coinbase], height: 1 })
    chain.blocksByHash.set(hash, chain.blocks[1])

    const result = chain.validateChain()
    expect(result.valid).toBe(false)
    expect(result.error).toContain('does not meet target')
    expect(result.invalidAtHeight).toBe(1)
  })

  it('detects previous hash chain break', () => {
    const chain = new Blockchain()
    chain.addBlock(mineOnChain(chain, walletA.address))
    const tip1 = chain.getChainTip()
    const coinbase2 = createCoinbaseTransaction(walletA.address, 2, 0)
    // Use a maximally easy target so any hash passes PoW check
    const TRIVIAL_TARGET = 'f'.repeat(64)
    const header2: BlockHeader = {
      version: 1,
      previousHash: 'aa'.repeat(32), // bogus — does not point to block 1
      merkleRoot: computeMerkleRoot([coinbase2.id]),
      timestamp: tip1.header.timestamp + 1,
      target: TRIVIAL_TARGET,
      nonce: 0,
    }
    const hash2 = computeBlockHash(header2)
    chain.blocks.push({ header: header2, hash: hash2, transactions: [coinbase2], height: 2 })
    chain.blocksByHash.set(hash2, chain.blocks[2])

    const result = chain.validateChain()
    expect(result.valid).toBe(false)
    expect(result.error).toContain('previous hash mismatch')
    expect(result.invalidAtHeight).toBe(2)
  })

  it('detects merkle root mismatch', () => {
    const chain = new Blockchain()
    chain.difficulty = TEST_TARGET
    chain.addBlock(mineOnChain(chain, walletA.address))

    // Tamper a transaction ID in the stored block without updating the header's merkle root
    chain.blocks[1].transactions[0].id = 'dead'.repeat(16)

    const result = chain.validateChain()
    expect(result.valid).toBe(false)
    expect(result.error).toContain('merkle root mismatch')
    expect(result.invalidAtHeight).toBe(1)
  })

  it('detects oversized block during full-chain validation', () => {
    const chain = new Blockchain()
    chain.difficulty = TEST_TARGET
    chain.addBlock(mineOnChain(chain, walletA.address))

    chain.blocks[1].transactions[0].inputs[0].signature = new Uint8Array(MAX_BLOCK_SIZE)

    const result = chain.validateChain()
    expect(result.valid).toBe(false)
    expect(result.error).toContain('size')
    expect(result.error).toContain('exceeds max')
    expect(result.invalidAtHeight).toBe(1)
  })

  it('detects invalid transaction spending non-existent UTXO', () => {
    const chain = new Blockchain()
    chain.difficulty = TEST_TARGET

    // Mine block 1 so the UTXO set is seeded
    chain.addBlock(mineOnChain(chain, walletA.address))
    const tip1 = chain.getChainTip()

    // Build a transaction with an input pointing to a non-existent UTXO
    const fakeTx = {
      id: 'beef'.repeat(16),
      timestamp: Date.now(),
      inputs: [{ txId: 'dead'.repeat(16), outputIndex: 0, publicKey: walletA.publicKey, signature: walletA.publicKey }],
      outputs: [{ address: walletA.address, amount: 1 }],
    }

    // Build a block containing this invalid transaction
    const coinbase2 = createCoinbaseTransaction(walletA.address, 2, 0)
    const txs = [coinbase2, fakeTx as unknown as ReturnType<typeof createCoinbaseTransaction>]
    const merkleRoot2 = computeMerkleRoot(txs.map(t => t.id))
    const header2: BlockHeader = {
      version: 1,
      previousHash: tip1.hash,
      merkleRoot: merkleRoot2,
      timestamp: tip1.header.timestamp + 1,
      target: TEST_TARGET,
      nonce: 0,
    }
    let hash2 = computeBlockHash(header2)
    while (!hashMeetsTarget(hash2, header2.target)) {
      header2.nonce++
      hash2 = computeBlockHash(header2)
    }
    chain.blocks.push({ header: header2, hash: hash2, transactions: txs as Block['transactions'], height: 2 })
    chain.blocksByHash.set(hash2, chain.blocks[2])

    const result = chain.validateChain()
    expect(result.valid).toBe(false)
    expect(result.error).toContain('Block 2')
    expect(result.invalidAtHeight).toBe(2)
  })

  it('detects cross-block double-claim in validateChain', () => {
    const { snapshot, holders } = createMockSnapshot()
    const chain = new Blockchain(snapshot)
    const genesisHash = chain.blocks[0].hash

    const claimTx = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      walletB,
      snapshot.btcBlockHash,
      genesisHash,
    )

    // Mine block 1 with the claim (goes through addBlock, passes validation)
    const block1 = mineOnChain(chain, 'f'.repeat(64), [claimTx])
    chain.addBlock(block1)

    // Build block 2 with the exact same claim — push directly, bypassing addBlock
    const tip1 = chain.getChainTip()
    const coinbase2 = createCoinbaseTransaction('f'.repeat(64), 2, 0)
    const txs2 = [coinbase2, claimTx]
    const merkleRoot2 = computeMerkleRoot(txs2.map(t => t.id))
    const TRIVIAL_TARGET = 'f'.repeat(64)
    const header2: BlockHeader = {
      version: 1,
      previousHash: tip1.hash,
      merkleRoot: merkleRoot2,
      timestamp: tip1.header.timestamp + 1,
      target: TRIVIAL_TARGET,
      nonce: 0,
    }
    const hash2 = computeBlockHash(header2)
    chain.blocks.push({ header: header2, hash: hash2, transactions: txs2, height: 2 })
    chain.blocksByHash.set(hash2, chain.blocks[2])

    const result = chain.validateChain()
    expect(result.valid).toBe(false)
    expect(result.error).toContain('double-claim')
    expect(result.invalidAtHeight).toBe(2)
  })
})
