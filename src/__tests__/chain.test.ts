import { describe, it, expect } from 'vitest'
import { Blockchain } from '../chain.js'
import { createCoinbaseTransaction, createTransaction, COINBASE_MATURITY, validateTransaction, utxoKey, type UTXO } from '../transaction.js'
import { computeMerkleRoot, computeBlockHash, hashMeetsTarget, medianTimestamp, MAX_FUTURE_BLOCK_TIME_MS, type Block, type BlockHeader, DIFFICULTY_ADJUSTMENT_INTERVAL, TARGET_BLOCK_TIME_MS, STARTING_DIFFICULTY } from '../block.js'
import { createMockSnapshot } from '../snapshot.js'
import { createClaimTransaction } from '../claim.js'
import { walletA, walletB } from './fixtures.js'

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
    timestamp: tip.header.timestamp + 1, // always increasing for MTP validation
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
    expect(chain.getBalance(wallet.address)).toBe(3.125)
  })

  it('findUTXOs returns mined outputs', () => {
    const chain = new Blockchain()
    const wallet = walletA
    const block = mineOnChain(chain, wallet.address)
    chain.addBlock(block)
    const utxos = chain.findUTXOs(wallet.address)
    expect(utxos.length).toBe(1)
    expect(utxos[0].amount).toBe(3.125)
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
      chain.difficulty = (chain as any).adjustDifficulty()
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
        replayChain.difficulty = (replayChain as any).adjustDifficulty()
      }
    }

    // Both paths must produce identical difficulty
    expect(replayChain.getDifficulty()).toBe(liveDifficulty)
  })
})

describe('Blockchain resetToHeight', () => {
  it('resets chain to target height and rebuilds UTXO set', () => {
    const chain = new Blockchain()

    // Mine 5 blocks with different wallets so we get distinct UTXOs
    const wallets = [walletA, walletB]
    for (let i = 0; i < 5; i++) {
      const block = mineOnChain(chain, wallets[i % 2].address)
      chain.addBlock(block)
    }
    expect(chain.getHeight()).toBe(5)

    // Record balance at height 2 for walletA (mined blocks 1, 3, 5)
    // walletA mined at i=0 (height 1), i=2 (height 3), i=4 (height 5)
    // walletB mined at i=1 (height 2), i=3 (height 4)

    // Reset to height 2 — only blocks 1 and 2 remain
    chain.resetToHeight(2)
    expect(chain.getHeight()).toBe(2)
    expect(chain.blocks.length).toBe(3) // genesis + 2 blocks
    // walletA mined block 1, walletB mined block 2
    expect(chain.getBalance(walletA.address)).toBe(3.125) // 1 coinbase reward
    expect(chain.getBalance(walletB.address)).toBe(3.125)
  })

  it('preserves correct balances after reset', () => {
    const chain = new Blockchain()
    const wallet = walletA

    // Mine 3 blocks
    for (let i = 0; i < 3; i++) {
      const block = mineOnChain(chain, wallet.address)
      chain.addBlock(block)
    }

    const balance3 = chain.getBalance(wallet.address)

    // Mine 2 more
    for (let i = 0; i < 2; i++) {
      const block = mineOnChain(chain, wallet.address)
      chain.addBlock(block)
    }
    expect(chain.getHeight()).toBe(5)

    // Reset to height 3 — should have same balance as when we were at height 3
    chain.resetToHeight(3)
    expect(chain.getBalance(wallet.address)).toBe(balance3)
  })

  it('reset to height 0 leaves only genesis', () => {
    const chain = new Blockchain()
    const wallet = walletA

    for (let i = 0; i < 3; i++) {
      const block = mineOnChain(chain, wallet.address)
      chain.addBlock(block)
    }

    chain.resetToHeight(0)
    expect(chain.getHeight()).toBe(0)
    expect(chain.blocks.length).toBe(1)
    expect(chain.utxoSet.size).toBe(0)
  })

  it('can add new blocks after reset', () => {
    const chain = new Blockchain()
    const wallet = walletA

    for (let i = 0; i < 5; i++) {
      const block = mineOnChain(chain, wallet.address)
      chain.addBlock(block)
    }

    chain.resetToHeight(2)

    // Should be able to mine new blocks from height 2
    const newBlock = mineOnChain(chain, wallet.address)
    const result = chain.addBlock(newBlock)
    expect(result.success).toBe(true)
    expect(chain.getHeight()).toBe(3)
  })

  it('throws on invalid target height', () => {
    const chain = new Blockchain()
    expect(() => chain.resetToHeight(-1)).toThrow('Invalid target height')
    expect(() => chain.resetToHeight(5)).toThrow('Invalid target height')
  })
})

describe('Blockchain undo data', () => {
  it('populates undoData for each non-genesis block', () => {
    const chain = new Blockchain()
    expect(chain.undoData.length).toBe(0) // genesis has no undo data

    for (let i = 0; i < 3; i++) {
      const block = mineOnChain(chain, walletA.address)
      chain.addBlock(block)
    }

    // undoData[i] corresponds to blocks[i+1]
    expect(chain.undoData.length).toBe(3)
    expect(chain.undoData[0].createdUtxoKeys.length).toBeGreaterThan(0)
    expect(chain.undoData[0].previousDifficulty).toBe(TEST_TARGET)
  })

  it('resetToHeight uses fast disconnect path and preserves state', () => {
    const chain = new Blockchain()
    const wallets = [walletA, walletB]
    const numBlocks = 5

    for (let i = 0; i < numBlocks; i++) {
      const block = mineOnChain(chain, wallets[i % 2].address)
      chain.addBlock(block)
    }

    // Snapshot state at height 2 via a separate full-replay chain
    const refChain = new Blockchain()
    for (let i = 0; i < 2; i++) {
      const block = mineOnChain(refChain, wallets[i % 2].address)
      refChain.addBlock(block)
    }

    // Reset using undo data (fast path — undoData.length === currentHeight)
    expect(chain.undoData.length).toBe(numBlocks) // confirms fast path eligibility
    chain.resetToHeight(2)

    expect(chain.getHeight()).toBe(2)
    expect(chain.undoData.length).toBe(2) // undo data trimmed to match
    expect(chain.getBalance(walletA.address)).toBe(refChain.getBalance(walletA.address))
    expect(chain.getBalance(walletB.address)).toBe(refChain.getBalance(walletB.address))
    expect(chain.utxoSet.size).toBe(refChain.utxoSet.size)
  })

  it('resetToHeight(0) clears undo data', () => {
    const chain = new Blockchain()

    for (let i = 0; i < 3; i++) {
      const block = mineOnChain(chain, walletA.address)
      chain.addBlock(block)
    }

    chain.resetToHeight(0)
    expect(chain.undoData.length).toBe(0)
    expect(chain.utxoSet.size).toBe(0)
  })

  it('undo restores spent UTXOs from transactions', () => {
    const chain = new Blockchain()

    // Mine a block to get a UTXO for walletA
    const block1 = mineOnChain(chain, walletA.address)
    chain.addBlock(block1)

    // Mine 100 more blocks to mature the coinbase
    for (let i = 0; i < COINBASE_MATURITY; i++) {
      chain.addBlock(mineOnChain(chain, 'f'.repeat(64)))
    }

    const utxosBefore = chain.findUTXOs(walletA.address)
    expect(utxosBefore.length).toBe(1)

    // Spend walletA's UTXO → walletB
    const spendHeight = chain.getHeight() + 1
    const tx = createTransaction(walletA, utxosBefore, [{ address: walletB.address, amount: 2 }], 0.125)
    const block2 = mineOnChain(chain, walletB.address, [tx])
    chain.addBlock(block2)

    // walletA spent its UTXO, only has change
    expect(chain.getBalance(walletA.address)).toBe(1) // 3.125 - 2 - 0.125 = 1
    expect(chain.getBalance(walletB.address)).toBe(3.125 + 2) // coinbase + transfer

    // Disconnect the spending block via resetToHeight
    chain.resetToHeight(spendHeight - 1)

    // walletA's original UTXO should be restored
    expect(chain.getBalance(walletA.address)).toBe(3.125)
    expect(chain.getBalance(walletB.address)).toBe(0)
  })

  it('undo reverses claim transactions', () => {
    const { snapshot, holders } = createMockSnapshot()
    const chain = new Blockchain(snapshot)
    const qbtcWallet = walletB

    // Mine a block with a claim
    const claimTx = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      qbtcWallet,
      snapshot.btcBlockHash
    )
    const block = mineOnChain(chain, 'f'.repeat(64), [claimTx])
    chain.addBlock(block)

    expect(chain.isClaimed(holders[0].address)).toBe(true)
    expect(chain.getBalance(qbtcWallet.address)).toBe(holders[0].amount)

    // Disconnect
    chain.resetToHeight(0)
    expect(chain.isClaimed(holders[0].address)).toBe(false)
    expect(chain.getBalance(qbtcWallet.address)).toBe(0)

    // Should be able to re-claim after undo
    const claimTx2 = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      qbtcWallet,
      snapshot.btcBlockHash
    )
    const block2 = mineOnChain(chain, 'f'.repeat(64), [claimTx2])
    const result = chain.addBlock(block2)
    expect(result.success).toBe(true)
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
    const qbtcWallet = walletB

    // Create and include claim in a block
    const claimTx = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      qbtcWallet,
      snapshot.btcBlockHash
    )

    const block = mineOnChain(chain, 'f'.repeat(64), [claimTx])
    const result = chain.addBlock(block)
    expect(result.success).toBe(true)
    expect(chain.getBalance(qbtcWallet.address)).toBe(holders[0].amount)
  })

  it('rejects double-claim', () => {
    const { snapshot, holders } = createMockSnapshot()
    const chain = new Blockchain(snapshot)
    const qbtcWallet = walletB

    const claimTx = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      qbtcWallet,
      snapshot.btcBlockHash
    )

    const block1 = mineOnChain(chain, 'f'.repeat(64), [claimTx])
    chain.addBlock(block1)

    // Try to claim same UTXO again
    const claimTx2 = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      qbtcWallet,
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
    expect(stats.totalEntries).toBe(9) // 5 P2PKH/P2WPKH + 1 P2SH-P2WPKH + 1 P2SH multisig + 1 P2TR + 1 P2WSH
    expect(stats.claimed).toBe(0)

    const qbtcWallet = walletB
    const claimTx = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      qbtcWallet,
      snapshot.btcBlockHash
    )
    const block = mineOnChain(chain, 'f'.repeat(64), [claimTx])
    chain.addBlock(block)

    stats = chain.getClaimStats()
    expect(stats.claimed).toBe(1)
    expect(stats.claimedAmount).toBe(holders[0].amount)
    expect(stats.unclaimed).toBe(8)
  })
})

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
    const tx = createTransaction(walletA, utxos, [{ address: walletB.address, amount: 2 }], 0.125)
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
    const tx = createTransaction(walletA, utxos, [{ address: walletB.address, amount: 2 }], 0.125)
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
    const tx = createTransaction(walletA, utxos, [{ address: walletB.address, amount: 2 }], 0.125)
    chain.addBlock(mineOnChain(chain, 'f'.repeat(64), [tx]))

    // walletB can spend immediately (non-coinbase, no maturity required)
    const utxosB = chain.findUTXOs(walletB.address)
    expect(utxosB.length).toBe(1)
    expect(utxosB[0].isCoinbase).toBeUndefined() // not a coinbase
    const tx2 = createTransaction(walletB, utxosB, [{ address: walletA.address, amount: 1 }], 0.5)
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
    const tx = createTransaction(walletA, utxos, [{ address: walletB.address, amount: 2 }], 0.125)
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
