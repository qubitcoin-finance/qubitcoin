import { describe, it, expect } from 'vitest'
import { Mempool } from '../mempool.js'
import { createTransaction, utxoKey, type UTXO } from '../transaction.js'
import { walletA, walletB } from './fixtures.js'
import { DEFAULT_FEE, DEFAULT_AMOUNT } from './mempool-test-helpers.js'

describe('Mempool getTransactionsForBlock sorting', () => {
  it('sorts regular txs by fee density descending when utxoSet provided', () => {
    const mempool = new Mempool()

    // Create two txs with different fee densities
    // Higher fee → higher density (same tx size roughly)
    const txIdA = 'a'.repeat(64)
    const txIdB = 'b'.repeat(64)
    const utxoSetA = new Map<string, UTXO>()
    utxoSetA.set(utxoKey(txIdA, 0), {
      txId: txIdA, outputIndex: 0, address: walletA.address, amount: DEFAULT_AMOUNT,
    })
    const utxoSetB = new Map<string, UTXO>()
    utxoSetB.set(utxoKey(txIdB, 0), {
      txId: txIdB, outputIndex: 0, address: walletB.address, amount: DEFAULT_AMOUNT,
    })

    // Low fee tx
    const lowFeeTx = createTransaction(
      walletA,
      [{ txId: txIdA, outputIndex: 0, address: walletA.address, amount: DEFAULT_AMOUNT }],
      [{ address: 'c'.repeat(64), amount: DEFAULT_AMOUNT - DEFAULT_FEE }],
      DEFAULT_FEE
    )
    // High fee tx (10x the fee)
    const highFeeTx = createTransaction(
      walletB,
      [{ txId: txIdB, outputIndex: 0, address: walletB.address, amount: DEFAULT_AMOUNT }],
      [{ address: 'c'.repeat(64), amount: DEFAULT_AMOUNT - DEFAULT_FEE * 10 }],
      DEFAULT_FEE * 10
    )

    // Add low fee first
    mempool.addTransaction(lowFeeTx, utxoSetA)
    mempool.addTransaction(highFeeTx, utxoSetB)

    // Combine both UTXO sets for sorting
    const combined = new Map([...utxoSetA, ...utxoSetB])
    const forBlock = mempool.getTransactionsForBlock(combined)

    expect(forBlock.length).toBe(2)
    // High fee tx should come first
    expect(forBlock[0].id).toBe(highFeeTx.id)
    expect(forBlock[1].id).toBe(lowFeeTx.id)
  })

  it('returns unsorted transactions when no utxoSet provided', () => {
    const mempool = new Mempool()

    const txIdA = 'a'.repeat(64)
    const utxoSet = new Map<string, UTXO>()
    utxoSet.set(utxoKey(txIdA, 0), {
      txId: txIdA, outputIndex: 0, address: walletA.address, amount: DEFAULT_AMOUNT,
    })

    const tx = createTransaction(
      walletA,
      [{ txId: txIdA, outputIndex: 0, address: walletA.address, amount: DEFAULT_AMOUNT }],
      [{ address: 'b'.repeat(64), amount: DEFAULT_AMOUNT - DEFAULT_FEE }],
      DEFAULT_FEE
    )
    mempool.addTransaction(tx, utxoSet)

    // Should return all transactions without throwing
    const forBlock = mempool.getTransactionsForBlock()
    expect(forBlock.length).toBe(1)
    expect(forBlock[0].id).toBe(tx.id)
  })
})
