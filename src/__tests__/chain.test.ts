import { describe, it, expect } from 'vitest'
import { Blockchain, MAX_REORG_DEPTH } from '../chain.js'
import { createCoinbaseTransaction, createTransaction, COINBASE_MATURITY, validateTransaction, utxoKey, type Transaction, type UTXO } from '../transaction.js'
import { computeMerkleRoot, computeBlockHash, hashMeetsTarget, medianTimestamp, MAX_FUTURE_BLOCK_TIME_MS, MAX_BLOCK_SIZE, type Block, type BlockHeader, DIFFICULTY_ADJUSTMENT_INTERVAL, TARGET_BLOCK_TIME_MS, STARTING_DIFFICULTY } from '../block.js'
import { createMockSnapshot } from '../snapshot.js'
import { createClaimTransaction, createP2wshClaimTransaction, createP2shMultisigClaimTransaction } from '../claim.js'
import { walletA, walletB } from './fixtures.js'

// Easy target for tests: ~16 attempts to find valid hash
const TEST_TARGET = '0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

function mineOnChain(chain: Blockchain, minerAddress: string, extraTxs: Transaction[] = []): Block {
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
    expect(chain.getBalance(walletA.address)).toBe(312_500_000) // 1 coinbase reward
    expect(chain.getBalance(walletB.address)).toBe(312_500_000)
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
    const tx = createTransaction(walletA, utxosBefore, [{ address: walletB.address, amount: 200_000_000 }], 12_500_000)
    const block2 = mineOnChain(chain, walletB.address, [tx])
    chain.addBlock(block2)

    // walletA spent its UTXO, only has change
    expect(chain.getBalance(walletA.address)).toBe(100_000_000) // 312500000 - 200000000 - 12500000 = 100000000
    expect(chain.getBalance(walletB.address)).toBe(312_500_000 + 200_000_000) // coinbase + transfer

    // Disconnect the spending block via resetToHeight
    chain.resetToHeight(spendHeight - 1)

    // walletA's original UTXO should be restored
    expect(chain.getBalance(walletA.address)).toBe(312_500_000)
    expect(chain.getBalance(walletB.address)).toBe(0)
  })

  it('undo reverses claim transactions', () => {
    const { snapshot, holders } = createMockSnapshot()
    const chain = new Blockchain(snapshot)
    const genesisHash = chain.blocks[0].hash
    const qbtcWallet = walletB

    // Mine a block with a claim
    const claimTx = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      qbtcWallet,
      snapshot.btcBlockHash,
      genesisHash
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
      snapshot.btcBlockHash,
      genesisHash
    )
    const block2 = mineOnChain(chain, 'f'.repeat(64), [claimTx2])
    const result = chain.addBlock(block2)
    expect(result.success).toBe(true)
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
    const genesisHash = chain.blocks[0].hash
    const qbtcWallet = walletB

    // Create and include claim in a block
    const claimTx = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      qbtcWallet,
      snapshot.btcBlockHash,
      genesisHash
    )

    const block = mineOnChain(chain, 'f'.repeat(64), [claimTx])
    const result = chain.addBlock(block)
    expect(result.success).toBe(true)
    expect(chain.getBalance(qbtcWallet.address)).toBe(holders[0].amount)
  })

  it('rejects double-claim', () => {
    const { snapshot, holders } = createMockSnapshot()
    const chain = new Blockchain(snapshot)
    const genesisHash = chain.blocks[0].hash
    const qbtcWallet = walletB

    const claimTx = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      qbtcWallet,
      snapshot.btcBlockHash,
      genesisHash
    )

    const block1 = mineOnChain(chain, 'f'.repeat(64), [claimTx])
    chain.addBlock(block1)

    // Try to claim same UTXO again
    const claimTx2 = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      qbtcWallet,
      snapshot.btcBlockHash,
      genesisHash
    )

    const block2 = mineOnChain(chain, 'f'.repeat(64), [claimTx2])
    const result = chain.addBlock(block2)
    expect(result.success).toBe(false)
    expect(result.error).toContain('already claimed')
  })

  it('tracks claim statistics', () => {
    const { snapshot, holders } = createMockSnapshot()
    const chain = new Blockchain(snapshot)
    const genesisHash = chain.blocks[0].hash

    let stats = chain.getClaimStats()
    expect(stats.totalEntries).toBe(9) // 5 P2PKH/P2WPKH + 1 P2SH-P2WPKH + 1 P2SH multisig + 1 P2TR + 1 P2WSH
    expect(stats.claimed).toBe(0)

    const qbtcWallet = walletB
    const claimTx = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      qbtcWallet,
      snapshot.btcBlockHash,
      genesisHash
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

describe('Undo data pruning', () => {
  it('prunes undo data to MAX_REORG_DEPTH', () => {
    const chain = new Blockchain()
    const numBlocks = MAX_REORG_DEPTH + 20

    for (let i = 0; i < numBlocks; i++) {
      const block = mineOnChain(chain, walletA.address)
      chain.addBlock(block)
    }

    // Undo data should be capped at MAX_REORG_DEPTH
    expect(chain.undoData.length).toBe(MAX_REORG_DEPTH)
    expect(chain.getHeight()).toBe(numBlocks)
  })

  it('shallow reorg still works after pruning', () => {
    const chain = new Blockchain()
    const numBlocks = MAX_REORG_DEPTH + 10

    for (let i = 0; i < numBlocks; i++) {
      chain.addBlock(mineOnChain(chain, walletA.address))
    }

    const heightBefore = chain.getHeight()
    // Reset by 5 blocks (within MAX_REORG_DEPTH)
    // This will take slow path since undoData.length !== currentHeight after pruning
    chain.resetToHeight(heightBefore - 5)
    expect(chain.getHeight()).toBe(heightBefore - 5)
  })

  it('deep reorg falls back to full replay after pruning', () => {
    const chain = new Blockchain()
    const numBlocks = MAX_REORG_DEPTH + 10

    for (let i = 0; i < numBlocks; i++) {
      chain.addBlock(mineOnChain(chain, walletA.address))
    }

    // Reset to height 1 (deeper than MAX_REORG_DEPTH) — falls back to slow replay
    chain.resetToHeight(1)
    expect(chain.getHeight()).toBe(1)
    expect(chain.undoData.length).toBe(1)
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

describe('Blockchain getClaimableEntries / getUnclaimedValue', () => {
  it('returns empty array and zero when no snapshot is loaded', () => {
    const chain = new Blockchain()
    expect(chain.getClaimableEntries()).toEqual([])
    expect(chain.getUnclaimedValue()).toBe(0)
  })

  it('returns all entries and total value before any claims', () => {
    const { snapshot } = createMockSnapshot()
    const chain = new Blockchain(snapshot)

    const entries = chain.getClaimableEntries()
    expect(entries.length).toBe(snapshot.entries.length)
    const total = snapshot.entries.reduce((s, e) => s + e.amount, 0)
    expect(chain.getUnclaimedValue()).toBe(total)
  })

  it('excludes claimed entries after a claim is mined', () => {
    const { snapshot, holders } = createMockSnapshot()
    const chain = new Blockchain(snapshot)
    const genesisHash = chain.blocks[0].hash

    const claimTx = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      walletB,
      snapshot.btcBlockHash,
      genesisHash
    )
    chain.addBlock(mineOnChain(chain, 'f'.repeat(64), [claimTx]))

    const entries = chain.getClaimableEntries()
    expect(entries.length).toBe(snapshot.entries.length - 1)
    expect(entries.find(e => e.btcAddress === snapshot.entries[0].btcAddress)).toBeUndefined()

    const expectedUnclaimed = snapshot.entries.reduce((s, e) => s + e.amount, 0) - holders[0].amount
    expect(chain.getUnclaimedValue()).toBe(expectedUnclaimed)
  })

  it('restores claimed entry after chain rollback', () => {
    const { snapshot, holders } = createMockSnapshot()
    const chain = new Blockchain(snapshot)
    const genesisHash = chain.blocks[0].hash

    const claimTx = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      walletB,
      snapshot.btcBlockHash,
      genesisHash
    )
    chain.addBlock(mineOnChain(chain, 'f'.repeat(64), [claimTx]))
    expect(chain.getClaimableEntries().length).toBe(snapshot.entries.length - 1)

    chain.resetToHeight(0)
    expect(chain.getClaimableEntries().length).toBe(snapshot.entries.length)
    const total = snapshot.entries.reduce((s, e) => s + e.amount, 0)
    expect(chain.getUnclaimedValue()).toBe(total)
  })

  it('excludes P2SH-P2WPKH entry after claim is mined', () => {
    const { snapshot, holders } = createMockSnapshot()
    const chain = new Blockchain(snapshot)
    const genesisHash = chain.blocks[0].hash

    const p2shHolder = holders.find(h => h.type === 'p2sh' && !h.signerKeys)!
    const p2shEntry = snapshot.entries.find(e => e.type === 'p2sh' && e.btcAddress === p2shHolder.address)!

    const claimTx = createClaimTransaction(
      p2shHolder.secretKey,
      p2shHolder.publicKey,
      p2shEntry,
      walletA,
      snapshot.btcBlockHash,
      genesisHash
    )
    chain.addBlock(mineOnChain(chain, 'f'.repeat(64), [claimTx]))

    const entries = chain.getClaimableEntries()
    expect(entries.find(e => e.btcAddress === p2shEntry.btcAddress)).toBeUndefined()
    expect(entries.length).toBe(snapshot.entries.length - 1)
    expect(chain.isClaimed(p2shEntry.btcAddress)).toBe(true)
  })

  it('excludes P2TR entry after claim is mined', () => {
    const { snapshot, holders } = createMockSnapshot()
    const chain = new Blockchain(snapshot)
    const genesisHash = chain.blocks[0].hash

    const p2trHolder = holders.find(h => h.type === 'p2tr')!
    const p2trEntry = snapshot.entries.find(e => e.type === 'p2tr')!

    const claimTx = createClaimTransaction(
      p2trHolder.secretKey,
      p2trHolder.publicKey,
      p2trEntry,
      walletA,
      snapshot.btcBlockHash,
      genesisHash
    )
    chain.addBlock(mineOnChain(chain, 'f'.repeat(64), [claimTx]))

    const entries = chain.getClaimableEntries()
    expect(entries.find(e => e.btcAddress === p2trEntry.btcAddress)).toBeUndefined()
    expect(entries.length).toBe(snapshot.entries.length - 1)
    expect(chain.isClaimed(p2trEntry.btcAddress)).toBe(true)
  })

  it('excludes P2WSH entry after claim is mined', () => {
    const { snapshot, holders } = createMockSnapshot()
    const chain = new Blockchain(snapshot)
    const genesisHash = chain.blocks[0].hash

    const p2wshHolder = holders.find(h => h.type === 'p2wsh')!
    const p2wshEntry = snapshot.entries.find(e => e.type === 'p2wsh')!

    const claimTx = createP2wshClaimTransaction(
      [p2wshHolder.signerKeys![0].secretKey, p2wshHolder.signerKeys![1].secretKey],
      p2wshHolder.witnessScript!,
      p2wshEntry,
      walletA,
      snapshot.btcBlockHash,
      genesisHash
    )
    chain.addBlock(mineOnChain(chain, 'f'.repeat(64), [claimTx]))

    const entries = chain.getClaimableEntries()
    expect(entries.find(e => e.btcAddress === p2wshEntry.btcAddress)).toBeUndefined()
    expect(entries.length).toBe(snapshot.entries.length - 1)
    expect(chain.isClaimed(p2wshEntry.btcAddress)).toBe(true)
  })

  it('excludes P2SH multisig entry after claim is mined', () => {
    const { snapshot, holders } = createMockSnapshot()
    const chain = new Blockchain(snapshot)
    const genesisHash = chain.blocks[0].hash

    const p2shMultisigHolder = holders.find(h => h.type === 'p2sh' && h.signerKeys)!
    const p2shMultisigEntry = snapshot.entries.find(e =>
      e.type === 'p2sh' && e.btcAddress === p2shMultisigHolder.address
    )!

    const claimTx = createP2shMultisigClaimTransaction(
      [p2shMultisigHolder.signerKeys![0].secretKey, p2shMultisigHolder.signerKeys![1].secretKey],
      p2shMultisigHolder.witnessScript!,
      p2shMultisigEntry,
      walletA,
      snapshot.btcBlockHash,
      genesisHash
    )
    chain.addBlock(mineOnChain(chain, 'f'.repeat(64), [claimTx]))

    const entries = chain.getClaimableEntries()
    expect(entries.find(e => e.btcAddress === p2shMultisigEntry.btcAddress)).toBeUndefined()
    expect(entries.length).toBe(snapshot.entries.length - 1)
    expect(chain.isClaimed(p2shMultisigEntry.btcAddress)).toBe(true)
  })
})

describe('resetToHeight with storage', () => {
  it('persists correctly — replay from storage matches', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const os = await import('node:os')
    const { FileBlockStorage } = await import('../storage.js')

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-reset-'))

    try {
      const storage = new FileBlockStorage(tmpDir)
      const chain = new Blockchain(undefined, storage)
      chain.difficulty = TEST_TARGET

      // Mine 5 blocks
      for (let i = 0; i < 5; i++) {
        chain.addBlock(mineOnChain(chain, walletA.address))
      }
      expect(chain.getHeight()).toBe(5)

      // Reset to height 2
      chain.resetToHeight(2)
      expect(chain.getHeight()).toBe(2)

      // Create a new chain from the same storage — should replay to height 2
      const chain2 = new Blockchain(undefined, new FileBlockStorage(tmpDir))
      expect(chain2.getHeight()).toBe(2)
      expect(chain2.getChainTip().hash).toBe(chain.getChainTip().hash)

      // UTXOs should match
      expect(chain2.utxoSet.size).toBe(chain.utxoSet.size)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('Transaction index (O(1) lookups)', () => {
  it('indexes transactions when blocks are added', () => {
    const chain = new Blockchain()
    chain.difficulty = TEST_TARGET

    const block1 = mineOnChain(chain, walletA.address)
    const result = chain.addBlock(block1)
    expect(result.success).toBe(true)

    // Coinbase transaction should be indexed
    const coinbaseTxId = block1.transactions[0].id
    const foundBlock = chain.findTransactionBlock(coinbaseTxId)
    expect(foundBlock).toBeDefined()
    expect(foundBlock?.hash).toBe(block1.hash)
  })

  it('returns undefined for non-existent transaction', () => {
    const chain = new Blockchain()
    chain.difficulty = TEST_TARGET

    const block = mineOnChain(chain, walletA.address)
    chain.addBlock(block)

    const result = chain.findTransactionBlock('a'.repeat(64))
    expect(result).toBeUndefined()
  })

  it('maintains transaction index across multiple blocks', () => {
    const chain = new Blockchain()
    chain.difficulty = TEST_TARGET

    const block1 = mineOnChain(chain, walletA.address)
    const addResult1 = chain.addBlock(block1)
    expect(addResult1.success).toBe(true)

    const block2 = mineOnChain(chain, walletA.address)
    const addResult2 = chain.addBlock(block2)
    expect(addResult2.success).toBe(true)

    // All transactions from both blocks should be indexed
    for (const tx of block1.transactions) {
      const foundBlock = chain.findTransactionBlock(tx.id)
      expect(foundBlock).toBeDefined()
    }
    for (const tx of block2.transactions) {
      const foundBlock = chain.findTransactionBlock(tx.id)
      expect(foundBlock).toBeDefined()
    }

    // Should have genesis + 2 mined blocks
    expect(chain.blocks.length).toBe(3)
  })

  it('clears transaction index when resetting to height', () => {
    const chain = new Blockchain()
    chain.difficulty = TEST_TARGET

    const block1 = mineOnChain(chain, walletA.address)
    chain.addBlock(block1)

    const block2 = mineOnChain(chain, walletA.address)
    chain.addBlock(block2)

    // Verify block2's transactions are indexed
    const block2TxIds = block2.transactions.map(t => t.id)
    for (const txId of block2TxIds) {
      expect(chain.findTransactionBlock(txId)).toBeDefined()
    }

    // Reset to height 1 (remove block2)
    chain.resetToHeight(1)

    // Block2's transactions should no longer be indexed
    for (const txId of block2TxIds) {
      expect(chain.findTransactionBlock(txId)).toBeUndefined()
    }

    // Verify we're at height 1
    expect(chain.getHeight()).toBe(1)
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
