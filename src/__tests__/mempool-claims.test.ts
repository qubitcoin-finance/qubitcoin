import { describe, it, expect } from 'vitest'
import { Mempool, MAX_CLAIM_COUNT } from '../mempool.js'
import { createTransaction, type Transaction, CLAIM_TXID } from '../transaction.js'
import { createMockSnapshot } from '../snapshot.js'
import { createClaimTransaction } from '../claim.js'
import { generateBtcKeypair, doubleSha256Hex } from '../crypto.js'
import { walletA, walletB, walletC } from './fixtures.js'
import { DEFAULT_FEE, DEFAULT_AMOUNT, makeUtxoSet } from './mempool-test-helpers.js'

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
