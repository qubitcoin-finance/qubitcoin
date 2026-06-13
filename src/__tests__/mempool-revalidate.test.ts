import { describe, it, expect } from 'vitest'
import { Mempool } from '../mempool.js'
import { createTransaction, utxoKey } from '../transaction.js'
import { createMockSnapshot } from '../snapshot.js'
import { createClaimTransaction } from '../claim.js'
import { walletA, walletB, walletC } from './fixtures.js'
import { DEFAULT_FEE, DEFAULT_AMOUNT, makeUtxoSet } from './mempool-test-helpers.js'

describe('Mempool revalidate edge cases', () => {
  it('preserves all transactions when everything is still valid', () => {
    const mempool = new Mempool()
    const utxoSet = makeUtxoSet(walletA)

    const tx = createTransaction(
      walletA,
      [{ txId: 'a'.repeat(64), outputIndex: 0, address: walletA.address, amount: DEFAULT_AMOUNT }],
      [{ address: 'b'.repeat(64), amount: 5_000_000_000 }],
      DEFAULT_FEE
    )
    mempool.addTransaction(tx, utxoSet)
    const bytesBeforeRevalidate = mempool.sizeBytes()

    mempool.revalidate(utxoSet, new Set())

    expect(mempool.size()).toBe(1)
    expect(mempool.sizeBytes()).toBe(bytesBeforeRevalidate)
    expect(mempool.getTransaction(tx.id)).toBeDefined()
  })

  it('rebuilds claimedUTXOs tracking set after revalidate', () => {
    const mempool = new Mempool()
    const utxoSet = makeUtxoSet(walletA)

    const tx = createTransaction(
      walletA,
      [{ txId: 'a'.repeat(64), outputIndex: 0, address: walletA.address, amount: DEFAULT_AMOUNT }],
      [{ address: 'b'.repeat(64), amount: 5_000_000_000 }],
      DEFAULT_FEE
    )
    mempool.addTransaction(tx, utxoSet)

    // Revalidate — should rebuild the claimedUTXOs set
    mempool.revalidate(utxoSet, new Set())

    // Double-spend should still be rejected after revalidate
    const tx2 = createTransaction(
      walletA,
      [{ txId: 'a'.repeat(64), outputIndex: 0, address: walletA.address, amount: DEFAULT_AMOUNT }],
      [{ address: 'c'.repeat(64), amount: 4_000_000_000 }],
      DEFAULT_FEE
    )
    const result = mempool.addTransaction(tx2, utxoSet)
    expect(result.success).toBe(false)
    expect(result.error).toContain('already claimed')
  })

  it('revalidate removes duplicate pending claims and rebuilds claim tracking', async () => {
    const mempool = new Mempool()
    const { snapshot, holders } = createMockSnapshot()

    const claimTx1 = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      walletB,
      snapshot.btcBlockHash
    )

    await new Promise((r) => setTimeout(r, 1))

    const claimTx2 = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      walletC,
      snapshot.btcBlockHash
    )

    mempool.injectTransaction(claimTx1)
    mempool.injectTransaction(claimTx2)
    expect(mempool.size()).toBe(2)

    mempool.revalidate(new Map(), new Set())

    expect(mempool.size()).toBe(1)
    expect(mempool.getTransaction(claimTx1.id)).toBeDefined()
    expect(mempool.getTransaction(claimTx2.id)).toBeUndefined()
    expect(mempool.getPendingBtcClaims().size).toBe(1)

    const claimTx3 = createClaimTransaction(
      holders[1].secretKey,
      holders[1].publicKey,
      snapshot.entries[1],
      walletC,
      snapshot.btcBlockHash
    )
    const result = mempool.addTransaction(claimTx3, new Map())
    expect(result.success).toBe(true)
  })

  it('revalidate keeps the highest-fee conflicting regular tx and rebuilds tracking', () => {
    const mempool = new Mempool()
    const utxoSet = makeUtxoSet(walletA)

    const lowerFeeTx = createTransaction(
      walletA,
      [{ txId: 'a'.repeat(64), outputIndex: 0, address: walletA.address, amount: DEFAULT_AMOUNT }],
      [{ address: 'b'.repeat(64), amount: 5_000_000_000 }],
      DEFAULT_FEE
    )
    const higherFeeTx = createTransaction(
      walletA,
      [{ txId: 'a'.repeat(64), outputIndex: 0, address: walletA.address, amount: DEFAULT_AMOUNT }],
      [{ address: 'c'.repeat(64), amount: 4_000_000_000 }],
      DEFAULT_FEE * 2
    )

    mempool.injectTransaction(lowerFeeTx, [utxoKey('a'.repeat(64), 0)])
    mempool.injectTransaction(higherFeeTx, [utxoKey('a'.repeat(64), 0)])
    expect(mempool.size()).toBe(2)

    mempool.revalidate(utxoSet, new Set())

    expect(mempool.size()).toBe(1)
    expect(mempool.getTransaction(lowerFeeTx.id)).toBeUndefined()
    expect(mempool.getTransaction(higherFeeTx.id)).toBeDefined()

    const tx3 = createTransaction(
      walletA,
      [{ txId: 'a'.repeat(64), outputIndex: 0, address: walletA.address, amount: DEFAULT_AMOUNT }],
      [{ address: 'd'.repeat(64), amount: 3_000_000_000 }],
      DEFAULT_FEE
    )
    const result = mempool.addTransaction(tx3, utxoSet)
    expect(result.success).toBe(false)
    expect(result.error).toContain('already claimed')
  })
})
