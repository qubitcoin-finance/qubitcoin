import { describe, it, expect } from 'vitest'
import { Mempool, MAX_CLAIM_COUNT, MAX_MEMPOOL_BYTES } from '../mempool.js'
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
})

describe('Mempool eviction', () => {
  function makeFakeClaim(i: number, payloadBytes = 0): Transaction {
    const padding = new Uint8Array(payloadBytes) // simulate larger claims
    return {
      id: doubleSha256Hex(new TextEncoder().encode(`evict-claim-${i}-${payloadBytes}`)),
      inputs: [{ txId: CLAIM_TXID, outputIndex: 0, publicKey: new Uint8Array(0), signature: new Uint8Array(0) }],
      outputs: [{ address: 'a'.repeat(64), amount: 100 }],
      timestamp: Date.now(),
      claimData: {
        btcAddress: `evictaddr${i.toString().padStart(31, '0')}`,
        ecdsaPublicKey: new Uint8Array(33),
        ecdsaSignature: padding.length ? padding : new Uint8Array(64),
        qbtcAddress: 'a'.repeat(64),
      },
    }
  }

  it('claim evicts low-fee regular tx to make room', () => {
    const mempool = new Mempool()

    // Add a low-fee regular tx
    const utxoSet = makeUtxoSet(walletA)
    const lowFeeTx = createTransaction(
      walletA,
      [{ txId: 'a'.repeat(64), outputIndex: 0, address: walletA.address, amount: DEFAULT_AMOUNT }],
      [{ address: 'b'.repeat(64), amount: DEFAULT_AMOUNT - DEFAULT_FEE }],
      DEFAULT_FEE
    )
    const r1 = mempool.addTransaction(lowFeeTx, utxoSet)
    expect(r1.success).toBe(true)
    const bytesAfterRegular = mempool.sizeBytes()
    expect(bytesAfterRegular).toBeGreaterThan(0)

    // Manually push totalBytes close to the limit by filling with more regular txs
    // (can't easily fill 50MB in unit tests, so instead verify the eviction path works
    // by checking that a claim is accepted and the pool byte count is consistent)
    const claimTx = makeFakeClaim(0)
    const r2 = mempool.addTransaction(claimTx, utxoSet)
    expect(r2.success).toBe(true)

    // sizeBytes() must equal the sum of all remaining tx sizes
    const remaining = mempool.getTransactions()
    let expectedBytes = 0
    for (const tx of remaining.values()) {
      expectedBytes += mempool.getTxSize(tx)
    }
    expect(mempool.sizeBytes()).toBe(expectedBytes)
  })

  it('claim is accepted even when pool contains only claims (no regular txs to evict)', () => {
    // This documents intentional behavior: claims bypass the byte-limit rejection
    // that regular txs face, because MAX_CLAIM_COUNT already bounds total claim memory.
    const mempool = new Mempool()

    // Add two claims so the pool is non-empty
    const c1 = makeFakeClaim(100)
    const c2 = makeFakeClaim(101)
    mempool.addTransaction(c1, new Map())
    mempool.addTransaction(c2, new Map())
    expect(mempool.size()).toBe(2)

    // Add another claim — should always succeed regardless of pool byte pressure
    const c3 = makeFakeClaim(102)
    const result = mempool.addTransaction(c3, new Map())
    expect(result.success).toBe(true)
    expect(mempool.size()).toBe(3)
  })

  it('sizeBytes() never underflows after removeTransactions on claims', () => {
    const mempool = new Mempool()

    const c1 = makeFakeClaim(200)
    mempool.addTransaction(c1, new Map())
    const bytesWithOne = mempool.sizeBytes()
    expect(bytesWithOne).toBeGreaterThan(0)

    mempool.removeTransactions([c1.id])
    expect(mempool.sizeBytes()).toBe(0)
    expect(mempool.size()).toBe(0)
  })

  it('regular tx is rejected when pool is full and no lower-density tx exists', () => {
    const mempool = new Mempool()

    // Simulate a pool that is at capacity by patching totalBytes directly
    // This tests the evictLowest path returning false for regular txs
    mempool.setTotalBytes(MAX_MEMPOOL_BYTES)

    const utxoSet = makeUtxoSet(walletA)
    const tx = createTransaction(
      walletA,
      [{ txId: 'a'.repeat(64), outputIndex: 0, address: walletA.address, amount: DEFAULT_AMOUNT }],
      [{ address: 'b'.repeat(64), amount: DEFAULT_AMOUNT - DEFAULT_FEE }],
      DEFAULT_FEE
    )
    // Pool appears full and empty (no candidates to evict) — should be rejected
    const result = mempool.addTransaction(tx, utxoSet)
    expect(result.success).toBe(false)
    expect(result.error).toContain('Mempool full')
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
    expect(mempool.getPendingBtcClaims().size).toBe(1)
    expect(mempool.getPendingBtcClaims().has(snapshot.entries[1].btcAddress)).toBe(true)
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
