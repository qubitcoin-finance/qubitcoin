import { describe, it, expect } from 'vitest'
import { Blockchain } from '../chain.js'
import { createCoinbaseTransaction, createTransaction, utxoKey } from '../transaction.js'
import { generateWallet } from '../crypto.js'
import { computeMerkleRoot, computeBlockHash, hashMeetsTarget, type Block, type BlockHeader, DIFFICULTY_ADJUSTMENT_INTERVAL, TARGET_BLOCK_TIME_MS, STARTING_DIFFICULTY } from '../block.js'
import { createMockSnapshot } from '../snapshot.js'
import { createClaimTransaction } from '../claim.js'

// Easy target for tests: ~16 attempts to find valid hash
const TEST_TARGET = '0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

function mineOnChain(chain: Blockchain, minerAddress: string, extraTxs: any[] = []): Block {
  chain.difficulty = TEST_TARGET
  const tip = chain.getChainTip()
  const height = chain.getHeight() + 1
  const coinbase = createCoinbaseTransaction(minerAddress, height, 0)
  const txs = [coinbase, ...extraTxs]
  const merkleRoot = computeMerkleRoot(txs.map((t) => t.id))
  const target = chain.getDifficulty()

  const header: BlockHeader = {
    version: 1,
    previousHash: tip.hash,
    merkleRoot,
    timestamp: Date.now(),
    target,
    nonce: 0,
  }

  let hash = computeBlockHash(header)
  while (!hashMeetsTarget(hash, header.target)) {
    header.nonce++
    hash = computeBlockHash(header)
  }

  return { header, hash, transactions: txs, height }
}

describe('Blockchain', () => {
  it('starts with genesis block', () => {
    const chain = new Blockchain()
    expect(chain.getHeight()).toBe(0)
    expect(chain.blocks.length).toBe(1)
  })

  it('starts with empty UTXO set', () => {
    const chain = new Blockchain()
    expect(chain.utxoSet.size).toBe(0) // genesis coinbase is burn
  })

  it('accepts valid mined block', () => {
    const chain = new Blockchain()
    const wallet = generateWallet()
    const block = mineOnChain(chain, wallet.address)
    const result = chain.addBlock(block)
    expect(result.success).toBe(true)
    expect(chain.getHeight()).toBe(1)
  })

  it('rejects block with wrong previous hash', () => {
    const chain = new Blockchain()
    const wallet = generateWallet()
    const block = mineOnChain(chain, wallet.address)
    block.header.previousHash = 'deadbeef'.repeat(8)
    // Recompute hash
    block.hash = computeBlockHash(block.header)
    const result = chain.addBlock(block)
    expect(result.success).toBe(false)
  })

  it('tracks balance after mining', () => {
    const chain = new Blockchain()
    const wallet = generateWallet()
    const block = mineOnChain(chain, wallet.address)
    chain.addBlock(block)
    expect(chain.getBalance(wallet.address)).toBe(3.125)
  })

  it('findUTXOs returns mined outputs', () => {
    const chain = new Blockchain()
    const wallet = generateWallet()
    const block = mineOnChain(chain, wallet.address)
    chain.addBlock(block)
    const utxos = chain.findUTXOs(wallet.address)
    expect(utxos.length).toBe(1)
    expect(utxos[0].amount).toBe(3.125)
  })

  it('validates chain detects tampering', () => {
    const chain = new Blockchain()
    const wallet = generateWallet()
    const block = mineOnChain(chain, wallet.address)
    chain.addBlock(block)

    expect(chain.validateChain().valid).toBe(true)

    // Tamper
    chain.blocks[1].hash = 'ff'.repeat(32)
    expect(chain.validateChain().valid).toBe(false)

    // Restore
    chain.blocks[1].hash = computeBlockHash(chain.blocks[1].header)
    expect(chain.validateChain().valid).toBe(true)
  })
})

describe('Difficulty adjustment', () => {
  /**
   * Mine a block with a controlled timestamp.
   * Does NOT touch chain.difficulty — uses whatever the chain has.
   * Set chain.difficulty = TEST_TARGET once at test start for fast PoW.
   */
  function mineWithTimestamp(chain: Blockchain, minerAddress: string, timestamp: number): Block {
    const tip = chain.getChainTip()
    const height = chain.getHeight() + 1
    const coinbase = createCoinbaseTransaction(minerAddress, height, 0)
    const txs = [coinbase]
    const merkleRoot = computeMerkleRoot(txs.map((t) => t.id))
    const target = chain.getDifficulty()

    const header: BlockHeader = {
      version: 1,
      previousHash: tip.hash,
      merkleRoot,
      timestamp,
      target,
      nonce: 0,
    }

    let hash = computeBlockHash(header)
    while (!hashMeetsTarget(hash, header.target)) {
      header.nonce++
      hash = computeBlockHash(header)
    }

    return { header, hash, transactions: txs, height }
  }

  it('adjusts difficulty correctly for fast blocks', () => {
    const chain = new Blockchain()
    chain.difficulty = TEST_TARGET // easy start for fast PoW in tests
    const wallet = generateWallet()
    const genesisTs = chain.blocks[0].header.timestamp

    // First interval: normal speed, far from genesis to avoid genesis timestamp issues
    const baseTs = genesisTs + 100_000_000
    for (let i = 1; i <= DIFFICULTY_ADJUSTMENT_INTERVAL; i++) {
      const block = mineWithTimestamp(chain, wallet.address, baseTs + i * TARGET_BLOCK_TIME_MS)
      chain.addBlock(block)
    }

    const diffAfterFirst = chain.getDifficulty()

    // Second interval: blocks at HALF the target time (too fast → should get harder)
    const secondBaseTs = chain.getChainTip().header.timestamp
    for (let i = 1; i <= DIFFICULTY_ADJUSTMENT_INTERVAL; i++) {
      const block = mineWithTimestamp(chain, wallet.address, secondBaseTs + i * (TARGET_BLOCK_TIME_MS / 2))
      chain.addBlock(block)
    }

    const currentTarget = BigInt('0x' + chain.getDifficulty())
    const prevTarget = BigInt('0x' + diffAfterFirst)
    expect(currentTarget).toBeLessThan(prevTarget)

    // With half target time: ratio = 0.5 → target halves
    const expectedTarget = prevTarget * 5000n / 10000n
    expect(currentTarget).toBe(expectedTarget)
  })

  it('adjusts difficulty correctly for slow blocks', () => {
    const chain = new Blockchain()
    chain.difficulty = TEST_TARGET
    const wallet = generateWallet()
    const genesisTs = chain.blocks[0].header.timestamp

    // First interval at normal speed
    const baseTs = genesisTs + 100_000_000
    for (let i = 1; i <= DIFFICULTY_ADJUSTMENT_INTERVAL; i++) {
      const block = mineWithTimestamp(chain, wallet.address, baseTs + i * TARGET_BLOCK_TIME_MS)
      chain.addBlock(block)
    }

    // Second interval: fast blocks → difficulty increases (makes room to ease later)
    let intervalBase = chain.getChainTip().header.timestamp
    for (let i = 1; i <= DIFFICULTY_ADJUSTMENT_INTERVAL; i++) {
      const block = mineWithTimestamp(chain, wallet.address, intervalBase + i * (TARGET_BLOCK_TIME_MS / 2))
      chain.addBlock(block)
    }

    const diffBeforeSlow = chain.getDifficulty()

    // Third interval: blocks at DOUBLE the target time (too slow → should get easier)
    intervalBase = chain.getChainTip().header.timestamp
    for (let i = 1; i <= DIFFICULTY_ADJUSTMENT_INTERVAL; i++) {
      const block = mineWithTimestamp(chain, wallet.address, intervalBase + i * (TARGET_BLOCK_TIME_MS * 2))
      chain.addBlock(block)
    }

    const currentTarget = BigInt('0x' + chain.getDifficulty())
    const prevTarget = BigInt('0x' + diffBeforeSlow)
    expect(currentTarget).toBeGreaterThan(prevTarget)

    // With double target time: ratio = 2.0 → target doubles
    const expectedTarget = prevTarget * 20000n / 10000n
    expect(currentTarget).toBe(expectedTarget)
  })

  it('clamps adjustment to 4x in either direction', () => {
    const chain = new Blockchain()
    chain.difficulty = TEST_TARGET
    const wallet = generateWallet()
    const genesisTs = chain.blocks[0].header.timestamp

    // First interval at normal speed
    const baseTs = genesisTs + 100_000_000
    for (let i = 1; i <= DIFFICULTY_ADJUSTMENT_INTERVAL; i++) {
      const block = mineWithTimestamp(chain, wallet.address, baseTs + i * TARGET_BLOCK_TIME_MS)
      chain.addBlock(block)
    }

    const diffAfterFirst = chain.getDifficulty()

    // Second interval: blocks 10x faster (should clamp to 4x harder)
    const secondBaseTs = chain.getChainTip().header.timestamp
    for (let i = 1; i <= DIFFICULTY_ADJUSTMENT_INTERVAL; i++) {
      const block = mineWithTimestamp(chain, wallet.address, secondBaseTs + i * (TARGET_BLOCK_TIME_MS / 10))
      chain.addBlock(block)
    }

    const currentTarget = BigInt('0x' + chain.getDifficulty())
    const prevTarget = BigInt('0x' + diffAfterFirst)

    // Clamped to 0.25 → target / 4
    const expectedTarget = prevTarget * 2500n / 10000n
    expect(currentTarget).toBe(expectedTarget)
  })

  it('no drift when blocks are exactly at target time', () => {
    const chain = new Blockchain()
    chain.difficulty = TEST_TARGET
    const wallet = generateWallet()
    const genesisTs = chain.blocks[0].header.timestamp

    // First interval at normal speed
    const baseTs = genesisTs + 100_000_000
    for (let i = 1; i <= DIFFICULTY_ADJUSTMENT_INTERVAL; i++) {
      const block = mineWithTimestamp(chain, wallet.address, baseTs + i * TARGET_BLOCK_TIME_MS)
      chain.addBlock(block)
    }

    const diffAfterFirst = chain.getDifficulty()

    // Several more intervals at exactly target time — difficulty must not drift
    for (let interval = 0; interval < 5; interval++) {
      const intervalBase = chain.getChainTip().header.timestamp
      for (let i = 1; i <= DIFFICULTY_ADJUSTMENT_INTERVAL; i++) {
        const block = mineWithTimestamp(chain, wallet.address, intervalBase + i * TARGET_BLOCK_TIME_MS)
        chain.addBlock(block)
      }
    }

    // Difficulty should NOT change when blocks are exactly at target time
    expect(chain.getDifficulty()).toBe(diffAfterFirst)
  })

  it('replay produces same difficulty as addBlock path', () => {
    const chain = new Blockchain()
    chain.difficulty = TEST_TARGET
    const wallet = generateWallet()
    const genesisTs = chain.blocks[0].header.timestamp

    // Mine blocks with varied timestamps across 3 intervals
    const baseTs = genesisTs + 100_000_000
    for (let i = 1; i <= DIFFICULTY_ADJUSTMENT_INTERVAL * 3; i++) {
      const jitter = i % 2 === 0 ? 0.5 : 1.5
      const block = mineWithTimestamp(chain, wallet.address, baseTs + i * TARGET_BLOCK_TIME_MS * jitter)
      chain.addBlock(block)
    }

    const liveDifficulty = chain.getDifficulty()

    // Simulate replay path (same as constructor does from storage)
    const replayChain = new Blockchain()
    for (let i = 1; i < chain.blocks.length; i++) {
      replayChain.applyBlock(chain.blocks[i])
      replayChain.blocks.push(chain.blocks[i])
      if (replayChain.blocks.length % DIFFICULTY_ADJUSTMENT_INTERVAL === 0) {
        replayChain.difficulty = (replayChain as any).adjustDifficulty()
      }
    }

    // Both paths must produce identical difficulty
    expect(replayChain.getDifficulty()).toBe(liveDifficulty)
  })
})

describe('Blockchain with snapshot', () => {
  it('creates fork genesis when given snapshot', () => {
    const { snapshot } = createMockSnapshot()
    const chain = new Blockchain(snapshot)
    expect(chain.getHeight()).toBe(0)
    expect(chain.blocks[0].header.version).toBe(2)
    expect(chain.btcSnapshot).toBe(snapshot)
  })

  it('processes claim transactions', () => {
    const { snapshot, holders } = createMockSnapshot()
    const chain = new Blockchain(snapshot)
    const qtcWallet = generateWallet()

    // Create and include claim in a block
    const claimTx = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      qtcWallet,
      snapshot.btcBlockHash
    )

    const block = mineOnChain(chain, 'f'.repeat(64), [claimTx])
    const result = chain.addBlock(block)
    expect(result.success).toBe(true)
    expect(chain.getBalance(qtcWallet.address)).toBe(holders[0].amount)
  })

  it('rejects double-claim', () => {
    const { snapshot, holders } = createMockSnapshot()
    const chain = new Blockchain(snapshot)
    const qtcWallet = generateWallet()

    const claimTx = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      qtcWallet,
      snapshot.btcBlockHash
    )

    const block1 = mineOnChain(chain, 'f'.repeat(64), [claimTx])
    chain.addBlock(block1)

    // Try to claim same UTXO again
    const claimTx2 = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      qtcWallet,
      snapshot.btcBlockHash
    )

    const block2 = mineOnChain(chain, 'f'.repeat(64), [claimTx2])
    const result = chain.addBlock(block2)
    expect(result.success).toBe(false)
    expect(result.error).toContain('already claimed')
  })

  it('tracks claim statistics', () => {
    const { snapshot, holders } = createMockSnapshot()
    const chain = new Blockchain(snapshot)

    let stats = chain.getClaimStats()
    expect(stats.totalEntries).toBe(5)
    expect(stats.claimed).toBe(0)

    const qtcWallet = generateWallet()
    const claimTx = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      qtcWallet,
      snapshot.btcBlockHash
    )
    const block = mineOnChain(chain, 'f'.repeat(64), [claimTx])
    chain.addBlock(block)

    stats = chain.getClaimStats()
    expect(stats.claimed).toBe(1)
    expect(stats.claimedAmount).toBe(holders[0].amount)
    expect(stats.unclaimed).toBe(4)
  })
})
