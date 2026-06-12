import { describe, it, expect } from 'vitest'
import { Blockchain, MAX_REORG_DEPTH } from '../chain.js'
import { createTransaction, COINBASE_MATURITY } from '../transaction.js'
import { createMockSnapshot } from '../snapshot.js'
import { createClaimTransaction } from '../claim.js'
import { walletA, walletB } from './fixtures.js'
import { TEST_TARGET, mineOnChain } from './chain-test-helpers.js'

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
