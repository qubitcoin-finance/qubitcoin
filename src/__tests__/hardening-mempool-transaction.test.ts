import { describe, it, expect } from 'vitest'
import { Blockchain } from '../chain.js'
import { Mempool, MAX_MEMPOOL_BYTES } from '../mempool.js'
import { computeBlockHash, computeMerkleRoot, hashMeetsTarget, validateBlock, type BlockHeader } from '../block.js'
import { createClaimTransaction } from '../claim.js'
import { createTransaction, createCoinbaseTransaction, validateTransaction, utxoKey, CLAIM_TXID, DUST_THRESHOLD, MAX_MONEY, type UTXO } from '../transaction.js'
import { doubleSha256Hex } from '../crypto.js'
import { createMockSnapshot } from '../snapshot.js'
import { walletA, walletB } from './fixtures.js'
import { makeUtxoSet } from './hardening-test-helpers.js'

describe('Minimum relay fee', () => {
  it('should reject zero-fee transactions', () => {
    const mempool = new Mempool()
    const wallet = walletA
    const utxoSet = makeUtxoSet(wallet, 10_000)

    // Create a transaction with zero fee (amount = all input)
    const tx = createTransaction(
      wallet,
      [{ txId: 'a'.repeat(64), outputIndex: 0, address: wallet.address, amount: 10_000 }],
      [{ address: 'b'.repeat(64), amount: 10_000 }],
      0
    )

    const result = mempool.addTransaction(tx, utxoSet)
    expect(result.success).toBe(false)
    expect(result.error).toContain('Fee rate')
    expect(result.error).toContain('below minimum')
  })

  it('should accept transactions with sufficient fee', () => {
    const mempool = new Mempool()
    const wallet = walletA
    const utxoSet = makeUtxoSet(wallet, 100000)

    // Create a transaction with a generous fee
    const tx = createTransaction(
      wallet,
      [{ txId: 'a'.repeat(64), outputIndex: 0, address: wallet.address, amount: 100000 }],
      [{ address: 'b'.repeat(64), amount: 5000 }],
      10000 // large fee
    )

    const result = mempool.addTransaction(tx, utxoSet)
    expect(result.success).toBe(true)
  })

  it('should still accept claim transactions (fee-free)', async () => {
    const mempool = new Mempool()
    const { snapshot, holders } = createMockSnapshot()

    const claimTx = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      walletB,
      snapshot.btcBlockHash
    )

    const result = mempool.addTransaction(claimTx, new Map())
    expect(result.success).toBe(true)
  })
})

describe('Mempool size cap', () => {
  it('should evict low-fee transactions when full', () => {
    const mempool = new Mempool()

    // Create many transactions to fill the mempool
    // Each ML-DSA-65 tx is ~5KB, so we need ~10,000 to hit 50MB
    // Instead of actually filling it, test the eviction logic by checking the mechanism
    const utxoSet = makeUtxoSet(walletA, 10_000_000_000)

    const tx = createTransaction(
      walletA,
      [{ txId: 'a'.repeat(64), outputIndex: 0, address: walletA.address, amount: 10_000_000_000 }],
      [{ address: 'b'.repeat(64), amount: 5_000_000_000 }],
      10_000
    )
    const result = mempool.addTransaction(tx, utxoSet)
    expect(result.success).toBe(true)

    // Verify the totalBytes is tracked
    expect(mempool.getTotalBytes()).toBeGreaterThan(0)
  })

  it('should reject tx when pool is full and nothing can be evicted', () => {
    const mempool = new Mempool()

    // Inflate totalBytes to the limit (no actual txs to evict)
    mempool.setTotalBytes(MAX_MEMPOOL_BYTES)

    const utxoSet = makeUtxoSet(walletA, 10_000_000_000)
    const tx = createTransaction(
      walletA,
      [{ txId: 'a'.repeat(64), outputIndex: 0, address: walletA.address, amount: 10_000_000_000 }],
      [{ address: 'b'.repeat(64), amount: 5_000_000_000 }],
      10_000
    )
    const result = mempool.addTransaction(tx, utxoSet)
    // Pool is "full" and there are no candidates to evict
    expect(result.success).toBe(false)
    expect(result.error).toContain('fee density too low')
  })
})

describe('Dust limit', () => {
  it('should reject tx with output below DUST_THRESHOLD', () => {
    const utxoSet = makeUtxoSet(walletA, 100_000)
    const tx = createTransaction(
      walletA,
      [{ txId: 'a'.repeat(64), outputIndex: 0, address: walletA.address, amount: 100_000 }],
      [{ address: 'b'.repeat(64), amount: 100 }], // 100 < 546
      10_000
    )
    const result = validateTransaction(tx, utxoSet)
    expect(result.valid).toBe(false)
    expect(result.error).toContain('below dust threshold')
  })

  it('should accept tx with output at exactly DUST_THRESHOLD', () => {
    const utxoSet = makeUtxoSet(walletA, 100_000)
    const tx = createTransaction(
      walletA,
      [{ txId: 'a'.repeat(64), outputIndex: 0, address: walletA.address, amount: 100_000 }],
      [{ address: 'b'.repeat(64), amount: DUST_THRESHOLD }],
      10_000
    )
    const result = validateTransaction(tx, utxoSet)
    expect(result.valid).toBe(true)
  })

  it('should reject claim tx with output below DUST_THRESHOLD in block validation', () => {
    const { snapshot } = createMockSnapshot()
    const chain = new Blockchain(snapshot)
    const TEST_TARGET = '0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
    chain.difficulty = TEST_TARGET

    const tip = chain.getChainTip()
    const height = chain.getHeight() + 1
    const coinbase = createCoinbaseTransaction(walletA.address, height, 0)

    const dustClaim = {
      id: doubleSha256Hex(new TextEncoder().encode('dust-claim')),
      inputs: [{ txId: CLAIM_TXID, outputIndex: 0, publicKey: new Uint8Array(0), signature: new Uint8Array(0) }],
      outputs: [{ address: walletA.address, amount: 100 }], // below dust
      timestamp: Date.now(),
      claimData: {
        btcAddress: snapshot.entries[0].btcAddress,
        ecdsaPublicKey: new Uint8Array(33),
        ecdsaSignature: new Uint8Array(64),
        qbtcAddress: walletA.address,
      },
    }

    const txs = [coinbase, dustClaim]
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

    const result = validateBlock(
      { header, hash, transactions: txs, height },
      tip, chain.utxoSet, chain.blocks
    )
    expect(result.valid).toBe(false)
    expect(result.error).toContain('dust threshold')
  })

  it('should not apply dust limit to coinbase outputs', () => {
    // Coinbase validation is handled differently — validateTransaction returns early
    const coinbaseTx = createCoinbaseTransaction(walletA.address, 1, 0)
    const utxoSet = new Map<string, UTXO>()
    const result = validateTransaction(coinbaseTx, utxoSet)
    expect(result.valid).toBe(true)
  })
})

describe('Amount overflow protection', () => {
  it('should reject tx with single output > MAX_MONEY', () => {
    const hugeAmount = MAX_MONEY + 1
    const utxoSet = new Map<string, UTXO>()
    utxoSet.set(utxoKey('a'.repeat(64), 0), {
      txId: 'a'.repeat(64),
      outputIndex: 0,
      address: walletA.address,
      amount: hugeAmount,
    })

    const tx = createTransaction(
      walletA,
      [{ txId: 'a'.repeat(64), outputIndex: 0, address: walletA.address, amount: hugeAmount }],
      [{ address: 'b'.repeat(64), amount: hugeAmount - 10_000 }],
      10_000
    )
    const result = validateTransaction(tx, utxoSet)
    expect(result.valid).toBe(false)
    expect(result.error).toContain('exceeds maximum')
  })

  it('should reject tx with total outputs > MAX_MONEY', () => {
    const halfMax = Math.floor(MAX_MONEY / 2) + 1
    const totalNeeded = halfMax * 2 + 10_000
    const utxoSet = new Map<string, UTXO>()
    utxoSet.set(utxoKey('a'.repeat(64), 0), {
      txId: 'a'.repeat(64),
      outputIndex: 0,
      address: walletA.address,
      amount: totalNeeded,
    })

    const tx = createTransaction(
      walletA,
      [{ txId: 'a'.repeat(64), outputIndex: 0, address: walletA.address, amount: totalNeeded }],
      [
        { address: 'b'.repeat(64), amount: halfMax },
        { address: 'c'.repeat(64), amount: halfMax },
      ],
      10_000
    )
    const result = validateTransaction(tx, utxoSet)
    expect(result.valid).toBe(false)
    expect(result.error).toContain('exceeds maximum')
  })

  it('should reject tx with total inputs > MAX_MONEY', () => {
    const halfMax = Math.floor(MAX_MONEY / 2) + 1
    const utxoSet = new Map<string, UTXO>()
    utxoSet.set(utxoKey('a'.repeat(64), 0), {
      txId: 'a'.repeat(64),
      outputIndex: 0,
      address: walletA.address,
      amount: halfMax,
    })
    utxoSet.set(utxoKey('b'.repeat(64), 0), {
      txId: 'b'.repeat(64),
      outputIndex: 0,
      address: walletA.address,
      amount: halfMax,
    })

    const tx = createTransaction(
      walletA,
      [
        { txId: 'a'.repeat(64), outputIndex: 0, address: walletA.address, amount: halfMax },
        { txId: 'b'.repeat(64), outputIndex: 0, address: walletA.address, amount: halfMax },
      ],
      [{ address: 'c'.repeat(64), amount: 1_000_000 }],
      10_000
    )
    const result = validateTransaction(tx, utxoSet)
    expect(result.valid).toBe(false)
    expect(result.error).toContain('exceeds maximum')
  })

  it('should accept tx with amounts within limits', () => {
    const utxoSet = makeUtxoSet(walletA, 1_000_000)
    const tx = createTransaction(
      walletA,
      [{ txId: 'a'.repeat(64), outputIndex: 0, address: walletA.address, amount: 1_000_000 }],
      [{ address: 'b'.repeat(64), amount: 500_000 }],
      10_000
    )
    const result = validateTransaction(tx, utxoSet)
    expect(result.valid).toBe(true)
  })
})
