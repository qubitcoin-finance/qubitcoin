import { describe, it, expect } from 'vitest'
import { Blockchain } from '../chain.js'
import { createCoinbaseTransaction, utxoKey, type UTXO } from '../transaction.js'
import { computeMerkleRoot, computeBlockHash, hashMeetsTarget, type Block, type BlockHeader, DIFFICULTY_ADJUSTMENT_INTERVAL, TARGET_BLOCK_TIME_MS, STARTING_DIFFICULTY } from '../block.js'
import { createMockSnapshot } from '../snapshot.js'
import { createClaimTransaction } from '../claim.js'
import { walletA, walletB } from './fixtures.js'
import { TEST_TARGET, mineOnChain } from './chain-test-helpers.js'

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

  it('indexes the genesis transaction for lookup', () => {
    const chain = new Blockchain()
    const genesisTxId = chain.blocks[0].transactions[0].id

    expect(chain.findTransactionBlock(genesisTxId)).toBe(chain.blocks[0])
  })

  it('accepts valid mined block', () => {
    const chain = new Blockchain()
    const wallet = walletA
    const block = mineOnChain(chain, wallet.address)
    const result = chain.addBlock(block)
    expect(result.success).toBe(true)
    expect(chain.getHeight()).toBe(1)
  })

  it('rejects block with wrong previous hash', () => {
    const chain = new Blockchain()
    const wallet = walletA
    const block = mineOnChain(chain, wallet.address)
    block.header.previousHash = 'deadbeef'.repeat(8)
    // Recompute hash
    block.hash = computeBlockHash(block.header)
    const result = chain.addBlock(block)
    expect(result.success).toBe(false)
  })

  it('tracks balance after mining', () => {
    const chain = new Blockchain()
    const wallet = walletA
    const block = mineOnChain(chain, wallet.address)
    chain.addBlock(block)
    expect(chain.getBalance(wallet.address)).toBe(312_500_000)
  })

  it('findUTXOs returns mined outputs', () => {
    const chain = new Blockchain()
    const wallet = walletA
    const block = mineOnChain(chain, wallet.address)
    chain.addBlock(block)
    const utxos = chain.findUTXOs(wallet.address)
    expect(utxos.length).toBe(1)
    expect(utxos[0].amount).toBe(312_500_000)
  })

  it('validates chain detects tampering', () => {
    const chain = new Blockchain()
    const wallet = walletA
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

  it('preserves genesis transaction lookup after resetToHeight(0)', () => {
    const chain = new Blockchain()
    const genesisTxId = chain.blocks[0].transactions[0].id

    chain.addBlock(mineOnChain(chain, walletA.address))
    chain.resetToHeight(0)

    expect(chain.findTransactionBlock(genesisTxId)).toBe(chain.blocks[0])
  })
})

describe('Difficulty adjustment', () => {
  /**
   * Push a fake block with a controlled timestamp directly onto the chain,
   * bypassing addBlock validation (no PoW needed). For testing adjustment math.
   */
  function pushFakeBlock(chain: Blockchain, timestamp: number): void {
    const tip = chain.getChainTip()
    const height = chain.getHeight() + 1
    const block: Block = {
      header: {
        version: 1,
        previousHash: tip.hash,
        merkleRoot: '0'.repeat(64),
        timestamp,
        target: chain.getDifficulty(),
        nonce: 0,
      },
      hash: 'f'.repeat(64),
      transactions: [],
      height,
    }
    chain.blocks.push(block)
    if (chain.blocks.length % DIFFICULTY_ADJUSTMENT_INTERVAL === 0) {
      chain.difficulty = chain.adjustDifficulty()
    }
  }

  it('adjusts difficulty correctly for fast blocks', () => {
    const chain = new Blockchain()
    const genesisTs = chain.blocks[0].header.timestamp

    // First interval: normal speed, far from genesis
    const baseTs = genesisTs + 100_000_000
    for (let i = 1; i <= DIFFICULTY_ADJUSTMENT_INTERVAL; i++) {
      pushFakeBlock(chain, baseTs + i * TARGET_BLOCK_TIME_MS)
    }

    const diffAfterFirst = chain.getDifficulty()

    // Second interval: blocks at HALF the target time (too fast → harder)
    const secondBaseTs = chain.blocks[chain.blocks.length - 1].header.timestamp
    for (let i = 1; i <= DIFFICULTY_ADJUSTMENT_INTERVAL; i++) {
      pushFakeBlock(chain, secondBaseTs + i * (TARGET_BLOCK_TIME_MS / 2))
    }

    const currentTarget = BigInt('0x' + chain.getDifficulty())
    const prevTarget = BigInt('0x' + diffAfterFirst)
    expect(currentTarget).toBeLessThan(prevTarget)

    // ratio = 0.5 → target halves
    const expectedTarget = prevTarget * 5000n / 10000n
    expect(currentTarget).toBe(expectedTarget)
  })

  it('adjusts difficulty correctly for slow blocks', () => {
    const chain = new Blockchain()
    const genesisTs = chain.blocks[0].header.timestamp

    // First interval: fast blocks so difficulty increases (room to ease later)
    const baseTs = genesisTs + 100_000_000
    for (let i = 1; i <= DIFFICULTY_ADJUSTMENT_INTERVAL; i++) {
      pushFakeBlock(chain, baseTs + i * (TARGET_BLOCK_TIME_MS / 2))
    }

    // Second interval: also fast
    let intervalBase = chain.blocks[chain.blocks.length - 1].header.timestamp
    for (let i = 1; i <= DIFFICULTY_ADJUSTMENT_INTERVAL; i++) {
      pushFakeBlock(chain, intervalBase + i * (TARGET_BLOCK_TIME_MS / 2))
    }

    const diffBeforeSlow = chain.getDifficulty()

    // Third interval: DOUBLE the target time (too slow → easier)
    intervalBase = chain.blocks[chain.blocks.length - 1].header.timestamp
    for (let i = 1; i <= DIFFICULTY_ADJUSTMENT_INTERVAL; i++) {
      pushFakeBlock(chain, intervalBase + i * (TARGET_BLOCK_TIME_MS * 2))
    }

    const currentTarget = BigInt('0x' + chain.getDifficulty())
    const prevTarget = BigInt('0x' + diffBeforeSlow)
    expect(currentTarget).toBeGreaterThan(prevTarget)

    // ratio = 2.0 → target doubles
    const expectedTarget = prevTarget * 20000n / 10000n
    expect(currentTarget).toBe(expectedTarget)
  })

  it('clamps adjustment to 4x in either direction', () => {
    const chain = new Blockchain()
    const genesisTs = chain.blocks[0].header.timestamp

    // First interval: normal speed
    const baseTs = genesisTs + 100_000_000
    for (let i = 1; i <= DIFFICULTY_ADJUSTMENT_INTERVAL; i++) {
      pushFakeBlock(chain, baseTs + i * TARGET_BLOCK_TIME_MS)
    }

    const diffAfterFirst = chain.getDifficulty()

    // Second interval: blocks 10x faster (should clamp to 4x harder)
    const secondBaseTs = chain.blocks[chain.blocks.length - 1].header.timestamp
    for (let i = 1; i <= DIFFICULTY_ADJUSTMENT_INTERVAL; i++) {
      pushFakeBlock(chain, secondBaseTs + i * (TARGET_BLOCK_TIME_MS / 10))
    }

    const currentTarget = BigInt('0x' + chain.getDifficulty())
    const prevTarget = BigInt('0x' + diffAfterFirst)

    // Clamped to 0.25 → target / 4
    const expectedTarget = prevTarget * 2500n / 10000n
    expect(currentTarget).toBe(expectedTarget)
  })

  it('no drift when blocks are exactly at target time', () => {
    const chain = new Blockchain()
    const genesisTs = chain.blocks[0].header.timestamp

    // First interval at normal speed
    const baseTs = genesisTs + 100_000_000
    for (let i = 1; i <= DIFFICULTY_ADJUSTMENT_INTERVAL; i++) {
      pushFakeBlock(chain, baseTs + i * TARGET_BLOCK_TIME_MS)
    }

    const diffAfterFirst = chain.getDifficulty()

    // Several more intervals at exactly target time — difficulty must not drift
    for (let interval = 0; interval < 10; interval++) {
      const intervalBase = chain.blocks[chain.blocks.length - 1].header.timestamp
      for (let i = 1; i <= DIFFICULTY_ADJUSTMENT_INTERVAL; i++) {
        pushFakeBlock(chain, intervalBase + i * TARGET_BLOCK_TIME_MS)
      }
    }

    // Difficulty should NOT change when blocks are exactly at target time
    expect(chain.getDifficulty()).toBe(diffAfterFirst)
  })

  it('replay produces same difficulty as pushFakeBlock path', () => {
    const chain = new Blockchain()
    const genesisTs = chain.blocks[0].header.timestamp

    // Build a chain with varied timestamps across 5 intervals
    const baseTs = genesisTs + 100_000_000
    for (let i = 1; i <= DIFFICULTY_ADJUSTMENT_INTERVAL * 5; i++) {
      const jitter = i % 2 === 0 ? 0.5 : 1.5
      pushFakeBlock(chain, baseTs + i * TARGET_BLOCK_TIME_MS * jitter)
    }

    const liveDifficulty = chain.getDifficulty()

    // Simulate constructor replay path
    const replayChain = new Blockchain()
    for (let i = 1; i < chain.blocks.length; i++) {
      replayChain.blocks.push(chain.blocks[i])
      if (replayChain.blocks.length % DIFFICULTY_ADJUSTMENT_INTERVAL === 0) {
        replayChain.difficulty = replayChain.adjustDifficulty()
      }
    }

    // Both paths must produce identical difficulty
    expect(replayChain.getDifficulty()).toBe(liveDifficulty)
  })
})

describe('Blockchain replaceGenesis', () => {
  it('rejects genesis with invalid PoW (hash mismatch)', () => {
    const chain = new Blockchain()
    const fakeGenesis: Block = {
      header: {
        version: 2,
        previousHash: '0'.repeat(64),
        merkleRoot: 'a'.repeat(64),
        timestamp: 0,
        target: STARTING_DIFFICULTY,
        nonce: 0,
      },
      hash: 'ff'.repeat(32), // invalid hash — doesn't match header
      transactions: [],
      height: 0,
    }
    expect(chain.replaceGenesis(fakeGenesis)).toBe(false)
    // Original genesis should be preserved
    expect(chain.blocks[0].hash).not.toBe(fakeGenesis.hash)
  })

  it('rejects genesis with hash that does not meet target', () => {
    const chain = new Blockchain()
    const impossibleTarget = '0000000000000000000000000000000000000000000000000000000000000001'
    const header: BlockHeader = {
      version: 2,
      previousHash: '0'.repeat(64),
      merkleRoot: 'a'.repeat(64),
      timestamp: 0,
      target: impossibleTarget,
      nonce: 42,
    }
    const hash = computeBlockHash(header)
    const fakeGenesis: Block = { header, hash, transactions: [], height: 0 }
    expect(chain.replaceGenesis(fakeGenesis)).toBe(false)
  })

  it('rejects replaceGenesis when chain has blocks beyond genesis', () => {
    const chain = new Blockchain()
    const block = mineOnChain(chain, walletA.address)
    chain.addBlock(block)

    const validGenesis = chain.blocks[0]
    expect(chain.replaceGenesis(validGenesis)).toBe(false)
  })

  it('rejects replaceGenesis when snapshot is loaded', () => {
    const { snapshot } = createMockSnapshot()
    const chain = new Blockchain(snapshot)
    const genesis = chain.blocks[0]
    expect(chain.replaceGenesis(genesis)).toBe(false)
  })
})

describe('Block height validation in chain', () => {
  it('rejects block with forged height to bypass coinbase maturity', () => {
    const chain = new Blockchain()
    // Mine a block to get a coinbase UTXO
    chain.addBlock(mineOnChain(chain, walletA.address))

    // Try to create a block claiming height 200 (would make coinbase mature)
    // but the actual chain is only at height 1
    const tip = chain.getChainTip()
    const coinbase = createCoinbaseTransaction('f'.repeat(64), 200, 0)
    const txs = [coinbase]
    const merkleRoot = computeMerkleRoot(txs.map(t => t.id))
    const header: BlockHeader = {
      version: 1,
      previousHash: tip.hash,
      merkleRoot,
      timestamp: tip.header.timestamp + 1,
      target: chain.getDifficulty(),
      nonce: 0,
    }
    let hash = computeBlockHash(header)
    while (!hashMeetsTarget(hash, header.target)) {
      header.nonce++
      hash = computeBlockHash(header)
    }
    const block: Block = { header, hash, transactions: txs, height: 200 }
    const result = chain.addBlock(block)
    expect(result.success).toBe(false)
    expect(result.error).toContain('Invalid block height')
  })
})

describe('Blockchain getBlockHash', () => {
  it('returns hash for valid heights', () => {
    const chain = new Blockchain()
    const wallet = walletA
    const block = mineOnChain(chain, wallet.address)
    chain.addBlock(block)

    expect(chain.getBlockHash(0)).toBe(chain.blocks[0].hash)
    expect(chain.getBlockHash(1)).toBe(block.hash)
  })

  it('returns undefined for invalid heights', () => {
    const chain = new Blockchain()
    expect(chain.getBlockHash(-1)).toBeUndefined()
    expect(chain.getBlockHash(1)).toBeUndefined()
  })
})

describe('addBlock edge cases', () => {
  it('rejects block with wrong target (too easy)', () => {
    const chain = new Blockchain()
    chain.difficulty = TEST_TARGET

    const block = mineOnChain(chain, walletA.address)
    // Tamper the target to be easier than current difficulty
    block.header.target = 'f'.repeat(64)
    block.hash = computeBlockHash(block.header)

    const result = chain.addBlock(block)
    expect(result.success).toBe(false)
    expect(result.error).toContain('target mismatch')
  })

  it('rejects claim tx when no snapshot is loaded', () => {
    const chain = new Blockchain() // no snapshot
    chain.difficulty = TEST_TARGET

    // Mine a block to get past genesis
    chain.addBlock(mineOnChain(chain, walletA.address))

    // Create a claim tx
    const { snapshot, holders } = createMockSnapshot()
    const claimTx = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      walletA,
      snapshot.btcBlockHash
    )

    // Try to mine a block with the claim tx
    const tip = chain.getChainTip()
    const height = chain.getHeight() + 1
    const coinbase = createCoinbaseTransaction(walletA.address, height, 0)
    const txs = [coinbase, claimTx]
    const merkleRoot = computeMerkleRoot(txs.map(t => t.id))

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

    const result = chain.addBlock({ header, hash, transactions: txs, height })
    expect(result.success).toBe(false)
    expect(result.error).toContain('No BTC snapshot')
  })

  it('getClaimStats returns zeros when no snapshot', () => {
    const chain = new Blockchain()
    const stats = chain.getClaimStats()
    expect(stats.claimed).toBe(0)
    expect(stats.totalEntries).toBe(0)
    expect(stats.claimedAmount).toBe(0)
  })

  it('findUTXOs with amount returns subset when sufficient', () => {
    // Directly inject multiple UTXOs to test the early-exit logic
    const chain = new Blockchain()
    chain.difficulty = TEST_TARGET
    const addr = 'test_addr_' + 'a'.repeat(54)

    // Manually add 3 UTXOs for the address
    for (let i = 0; i < 3; i++) {
      const key = utxoKey('f'.repeat(63) + i.toString(), 0)
      const utxo: UTXO = { txId: 'f'.repeat(63) + i.toString(), outputIndex: 0, address: addr, amount: 100_000 }
      chain.utxoSet.set(key, utxo)
      // Also update the address index
      if (!chain.utxosByAddress.has(addr)) {
        chain.utxosByAddress.set(addr, new Set())
      }
      chain.utxosByAddress.get(addr)!.add(key)
    }

    const allUtxos = chain.findUTXOs(addr)
    expect(allUtxos.length).toBe(3)

    // With a small amount, should return just 1 UTXO (100_000 >= 1)
    const partial = chain.findUTXOs(addr, 1)
    expect(partial.length).toBe(1)
  })

  it('getState at height 0 returns zero hashrate and avgBlockTime', async () => {
    const { Node } = await import('../node.js')
    const node = new Node('test')
    const state = node.getState()
    expect(state.height).toBe(0)
    expect(state.avgBlockTime).toBe(0)
    expect(state.hashrate).toBe(0)
  })
})
