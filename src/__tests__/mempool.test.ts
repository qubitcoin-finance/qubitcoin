import { describe, it, expect } from 'vitest'
import { Mempool } from '../mempool.js'
import {
  createTransaction,
  createCoinbaseTransaction,
  utxoKey,
  type UTXO,
  type Transaction,
  CLAIM_TXID,
} from '../transaction.js'
import { createMockSnapshot } from '../snapshot.js'
import { createClaimTransaction } from '../claim.js'
import { walletA, walletB, walletC } from './fixtures.js'

// ML-DSA-65 txs are ~5KB, so we need fee >= ~5 to meet 1000 sat/KB minimum
const DEFAULT_FEE = 10
const DEFAULT_AMOUNT = 10000

function makeUtxoSet(wallet: ReturnType<typeof generateWallet>, amount = DEFAULT_AMOUNT): Map<string, UTXO> {
  const utxoSet = new Map<string, UTXO>()
  const txId = 'a'.repeat(64)
  utxoSet.set(utxoKey(txId, 0), {
    txId,
    outputIndex: 0,
    address: wallet.address,
    amount,
  })
  return utxoSet
}

describe('Mempool', () => {
  it('accepts valid transaction', () => {
    const mempool = new Mempool()
    const wallet = walletA
    const utxoSet = makeUtxoSet(wallet)

    const tx = createTransaction(
      wallet,
      [{ txId: 'a'.repeat(64), outputIndex: 0, address: wallet.address, amount: DEFAULT_AMOUNT }],
      [{ address: 'b'.repeat(64), amount: 50 }],
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
      [{ address: 'b'.repeat(64), amount: 50 }],
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
      [{ address: 'b'.repeat(64), amount: 50 }],
      DEFAULT_FEE
    )
    mempool.addTransaction(tx1, utxoSet)

    const tx2 = createTransaction(
      wallet,
      [{ txId: 'a'.repeat(64), outputIndex: 0, address: wallet.address, amount: DEFAULT_AMOUNT }],
      [{ address: 'c'.repeat(64), amount: 40 }],
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
        [{ address: 'b'.repeat(64), amount: 50 }],
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
      [{ address: 'b'.repeat(64), amount: 50 }],
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
      [{ address: 'b'.repeat(64), amount: 50 }],
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
      [{ address: 'c'.repeat(64), amount: 40 }],
      DEFAULT_FEE
    )
    const result = mempool.addTransaction(tx2, utxoSet)
    expect(result.success).toBe(true)
  })
})

describe('Mempool claims', () => {
  it('accepts valid claim', () => {
    const mempool = new Mempool()
    const { snapshot, holders } = createMockSnapshot()
    const qbtcWallet = walletB

    const claimTx = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      qbtcWallet,
      snapshot.btcBlockHash
    )

    const result = mempool.addTransaction(claimTx, new Map())
    expect(result.success).toBe(true)
  })

  it('rejects double-claim in mempool', async () => {
    const mempool = new Mempool()
    const { snapshot, holders } = createMockSnapshot()
    const qbtcWallet = walletB

    const claimTx1 = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      qbtcWallet,
      snapshot.btcBlockHash
    )
    mempool.addTransaction(claimTx1, new Map())

    // Wait 1ms so timestamp differs → different tx id
    await new Promise((r) => setTimeout(r, 1))

    const qbtcWallet2 = walletC
    const claimTx2 = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      qbtcWallet2,
      snapshot.btcBlockHash
    )
    const result = mempool.addTransaction(claimTx2, new Map())
    expect(result.success).toBe(false)
    expect(result.error).toContain('pending claim')
  })

  it('rejects claim already on-chain', () => {
    const mempool = new Mempool()
    const { snapshot, holders } = createMockSnapshot()
    const qbtcWallet = walletB

    const claimedSet = new Set<string>()
    claimedSet.add(snapshot.entries[0].btcAddress)

    const claimTx = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      qbtcWallet,
      snapshot.btcBlockHash
    )

    const result = mempool.addTransaction(claimTx, new Map(), claimedSet)
    expect(result.success).toBe(false)
    expect(result.error).toContain('already claimed on-chain')
  })

  it('removeTransactions cleans up pending claims', () => {
    const mempool = new Mempool()
    const { snapshot, holders } = createMockSnapshot()
    const qbtcWallet = walletB

    const claimTx = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      qbtcWallet,
      snapshot.btcBlockHash
    )
    mempool.addTransaction(claimTx, new Map())
    mempool.removeTransactions([claimTx.id])

    // Should be able to add same claim again
    const claimTx2 = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      qbtcWallet,
      snapshot.btcBlockHash
    )
    const result = mempool.addTransaction(claimTx2, new Map())
    expect(result.success).toBe(true)
  })
})
