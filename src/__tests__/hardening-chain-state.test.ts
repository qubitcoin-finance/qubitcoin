import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Node } from '../node.js'
import { P2PServer } from '../p2p/server.js'
import { FileBlockStorage } from '../storage.js'
import { blockWork, STARTING_DIFFICULTY, INITIAL_TARGET, computeBlockHash, computeMerkleRoot, hashMeetsTarget } from '../block.js'
import { createTransaction, createCoinbaseTransaction, utxoKey } from '../transaction.js'
import { createClaimTransaction } from '../claim.js'
import { createMockSnapshot } from '../snapshot.js'
import { walletA, walletB } from './fixtures.js'
import { waitFor } from './hardening-test-helpers.js'

describe('Cumulative work', () => {
  it('blockWork computes correctly', () => {
    // Easy target = low work
    const easyWork = blockWork(INITIAL_TARGET)
    // Hard target = high work
    const hardWork = blockWork(STARTING_DIFFICULTY)
    expect(hardWork).toBeGreaterThan(easyWork)
    expect(easyWork).toBeGreaterThan(0n)
  })

  it('blockchain tracks cumulative work', () => {
    const node = new Node('test')
    const TEST_TARGET = '0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
    node.chain.difficulty = TEST_TARGET

    const initialWork = node.chain.cumulativeWork
    expect(initialWork).toBeGreaterThan(0n)

    // Mine a block
    node.mine(walletA.address, false)
    expect(node.chain.cumulativeWork).toBeGreaterThan(initialWork)
  })

  it('cumulative work decreases on resetToHeight', () => {
    const node = new Node('test')
    const TEST_TARGET = '0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
    node.chain.difficulty = TEST_TARGET

    // Mine 3 blocks
    for (let i = 0; i < 3; i++) {
      node.mine(walletA.address, false)
    }
    const workAt3 = node.chain.cumulativeWork

    // Reset to height 1
    node.chain.resetToHeight(1)
    expect(node.chain.cumulativeWork).toBeLessThan(workAt3)
    expect(node.chain.cumulativeWork).toBeGreaterThan(0n)
  })

  it('status includes cumulativeWork', () => {
    const node = new Node('test')
    const state = node.getState()
    expect(state.cumulativeWork).toBeDefined()
    expect(typeof state.cumulativeWork).toBe('string')
  })
})

describe('Node.resetToHeight', () => {
  const TEST_TARGET = '0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

  it('removes invalidated mempool tx after rollback', () => {
    const node = new Node('reset-test')
    node.chain.difficulty = TEST_TARGET

    // Mine block 1
    node.mine(walletA.address, false)
    expect(node.chain.getHeight()).toBe(1)

    // Directly inject a tx into mempool that references block 1's coinbase UTXO
    // (bypassing maturity check by using mempool internals)
    const coinbaseTx = node.chain.blocks[1].transactions[0]
    const fakeUtxoKey = utxoKey(coinbaseTx.id, 0)

    // Create a tx spending a UTXO that exists at height 1 but not at height 0
    const tx = createTransaction(
      walletA,
      [{ txId: coinbaseTx.id, outputIndex: 0, address: walletA.address, amount: coinbaseTx.outputs[0].amount }],
      [{ address: 'b'.repeat(64), amount: 5000 }],
      10_000
    )
    // Force-add to mempool (the UTXO exists in chain but isn't mature — we're testing revalidate, not addTransaction)
    node.mempool.injectTransaction(tx, [fakeUtxoKey])
    expect(node.mempool.size()).toBe(1)

    // Reset to height 0 — the UTXO that tx spends no longer exists
    node.resetToHeight(0)
    expect(node.mempool.size()).toBe(0)
  })

  it('preserves claim in mempool after rollback', () => {
    const { snapshot, holders } = createMockSnapshot()
    const node = new Node('reset-claim', snapshot)
    node.chain.difficulty = TEST_TARGET

    // Mine block 1 (without the claim)
    node.mine(walletA.address, false)

    // Add claim to mempool
    const claimTx = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      walletB,
      snapshot.btcBlockHash,
      node.chain.blocks[0].hash
    )
    const addResult = node.receiveTransaction(claimTx)
    expect(addResult.success).toBe(true)
    expect(node.mempool.size()).toBe(1)

    // Reset to height 0 — claim should survive (not on-chain)
    node.resetToHeight(0)
    expect(node.mempool.size()).toBe(1)
  })

  it('clears claimedBtcAddresses on rollback allowing re-claim', () => {
    const { snapshot, holders } = createMockSnapshot()
    const node = new Node('reset-claim2', snapshot)
    node.chain.difficulty = TEST_TARGET
    const genesisHash = node.chain.blocks[0].hash

    // Create and mine a claim in block 1
    const claimTx = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      walletA,
      snapshot.btcBlockHash,
      genesisHash
    )

    // Mine block with claim
    const tip = node.chain.getChainTip()
    const height = node.chain.getHeight() + 1
    const coinbase = createCoinbaseTransaction(walletA.address, height, 0)
    const txs = [coinbase, claimTx]
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
    const block = { header, hash, transactions: txs, height }
    const blockResult = node.chain.addBlock(block)
    expect(blockResult.success).toBe(true)

    // Verify claim is tracked
    expect(node.chain.claimedBtcAddresses.has(snapshot.entries[0].btcAddress)).toBe(true)

    // Reset to height 0
    node.resetToHeight(0)

    // claimedBtcAddresses should be cleared
    expect(node.chain.claimedBtcAddresses.has(snapshot.entries[0].btcAddress)).toBe(false)

    // Should be able to add the claim to mempool again
    const claimTx2 = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      walletB,
      snapshot.btcBlockHash,
      genesisHash
    )
    const addResult = node.receiveTransaction(claimTx2)
    expect(addResult.success).toBe(true)
  })
})

describe('Orphan block PoW validation', () => {
  it('should reject orphans with invalid PoW', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-orphan-'))
    try {
      const node = new Node('test', undefined, new FileBlockStorage(tmpDir))
      const p2p = new P2PServer(node, 0, tmpDir)

      // Try to add orphan with fake hash (bypass the public API, call private addOrphan)
      const fakeOrphan = {
        header: {
          version: 1,
          previousHash: 'dead'.repeat(16), // unknown parent
          merkleRoot: 'a'.repeat(64),
          timestamp: Date.now(),
          target: '0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
          nonce: 0,
        },
        hash: 'beef'.repeat(16), // doesn't match header
        transactions: [],
        height: 99,
      }

      ;p2p.addOrphan(fakeOrphan)

      // Should NOT be in orphan pool (hash doesn't match header)
      expect(p2p.getOrphanCount()).toBe(0)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('Node receiveBlock', () => {
  const TEST_TARGET = '0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

  it('aborts in-progress mining when a valid block arrives', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-abort-'))
    try {
      const storage = new FileBlockStorage(tmpDir)
      const node = new Node('miner', undefined, storage)
      // Use extremely hard target so miner cannot find a block during the test
      node.chain.difficulty = '0000000000000fffffffffffffffffffffffffffffffffffffffffffffffffff'

      let aborted = false
      const miningPromise = node.startMining(walletA.address)

      // Wait for mining to start
      await waitFor(() => node.miningStats !== null, 10_000)

      // Mine a block externally and feed it via receiveBlock
      const { assembleCandidateBlock, mineBlock } = await import('../miner.js')
      node.chain.difficulty = TEST_TARGET
      const candidate = assembleCandidateBlock(node.chain, node.mempool, walletB.address)
      const externalBlock = mineBlock(candidate, false)

      const result = node.receiveBlock(externalBlock)
      expect(result.success).toBe(true)
      expect(node.miningStats).toBeNull()

      // Mining should restart (miningStats resets for new round)
      // Give it a moment to restart
      await new Promise(r => setTimeout(r, 200))

      node.stopMining()
      await Promise.race([
        miningPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5_000))
      ])

      // Block from external miner should be in the chain
      expect(node.chain.getHeight()).toBeGreaterThanOrEqual(1)
      expect(node.chain.blocks[1].hash).toBe(externalBlock.hash)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('does not abort mining when receiveBlock fails', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-noabort-'))
    try {
      const storage = new FileBlockStorage(tmpDir)
      const node = new Node('miner', undefined, storage)
      node.chain.difficulty = '00000fffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

      const miningPromise = node.startMining(walletA.address)
      await waitFor(() => node.miningStats !== null, 10_000)

      // Send an invalid block (wrong target)
      const invalidBlock = {
        header: {
          version: 1,
          previousHash: node.chain.blocks[0].hash,
          merkleRoot: 'a'.repeat(64),
          timestamp: Date.now(),
          target: 'f'.repeat(64),
          nonce: 0,
        },
        hash: 'b'.repeat(64),
        transactions: [],
        height: 1,
      }

      const result = node.receiveBlock(invalidBlock as any)
      expect(result.success).toBe(false)

      // Mining should still be running (miningStats not null)
      expect(node.miningStats).not.toBeNull()

      node.stopMining()
      await Promise.race([
        miningPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5_000))
      ])
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
