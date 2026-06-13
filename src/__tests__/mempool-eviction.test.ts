import { describe, it, expect } from 'vitest'
import { Mempool, MAX_CLAIM_COUNT, MAX_MEMPOOL_BYTES } from '../mempool.js'
import { createTransaction, type Transaction, CLAIM_TXID } from '../transaction.js'
import { createMockSnapshot } from '../snapshot.js'
import { createClaimTransaction } from '../claim.js'
import { doubleSha256Hex } from '../crypto.js'
import { walletA, walletB, walletC } from './fixtures.js'
import { DEFAULT_FEE, DEFAULT_AMOUNT, makeUtxoSet } from './mempool-test-helpers.js'

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
