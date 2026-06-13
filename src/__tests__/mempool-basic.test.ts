import { describe, it, expect } from 'vitest'
import { Mempool } from '../mempool.js'
import { createTransaction, utxoKey, type UTXO } from '../transaction.js'
import { walletA } from './fixtures.js'
import { DEFAULT_FEE, DEFAULT_AMOUNT, makeUtxoSet } from './mempool-test-helpers.js'

describe('Mempool', () => {
  it('accepts valid transaction', () => {
    const mempool = new Mempool()
    const wallet = walletA
    const utxoSet = makeUtxoSet(wallet)

    const tx = createTransaction(
      wallet,
      [{ txId: 'a'.repeat(64), outputIndex: 0, address: wallet.address, amount: DEFAULT_AMOUNT }],
      [{ address: 'b'.repeat(64), amount: 5_000_000_000 }],
      DEFAULT_FEE
    )

    const result = mempool.addTransaction(tx, utxoSet)
    expect(result.success).toBe(true)
    expect(mempool.size()).toBe(1)
  })

  it('rejects duplicate transaction', () => {
    const mempool = new Mempool()
    const wallet = walletA
    const utxoSet = makeUtxoSet(wallet)

    const tx = createTransaction(
      wallet,
      [{ txId: 'a'.repeat(64), outputIndex: 0, address: wallet.address, amount: DEFAULT_AMOUNT }],
      [{ address: 'b'.repeat(64), amount: 5_000_000_000 }],
      DEFAULT_FEE
    )

    mempool.addTransaction(tx, utxoSet)
    const result = mempool.addTransaction(tx, utxoSet)
    expect(result.success).toBe(false)
    expect(result.error).toContain('already in mempool')
  })

  it('rejects double-spend in mempool', () => {
    const mempool = new Mempool()
    const wallet = walletA
    const utxoSet = makeUtxoSet(wallet)

    const tx1 = createTransaction(
      wallet,
      [{ txId: 'a'.repeat(64), outputIndex: 0, address: wallet.address, amount: DEFAULT_AMOUNT }],
      [{ address: 'b'.repeat(64), amount: 5_000_000_000 }],
      DEFAULT_FEE
    )
    mempool.addTransaction(tx1, utxoSet)

    const tx2 = createTransaction(
      wallet,
      [{ txId: 'a'.repeat(64), outputIndex: 0, address: wallet.address, amount: DEFAULT_AMOUNT }],
      [{ address: 'c'.repeat(64), amount: 4_000_000_000 }],
      DEFAULT_FEE
    )
    const result = mempool.addTransaction(tx2, utxoSet)
    expect(result.success).toBe(false)
    expect(result.error).toContain('already claimed')
  })

  it('getTransactionsForBlock returns all transactions', () => {
    const mempool = new Mempool()
    const wallet = walletA

    // Add 3 transactions with different UTXOs
    for (let i = 0; i < 3; i++) {
      const txId = i.toString(16).padStart(64, '0')
      const utxoSet = new Map<string, UTXO>()
      utxoSet.set(utxoKey(txId, 0), {
        txId,
        outputIndex: 0,
        address: wallet.address,
        amount: DEFAULT_AMOUNT,
      })

      const tx = createTransaction(
        wallet,
        [{ txId, outputIndex: 0, address: wallet.address, amount: DEFAULT_AMOUNT }],
        [{ address: 'b'.repeat(64), amount: 5000 }],
        DEFAULT_FEE
      )
      mempool.addTransaction(tx, utxoSet)
    }

    expect(mempool.getTransactionsForBlock().length).toBe(3)
  })

  it('getTransactionsForBlock called without args does not throw', () => {
    const mempool = new Mempool()
    const wallet = walletA
    const utxoSet = makeUtxoSet(wallet)

    const tx = createTransaction(
      wallet,
      [{ txId: 'a'.repeat(64), outputIndex: 0, address: wallet.address, amount: DEFAULT_AMOUNT }],
      [{ address: 'b'.repeat(64), amount: 5_000_000_000 }],
      DEFAULT_FEE
    )
    mempool.addTransaction(tx, utxoSet)

    // Must not throw when called without utxoSet (regression: passing a number crashed with "utxoSet.get is not a function")
    expect(() => mempool.getTransactionsForBlock()).not.toThrow()
    expect(mempool.getTransactionsForBlock().length).toBe(1)
  })

  it('removeTransactions cleans up claimed UTXOs', () => {
    const mempool = new Mempool()
    const wallet = walletA
    const utxoSet = makeUtxoSet(wallet)

    const tx = createTransaction(
      wallet,
      [{ txId: 'a'.repeat(64), outputIndex: 0, address: wallet.address, amount: DEFAULT_AMOUNT }],
      [{ address: 'b'.repeat(64), amount: 5_000_000_000 }],
      DEFAULT_FEE
    )
    mempool.addTransaction(tx, utxoSet)
    expect(mempool.size()).toBe(1)

    mempool.removeTransactions([tx.id])
    expect(mempool.size()).toBe(0)

    // Can now add a tx spending the same UTXO
    const tx2 = createTransaction(
      wallet,
      [{ txId: 'a'.repeat(64), outputIndex: 0, address: wallet.address, amount: DEFAULT_AMOUNT }],
      [{ address: 'c'.repeat(64), amount: 4_000_000_000 }],
      DEFAULT_FEE
    )
    const result = mempool.addTransaction(tx2, utxoSet)
    expect(result.success).toBe(true)
  })
})

describe('Mempool getTransaction', () => {
  it('returns the transaction by id', () => {
    const mempool = new Mempool()
    const utxoSet = makeUtxoSet(walletA)

    const tx = createTransaction(
      walletA,
      [{ txId: 'a'.repeat(64), outputIndex: 0, address: walletA.address, amount: DEFAULT_AMOUNT }],
      [{ address: 'b'.repeat(64), amount: 5_000_000_000 }],
      DEFAULT_FEE
    )
    mempool.addTransaction(tx, utxoSet)

    const found = mempool.getTransaction(tx.id)
    expect(found).toBeDefined()
    expect(found!.id).toBe(tx.id)
    expect(found!.outputs).toEqual(tx.outputs)
  })

  it('returns undefined for nonexistent id', () => {
    const mempool = new Mempool()
    expect(mempool.getTransaction('f'.repeat(64))).toBeUndefined()
  })

  it('returns undefined after transaction is removed', () => {
    const mempool = new Mempool()
    const utxoSet = makeUtxoSet(walletA)

    const tx = createTransaction(
      walletA,
      [{ txId: 'a'.repeat(64), outputIndex: 0, address: walletA.address, amount: DEFAULT_AMOUNT }],
      [{ address: 'b'.repeat(64), amount: 5_000_000_000 }],
      DEFAULT_FEE
    )
    mempool.addTransaction(tx, utxoSet)
    mempool.removeTransactions([tx.id])

    expect(mempool.getTransaction(tx.id)).toBeUndefined()
  })
})

describe('Mempool removeTransactions edge cases', () => {
  it('ignores nonexistent transaction ids without error', () => {
    const mempool = new Mempool()
    const utxoSet = makeUtxoSet(walletA)

    const tx = createTransaction(
      walletA,
      [{ txId: 'a'.repeat(64), outputIndex: 0, address: walletA.address, amount: DEFAULT_AMOUNT }],
      [{ address: 'b'.repeat(64), amount: 5_000_000_000 }],
      DEFAULT_FEE
    )
    mempool.addTransaction(tx, utxoSet)
    const bytesBeforeRemove = mempool.sizeBytes()

    // Remove a nonexistent id along with the real one
    mempool.removeTransactions(['nonexistent'.padEnd(64, '0'), tx.id])

    expect(mempool.size()).toBe(0)
    expect(mempool.sizeBytes()).toBe(0)
  })

  it('handles empty array gracefully', () => {
    const mempool = new Mempool()
    const utxoSet = makeUtxoSet(walletA)

    const tx = createTransaction(
      walletA,
      [{ txId: 'a'.repeat(64), outputIndex: 0, address: walletA.address, amount: DEFAULT_AMOUNT }],
      [{ address: 'b'.repeat(64), amount: 5_000_000_000 }],
      DEFAULT_FEE
    )
    mempool.addTransaction(tx, utxoSet)

    mempool.removeTransactions([])
    expect(mempool.size()).toBe(1)
  })

  it('handles removing the same id twice without corrupting state', () => {
    const mempool = new Mempool()
    const utxoSet = makeUtxoSet(walletA)

    const tx = createTransaction(
      walletA,
      [{ txId: 'a'.repeat(64), outputIndex: 0, address: walletA.address, amount: DEFAULT_AMOUNT }],
      [{ address: 'b'.repeat(64), amount: 5_000_000_000 }],
      DEFAULT_FEE
    )
    mempool.addTransaction(tx, utxoSet)

    // Pass the same id twice in a single call
    mempool.removeTransactions([tx.id, tx.id])
    expect(mempool.size()).toBe(0)
    expect(mempool.sizeBytes()).toBe(0)
  })
})
