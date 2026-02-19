import { describe, it, expect } from 'vitest'
import { Mempool, MAX_CLAIM_COUNT } from '../mempool.js'
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
import { generateBtcKeypair, doubleSha256Hex } from '../crypto.js'
import { walletA, walletB, walletC } from './fixtures.js'

// ML-DSA-65 txs are ~5KB, so we need fee >= ~5 sat to meet 1 sat/KB minimum
const DEFAULT_FEE = 10_000
const DEFAULT_AMOUNT = 10_000_000_000

function makeUtxoSet(wallet: { address: string }, amount = DEFAULT_AMOUNT): Map<string, UTXO> {
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

  it('rejects claim with invalid signature when snapshot is provided', () => {
    const mempool = new Mempool()
    const { snapshot, holders } = createMockSnapshot()
    const qbtcWallet = walletB

    // Sign with wrong key
    const wrongKey = generateBtcKeypair()
    const claimTx = createClaimTransaction(
      wrongKey.secretKey,
      wrongKey.publicKey,
      snapshot.entries[0],
      qbtcWallet,
      snapshot.btcBlockHash
    )

    // With snapshot: should reject (genesis hash doesn't matter here — wrong key is what fails)
    const result = mempool.addTransaction(claimTx, new Map(), new Set(), undefined, snapshot, '')
    expect(result.success).toBe(false)
    expect(result.error).toContain('Invalid claim')
  })

  it('accepts claim without verification when no snapshot provided', () => {
    const mempool = new Mempool()
    const { snapshot, holders } = createMockSnapshot()
    const qbtcWallet = walletB

    // Sign with wrong key
    const wrongKey = generateBtcKeypair()
    const claimTx = createClaimTransaction(
      wrongKey.secretKey,
      wrongKey.publicKey,
      snapshot.entries[0],
      qbtcWallet,
      snapshot.btcBlockHash
    )

    // Without snapshot: should accept (backwards compatible)
    const result = mempool.addTransaction(claimTx, new Map())
    expect(result.success).toBe(true)
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

  it('rejects claims when MAX_CLAIM_COUNT is reached', () => {
    const mempool = new Mempool()

    // Fill the mempool with fake claim txs up to the limit
    for (let i = 0; i < MAX_CLAIM_COUNT; i++) {
      const fakeClaim: Transaction = {
        id: doubleSha256Hex(new TextEncoder().encode(`claim-${i}`)),
        inputs: [{ txId: CLAIM_TXID, outputIndex: 0, publicKey: new Uint8Array(0), signature: new Uint8Array(0) }],
        outputs: [{ address: 'a'.repeat(64), amount: 100 }],
        timestamp: Date.now(),
        claimData: {
          btcAddress: `addr${i.toString().padStart(36, '0')}`,
          ecdsaPublicKey: new Uint8Array(33),
          ecdsaSignature: new Uint8Array(64),
          qbtcAddress: 'a'.repeat(64),
        },
      }
      const r = mempool.addTransaction(fakeClaim, new Map())
      expect(r.success).toBe(true)
    }

    expect(mempool.size()).toBe(MAX_CLAIM_COUNT)

    // One more claim should be rejected
    const extraClaim: Transaction = {
      id: doubleSha256Hex(new TextEncoder().encode('claim-overflow')),
      inputs: [{ txId: CLAIM_TXID, outputIndex: 0, publicKey: new Uint8Array(0), signature: new Uint8Array(0) }],
      outputs: [{ address: 'a'.repeat(64), amount: 100 }],
      timestamp: Date.now(),
      claimData: {
        btcAddress: 'overflow_address'.padEnd(40, '0'),
        ecdsaPublicKey: new Uint8Array(33),
        ecdsaSignature: new Uint8Array(64),
        qbtcAddress: 'a'.repeat(64),
      },
    }
    const result = mempool.addTransaction(extraClaim, new Map())
    expect(result.success).toBe(false)
    expect(result.error).toContain('claim limit')
  })

  it('allows regular (non-claim) transactions when claim limit is reached', () => {
    const mempool = new Mempool()

    // Fill claims to the limit
    for (let i = 0; i < MAX_CLAIM_COUNT; i++) {
      const fakeClaim: Transaction = {
        id: doubleSha256Hex(new TextEncoder().encode(`claim-reg-${i}`)),
        inputs: [{ txId: CLAIM_TXID, outputIndex: 0, publicKey: new Uint8Array(0), signature: new Uint8Array(0) }],
        outputs: [{ address: 'a'.repeat(64), amount: 100 }],
        timestamp: Date.now(),
        claimData: {
          btcAddress: `regaddr${i.toString().padStart(33, '0')}`,
          ecdsaPublicKey: new Uint8Array(33),
          ecdsaSignature: new Uint8Array(64),
          qbtcAddress: 'a'.repeat(64),
        },
      }
      mempool.addTransaction(fakeClaim, new Map())
    }

    // Regular (fee-paying) transactions should still be accepted
    const utxoSet = makeUtxoSet(walletA)
    const tx = createTransaction(
      walletA,
      [{ txId: 'a'.repeat(64), outputIndex: 0, address: walletA.address, amount: DEFAULT_AMOUNT }],
      [{ address: 'b'.repeat(64), amount: 5_000_000_000 }],
      DEFAULT_FEE
    )
    const result = mempool.addTransaction(tx, utxoSet)
    expect(result.success).toBe(true)
    expect(mempool.size()).toBe(MAX_CLAIM_COUNT + 1)
  })

  it('revalidate removes tx when UTXO disappears', () => {
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

    // Revalidate with empty UTXO set — tx should be removed
    mempool.revalidate(new Map(), new Set())
    expect(mempool.size()).toBe(0)
  })

  it('revalidate keeps valid tx when UTXO present', () => {
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

    // Revalidate with UTXOs still present — tx should survive
    mempool.revalidate(utxoSet, new Set())
    expect(mempool.size()).toBe(1)
  })

  it('revalidate removes mined claims', () => {
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
    expect(mempool.size()).toBe(1)

    // Revalidate with the claim marked as already on-chain
    const claimedSet = new Set<string>()
    claimedSet.add(snapshot.entries[0].btcAddress)
    mempool.revalidate(new Map(), claimedSet)
    expect(mempool.size()).toBe(0)
  })

  it('revalidate keeps pending claims not yet on-chain', () => {
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
    expect(mempool.size()).toBe(1)

    // Revalidate with empty claimed set — claim should survive
    mempool.revalidate(new Map(), new Set())
    expect(mempool.size()).toBe(1)
  })

  it('revalidate rebuilds pendingBtcClaims set', () => {
    const mempool = new Mempool()
    const { snapshot, holders } = createMockSnapshot()

    // Add two claims
    const claimTx1 = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      walletB,
      snapshot.btcBlockHash
    )
    const claimTx2 = createClaimTransaction(
      holders[1].secretKey,
      holders[1].publicKey,
      snapshot.entries[1],
      walletC,
      snapshot.btcBlockHash
    )
    mempool.addTransaction(claimTx1, new Map())
    mempool.addTransaction(claimTx2, new Map())
    expect(mempool.size()).toBe(2)

    // Remove one claim via revalidate (mark first as on-chain)
    const claimedSet = new Set<string>()
    claimedSet.add(snapshot.entries[0].btcAddress)
    mempool.revalidate(new Map(), claimedSet)
    expect(mempool.size()).toBe(1)

    // Verify pendingBtcClaims was rebuilt — should only have the second claim
    expect((mempool as any).pendingBtcClaims.size).toBe(1)
    expect((mempool as any).pendingBtcClaims.has(snapshot.entries[1].btcAddress)).toBe(true)
  })

  it('clear() resets all tracking state', () => {
    const mempool = new Mempool()
    const { snapshot, holders } = createMockSnapshot()

    const claimTx = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      walletB,
      snapshot.btcBlockHash
    )
    mempool.addTransaction(claimTx, new Map())

    const utxoSet = makeUtxoSet(walletA)
    const tx = createTransaction(
      walletA,
      [{ txId: 'a'.repeat(64), outputIndex: 0, address: walletA.address, amount: DEFAULT_AMOUNT }],
      [{ address: 'b'.repeat(64), amount: 5_000_000_000 }],
      DEFAULT_FEE
    )
    mempool.addTransaction(tx, utxoSet)
    expect(mempool.size()).toBe(2)

    mempool.clear()
    expect(mempool.size()).toBe(0)
    expect(mempool.sizeBytes()).toBe(0)

    // Should be able to re-add the same claim after clear
    const claimTx2 = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      walletB,
      snapshot.btcBlockHash
    )
    const result = mempool.addTransaction(claimTx2, new Map())
    expect(result.success).toBe(true)
  })

  it('sizeBytes() tracks bytes correctly across add/remove', () => {
    const mempool = new Mempool()
    expect(mempool.sizeBytes()).toBe(0)

    const utxoSet = makeUtxoSet(walletA)
    const tx = createTransaction(
      walletA,
      [{ txId: 'a'.repeat(64), outputIndex: 0, address: walletA.address, amount: DEFAULT_AMOUNT }],
      [{ address: 'b'.repeat(64), amount: 5_000_000_000 }],
      DEFAULT_FEE
    )
    mempool.addTransaction(tx, utxoSet)
    const sizeAfterAdd = mempool.sizeBytes()
    expect(sizeAfterAdd).toBeGreaterThan(0)

    mempool.removeTransactions([tx.id])
    expect(mempool.sizeBytes()).toBe(0)
  })

  it('getTransactionsForBlock sorts claims before regular txs', () => {
    const mempool = new Mempool()
    const utxoSet = makeUtxoSet(walletA)

    // Add a regular tx first
    const tx = createTransaction(
      walletA,
      [{ txId: 'a'.repeat(64), outputIndex: 0, address: walletA.address, amount: DEFAULT_AMOUNT }],
      [{ address: 'b'.repeat(64), amount: 5_000_000_000 }],
      DEFAULT_FEE
    )
    mempool.addTransaction(tx, utxoSet)

    // Add a claim tx
    const { snapshot, holders } = createMockSnapshot()
    const claimTx = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      walletC,
      snapshot.btcBlockHash
    )
    mempool.addTransaction(claimTx, new Map())

    const forBlock = mempool.getTransactionsForBlock(utxoSet)
    expect(forBlock.length).toBe(2)

    // Claims should come first
    const firstIsClaim = forBlock[0].claimData !== undefined
    expect(firstIsClaim).toBe(true)
  })

  it('allows claims again after removeTransactions frees slots', () => {
    const mempool = new Mempool()

    // Fill to the limit
    const claimIds: string[] = []
    for (let i = 0; i < MAX_CLAIM_COUNT; i++) {
      const fakeClaim: Transaction = {
        id: doubleSha256Hex(new TextEncoder().encode(`claim-free-${i}`)),
        inputs: [{ txId: CLAIM_TXID, outputIndex: 0, publicKey: new Uint8Array(0), signature: new Uint8Array(0) }],
        outputs: [{ address: 'a'.repeat(64), amount: 100 }],
        timestamp: Date.now(),
        claimData: {
          btcAddress: `freeaddr${i.toString().padStart(32, '0')}`,
          ecdsaPublicKey: new Uint8Array(33),
          ecdsaSignature: new Uint8Array(64),
          qbtcAddress: 'a'.repeat(64),
        },
      }
      mempool.addTransaction(fakeClaim, new Map())
      claimIds.push(fakeClaim.id)
    }

    // Remove some claims (simulating them being mined)
    mempool.removeTransactions(claimIds.slice(0, 10))

    // Now a new claim should be accepted
    const newClaim: Transaction = {
      id: doubleSha256Hex(new TextEncoder().encode('claim-after-free')),
      inputs: [{ txId: CLAIM_TXID, outputIndex: 0, publicKey: new Uint8Array(0), signature: new Uint8Array(0) }],
      outputs: [{ address: 'a'.repeat(64), amount: 100 }],
      timestamp: Date.now(),
      claimData: {
        btcAddress: 'newaddr_after_free'.padEnd(40, '0'),
        ecdsaPublicKey: new Uint8Array(33),
        ecdsaSignature: new Uint8Array(64),
        qbtcAddress: 'a'.repeat(64),
      },
    }
    const result = mempool.addTransaction(newClaim, new Map())
    expect(result.success).toBe(true)
  })
})
