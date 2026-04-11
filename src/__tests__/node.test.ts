/**
 * Node class tests
 *
 * Tests the Node orchestration layer which combines Blockchain, Mempool, and Miner.
 */
import { describe, it, expect, vi } from 'vitest'
import { Node } from '../node.js'
import { Blockchain } from '../chain.js'
import { createTransaction, utxoKey, type UTXO, COINBASE_MATURITY } from '../transaction.js'
import {
  computeMerkleRoot,
  computeBlockHash,
  hashMeetsTarget,
  type Block,
  type BlockHeader,
} from '../block.js'
import { createCoinbaseTransaction } from '../transaction.js'
import { walletA, walletB } from './fixtures.js'

// Easy target: ~16 nonce attempts to find a valid hash (fast for tests)
const TEST_TARGET = '0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

/** Mines a block on a given chain using TEST_TARGET difficulty */
function mineOnChain(chain: Blockchain, minerAddress: string, extraTxs: Array<Block['transactions'][number]> = []): Block {
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
    timestamp: tip.header.timestamp + 1,
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

/** Injects a spendable (non-coinbase) UTXO directly into the chain's UTXO set */
function injectUtxo(node: Node, wallet: { address: string }, amount = 10_000_000_000): UTXO {
  const txId = 'a'.repeat(64)
  const utxo: UTXO = { txId, outputIndex: 0, address: wallet.address, amount }
  node.chain.utxoSet.set(utxoKey(txId, 0), utxo)
  return utxo
}

// ─────────────────────────────────────────────────────────────
// 1. Constructor
// ─────────────────────────────────────────────────────────────
describe('Node constructor', () => {
  it('initialises with the given name', () => {
    const node = new Node('alpha')
    expect(node.name).toBe('alpha')
  })

  it('creates a Blockchain with genesis block', () => {
    const node = new Node('test')
    expect(node.chain.getHeight()).toBe(0)
    expect(node.chain.blocks.length).toBe(1)
  })

  it('creates an empty Mempool', () => {
    const node = new Node('test')
    expect(node.mempool.size()).toBe(0)
  })

  it('initialises callbacks as null', () => {
    const node = new Node('test')
    expect(node.onNewBlock).toBeNull()
    expect(node.onNewTransaction).toBeNull()
  })

  it('miningStats is null when not mining', () => {
    const node = new Node('test')
    expect(node.miningStats).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────
// 2. mine()
// ─────────────────────────────────────────────────────────────
describe('Node.mine()', () => {
  it('mines a block and increases chain height', () => {
    const node = new Node('test')
    node.chain.difficulty = TEST_TARGET

    node.mine(walletA.address, false)

    expect(node.chain.getHeight()).toBe(1)
  })

  it('returns the newly mined block', () => {
    const node = new Node('test')
    node.chain.difficulty = TEST_TARGET

    const block = node.mine(walletA.address, false)

    expect(block.height).toBe(1)
    expect(block.transactions.length).toBeGreaterThanOrEqual(1)
  })

  it('calls onNewBlock callback with the mined block', () => {
    const node = new Node('test')
    node.chain.difficulty = TEST_TARGET
    const spy = vi.fn()
    node.onNewBlock = spy

    const block = node.mine(walletA.address, false)

    expect(spy).toHaveBeenCalledOnce()
    expect(spy).toHaveBeenCalledWith(block)
  })

  it('does not call onNewBlock when callback is null', () => {
    const node = new Node('test')
    node.chain.difficulty = TEST_TARGET
    // onNewBlock is null — should not throw
    expect(() => node.mine(walletA.address, false)).not.toThrow()
  })

  it('removes mined mempool transactions from the mempool', () => {
    const node = new Node('test')
    node.chain.difficulty = TEST_TARGET

    // Inject a UTXO and add a tx to the mempool
    const utxo = injectUtxo(node, walletA)
    const tx = createTransaction(
      walletA,
      [utxo],
      [{ address: walletB.address, amount: 5_000_000_000 }],
      10_000,
    )
    node.receiveTransaction(tx)
    expect(node.mempool.size()).toBe(1)

    // Mine a block — the tx should be included and removed from mempool
    node.mine(walletA.address, false)

    expect(node.mempool.size()).toBe(0)
  })

  it('mines multiple blocks sequentially', () => {
    const node = new Node('test')
    node.chain.difficulty = TEST_TARGET

    node.mine(walletA.address, false)
    node.mine(walletA.address, false)
    node.mine(walletA.address, false)

    expect(node.chain.getHeight()).toBe(3)
  })
})

// ─────────────────────────────────────────────────────────────
// 3. receiveBlock()
// ─────────────────────────────────────────────────────────────
describe('Node.receiveBlock()', () => {
  it('accepts a valid block from another node', () => {
    const node = new Node('receiver')
    node.chain.difficulty = TEST_TARGET

    // Build a valid block on a separate chain mirroring node's state
    const block = mineOnChain(node.chain, walletB.address)
    const result = node.receiveBlock(block)

    expect(result.success).toBe(true)
    expect(node.chain.getHeight()).toBe(1)
  })

  it('rejects a block with incorrect previous hash', () => {
    const node = new Node('receiver')
    node.chain.difficulty = TEST_TARGET

    const tip = node.chain.getChainTip()
    const coinbase = createCoinbaseTransaction(walletB.address, 1, 0)
    const merkleRoot = computeMerkleRoot([coinbase.id])
    const header: BlockHeader = {
      version: 1,
      previousHash: 'f'.repeat(64), // wrong prev hash
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
    const block: Block = { header, hash, transactions: [coinbase], height: 1 }

    const result = node.receiveBlock(block)

    expect(result.success).toBe(false)
    expect(result.error).toBeDefined()
  })

  it('removes mempool transactions that appear in the received block', () => {
    const node = new Node('receiver')
    node.chain.difficulty = TEST_TARGET

    // Add a tx to the mempool
    const utxo = injectUtxo(node, walletA)
    const tx = createTransaction(
      walletA,
      [utxo],
      [{ address: walletB.address, amount: 5_000_000_000 }],
      10_000,
    )
    node.receiveTransaction(tx)
    expect(node.mempool.size()).toBe(1)

    // Build a block that includes the same tx
    node.chain.difficulty = TEST_TARGET
    const tip = node.chain.getChainTip()
    const coinbase = createCoinbaseTransaction(walletB.address, 1, 0)
    const txs = [coinbase, tx]
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
    const block: Block = { header, hash, transactions: txs, height: 1 }

    node.receiveBlock(block)

    expect(node.mempool.size()).toBe(0)
  })

  it('does not change chain height on rejected block', () => {
    const node = new Node('receiver')
    node.chain.difficulty = TEST_TARGET

    // Tamper: create a block with a bad hash
    const tip = node.chain.getChainTip()
    const coinbase = createCoinbaseTransaction(walletB.address, 1, 0)
    const merkleRoot = computeMerkleRoot([coinbase.id])
    const header: BlockHeader = {
      version: 1,
      previousHash: tip.hash,
      merkleRoot,
      timestamp: tip.header.timestamp + 1,
      target: TEST_TARGET,
      nonce: 0,
    }
    const block: Block = {
      header,
      hash: 'deadbeef'.repeat(8), // invalid hash
      transactions: [coinbase],
      height: 1,
    }

    node.receiveBlock(block)

    expect(node.chain.getHeight()).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────
// 4. receiveTransaction()
// ─────────────────────────────────────────────────────────────
describe('Node.receiveTransaction()', () => {
  it('accepts a valid transaction with matching UTXO', () => {
    const node = new Node('test')
    const utxo = injectUtxo(node, walletA)

    const tx = createTransaction(
      walletA,
      [utxo],
      [{ address: walletB.address, amount: 5_000_000_000 }],
      10_000,
    )
    const result = node.receiveTransaction(tx)

    expect(result.success).toBe(true)
    expect(node.mempool.size()).toBe(1)
  })

  it('rejects a transaction with no matching UTXO', () => {
    const node = new Node('test')
    // Inject UTXO so we can create a signed tx, but remove it before submitting
    const utxo = injectUtxo(node, walletA)
    const tx = createTransaction(
      walletA,
      [utxo],
      [{ address: walletB.address, amount: 5_000_000_000 }],
      10_000,
    )
    node.chain.utxoSet.clear() // remove the UTXO

    const result = node.receiveTransaction(tx)

    expect(result.success).toBe(false)
    expect(result.error).toBeDefined()
  })

  it('calls onNewTransaction callback when transaction is accepted', () => {
    const node = new Node('test')
    const spy = vi.fn()
    node.onNewTransaction = spy

    const utxo = injectUtxo(node, walletA)
    const tx = createTransaction(
      walletA,
      [utxo],
      [{ address: walletB.address, amount: 5_000_000_000 }],
      10_000,
    )
    node.receiveTransaction(tx)

    expect(spy).toHaveBeenCalledOnce()
    expect(spy).toHaveBeenCalledWith(tx)
  })

  it('does not call onNewTransaction when transaction is rejected', () => {
    const node = new Node('test')
    const spy = vi.fn()
    node.onNewTransaction = spy

    // Empty UTXO set — tx will be rejected
    const utxo = injectUtxo(node, walletA)
    const tx = createTransaction(
      walletA,
      [utxo],
      [{ address: walletB.address, amount: 5_000_000_000 }],
      10_000,
    )
    node.chain.utxoSet.clear()

    node.receiveTransaction(tx)

    expect(spy).not.toHaveBeenCalled()
  })

  it('rejects duplicate transactions', () => {
    const node = new Node('test')
    const utxo = injectUtxo(node, walletA)

    const tx = createTransaction(
      walletA,
      [utxo],
      [{ address: walletB.address, amount: 5_000_000_000 }],
      10_000,
    )

    node.receiveTransaction(tx)
    const second = node.receiveTransaction(tx)

    expect(second.success).toBe(false)
    expect(node.mempool.size()).toBe(1) // still just one tx
  })
})

// ─────────────────────────────────────────────────────────────
// 5. resetToHeight()
// ─────────────────────────────────────────────────────────────
describe('Node.resetToHeight()', () => {
  it('rolls back the chain to the specified height', () => {
    const node = new Node('test')
    node.chain.difficulty = TEST_TARGET

    node.mine(walletA.address, false)
    node.mine(walletA.address, false)
    node.mine(walletA.address, false)
    expect(node.chain.getHeight()).toBe(3)

    node.resetToHeight(1)

    expect(node.chain.getHeight()).toBe(1)
  })

  it('revalidates mempool after rollback (evicts txs spending rolled-back UTXOs)', () => {
    const node = new Node('test')

    // Mine 101 blocks so walletA's coinbase matures.
    // Reset difficulty to TEST_TARGET before every mine() call to prevent the
    // 10-block difficulty adjustment from making subsequent blocks hard to mine.
    node.chain.difficulty = TEST_TARGET
    node.mine(walletA.address, false)
    for (let i = 0; i < COINBASE_MATURITY; i++) {
      node.chain.difficulty = TEST_TARGET
      node.mine('f'.repeat(64), false)
    }
    expect(node.chain.getHeight()).toBe(101)

    // Spend the mature coinbase into the mempool
    const utxos = node.chain.findUTXOs(walletA.address)
    expect(utxos.length).toBe(1)
    const tx = createTransaction(
      walletA,
      utxos,
      [{ address: walletB.address, amount: 200_000_000 }],
      12_500_000,
    )
    const addResult = node.receiveTransaction(tx)
    expect(addResult.success).toBe(true)
    expect(node.mempool.size()).toBe(1)

    // Roll back to height 0: walletA's coinbase UTXO disappears,
    // so the mempool tx should be evicted during revalidation
    node.resetToHeight(0)

    expect(node.chain.getHeight()).toBe(0)
    expect(node.mempool.size()).toBe(0)
  })

  it('does not throw when resetting to current height', () => {
    const node = new Node('test')
    node.chain.difficulty = TEST_TARGET
    node.mine(walletA.address, false)

    expect(() => node.resetToHeight(1)).not.toThrow()
    expect(node.chain.getHeight()).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────
// 6. getState()
// ─────────────────────────────────────────────────────────────
describe('Node.getState()', () => {
  it('returns correct name', () => {
    const node = new Node('my-node')
    const state = node.getState()
    expect(state.name).toBe('my-node')
  })

  it('returns height 0 for a fresh node', () => {
    const node = new Node('test')
    expect(node.getState().height).toBe(0)
  })

  it('returns correct height after mining', () => {
    const node = new Node('test')
    node.chain.difficulty = TEST_TARGET

    node.mine(walletA.address, false)
    node.mine(walletA.address, false)

    expect(node.getState().height).toBe(2)
  })

  it('reflects mempool size', () => {
    const node = new Node('test')
    const utxo = injectUtxo(node, walletA)

    expect(node.getState().mempoolSize).toBe(0)

    const tx = createTransaction(
      walletA,
      [utxo],
      [{ address: walletB.address, amount: 5_000_000_000 }],
      10_000,
    )
    node.receiveTransaction(tx)

    expect(node.getState().mempoolSize).toBe(1)
  })

  it('reflects UTXO count after mining', () => {
    const node = new Node('test')
    node.chain.difficulty = TEST_TARGET
    expect(node.getState().utxoCount).toBe(0)

    node.mine(walletA.address, false) // coinbase creates a UTXO

    expect(node.getState().utxoCount).toBe(1)
  })

  it('returns null miningStats when not mining', () => {
    const node = new Node('test')
    expect(node.getState().miningStats).toBeNull()
  })

  it('returns a non-empty difficulty string', () => {
    const node = new Node('test')
    const state = node.getState()
    expect(typeof state.difficulty).toBe('string')
    expect(state.difficulty.length).toBeGreaterThan(0)
  })

  it('returns targetBlockTime', () => {
    const node = new Node('test')
    const state = node.getState()
    expect(state.targetBlockTime).toBeGreaterThan(0)
  })

  it('returns blockReward as a positive number', () => {
    const node = new Node('test')
    const state = node.getState()
    expect(state.blockReward).toBeGreaterThan(0)
  })
})

// ─────────────────────────────────────────────────────────────
// 7. stopMining()
// ─────────────────────────────────────────────────────────────
describe('Node.stopMining()', () => {
  it('can be called without an active mining session', () => {
    const node = new Node('test')
    expect(() => node.stopMining()).not.toThrow()
  })

  it('sets miningStats to null after stopping', () => {
    const node = new Node('test')
    // Manually set miningStats to simulate an active miner
    node.miningStats = { nonce: 42, elapsed: 100, hashrate: 1000, blockHeight: 1, startedAt: Date.now() }

    node.stopMining()

    expect(node.miningStats).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────
// 8. Async startMining() smoke tests
//
// NOTE: With TEST_TARGET (1/16 difficulty), mineBlockAsync resolves
// synchronously in the first batch call (hash found in ~16 nonces),
// so all mining iterations run in the microtask queue. We use
// `await Promise.resolve()` to flush exactly one microtask round
// rather than setInterval (macrotask), which would starve.
// ─────────────────────────────────────────────────────────────
describe('Node.startMining()', () => {
  it('resolves cleanly when stopped immediately after start', async () => {
    const node = new Node('async-miner')
    node.chain.difficulty = TEST_TARGET

    const miningPromise = node.startMining(walletA.address)

    // stopMining is called synchronously before the first await resolves.
    // The while loop will exit after the first block (mining = false).
    node.stopMining()
    await miningPromise

    expect(node.miningStats).toBeNull()
  })

  it('mines at least one block and calls onNewBlock before being stopped', async () => {
    const node = new Node('async-miner')
    node.chain.difficulty = TEST_TARGET
    const spy = vi.fn()
    node.onNewBlock = spy

    const miningPromise = node.startMining(walletA.address)

    // With TEST_TARGET, mineBlockAsync resolves synchronously in the Promise
    // executor (batch() finds a hash in ~16 nonces, no setTimeout needed).
    // Each while-loop iteration therefore schedules exactly one microtask.
    // A single `await Promise.resolve()` lets iteration 1 run to completion:
    //   - first mineBlockAsync resolves (microtask A queued by startMining's await)
    //   - then our test resumes (microtask B queued here)
    // Queue order: [A, B] → A runs (block mined), B runs (we continue).
    await Promise.resolve()

    // At this point iteration 1 has completed: height ≥ 1, spy called ≥ 1 time.
    node.stopMining()
    await miningPromise

    expect(node.chain.getHeight()).toBeGreaterThanOrEqual(1)
    expect(spy).toHaveBeenCalled()
  })
})
