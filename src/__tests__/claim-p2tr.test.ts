import { describe, it, expect } from 'vitest'
import {
  createClaimTransaction,
  verifyClaimProof,
} from '../claim.js'
import { createMockSnapshot } from '../snapshot.js'
import { bytesToHex, getSchnorrPublicKey, deriveP2trAddress } from '../crypto.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { CLAIM_TXID, CLAIM_MATURITY } from '../transaction.js'
import { Blockchain } from '../chain.js'
import { createTransaction } from '../transaction.js'
import { walletA as qbtcWalletA, walletB as qbtcWalletB } from './fixtures.js'
import { mineOnChain } from './claim-test-helpers.js'

describe('verifyClaimProof — P2TR edge cases', () => {
  it('returns error (not crash) for invalid P2TR public key', () => {
    const { snapshot } = createMockSnapshot()
    const p2trEntry = snapshot.entries.find(e => e.type === 'p2tr')!
    const qbtcWallet = qbtcWalletA

    // Construct a claim tx with a 32-byte but invalid schnorrPublicKey
    const tx = {
      id: 'x'.repeat(64),
      inputs: [{ txId: CLAIM_TXID, outputIndex: 0, publicKey: new Uint8Array(0), signature: new Uint8Array(0) }],
      outputs: [{ address: qbtcWallet.address, amount: p2trEntry.amount }],
      timestamp: Date.now(),
      claimData: {
        btcAddress: p2trEntry.btcAddress,
        ecdsaPublicKey: new Uint8Array(0),
        ecdsaSignature: new Uint8Array(0),
        qbtcAddress: qbtcWallet.address,
        schnorrPublicKey: new Uint8Array(32), // all zeros — invalid point
        schnorrSignature: new Uint8Array(64),
      },
    }

    // Should return error, not throw
    const result = verifyClaimProof(tx, snapshot)
    expect(result.valid).toBe(false)
    expect(result.error).toBeDefined()
  })
})

describe('P2TR (Taproot) claims', () => {
  it('deriveP2trAddress produces correct 64-char hex different from internal key', () => {
    const sk = secp256k1.utils.randomSecretKey()
    const internalPubkey = getSchnorrPublicKey(sk)
    const addr = deriveP2trAddress(internalPubkey)
    expect(addr).toHaveLength(64)
    expect(/^[0-9a-f]{64}$/.test(addr)).toBe(true)
    // Tweaked key must differ from internal key
    expect(addr).not.toBe(bytesToHex(internalPubkey))
  })

  it('creates and verifies a P2TR claim', () => {
    const { snapshot, holders } = createMockSnapshot()
    const p2trHolder = holders.find(h => h.type === 'p2tr')!
    expect(p2trHolder).toBeDefined()

    const p2trEntry = snapshot.entries.find(e => e.type === 'p2tr')!
    expect(p2trEntry).toBeDefined()

    const qbtcWallet = qbtcWalletA
    const tx = createClaimTransaction(
      p2trHolder.secretKey,
      p2trHolder.publicKey,
      p2trEntry,
      qbtcWallet,
      snapshot.btcBlockHash
    )

    // Check P2TR claim structure
    expect(tx.claimData!.schnorrPublicKey).toBeDefined()
    expect(tx.claimData!.schnorrPublicKey!.length).toBe(32)
    expect(tx.claimData!.schnorrSignature).toBeDefined()
    expect(tx.claimData!.schnorrSignature!.length).toBe(64)
    expect(tx.claimData!.ecdsaPublicKey.length).toBe(0)
    expect(tx.claimData!.ecdsaSignature.length).toBe(0)

    const result = verifyClaimProof(tx, snapshot)
    expect(result.valid).toBe(true)
  })

  it('rejects wrong key for P2TR claim', () => {
    const { snapshot } = createMockSnapshot()
    const p2trEntry = snapshot.entries.find(e => e.type === 'p2tr')!
    const wrongSk = secp256k1.utils.randomSecretKey()
    const wrongPubkey = getSchnorrPublicKey(wrongSk)
    const qbtcWallet = qbtcWalletA

    const tx = createClaimTransaction(
      wrongSk,
      wrongPubkey,
      p2trEntry,
      qbtcWallet,
      snapshot.btcBlockHash
    )

    const result = verifyClaimProof(tx, snapshot)
    expect(result.valid).toBe(false)
    expect(result.error).toContain('does not match P2TR address')
  })

  it('P2PKH key cannot claim P2TR address', () => {
    const { snapshot, holders } = createMockSnapshot()
    const p2pkhHolder = holders[0]
    const p2trEntry = snapshot.entries.find(e => e.type === 'p2tr')!
    const qbtcWallet = qbtcWalletA

    // P2PKH holder's compressed key (33 bytes) gets used as schnorrPublicKey via P2TR path.
    // Verification rejects because schnorrPublicKey must be exactly 32 bytes.
    const tx = createClaimTransaction(
      p2pkhHolder.secretKey,
      p2pkhHolder.publicKey, // 33-byte compressed key, not 32-byte x-only
      p2trEntry,
      qbtcWallet,
      snapshot.btcBlockHash
    )

    const result = verifyClaimProof(tx, snapshot)
    expect(result.valid).toBe(false)
    expect(result.error).toContain('Schnorr public key')
  })

  it('P2TR key cannot claim P2PKH address', () => {
    const { snapshot, holders } = createMockSnapshot()
    const p2trHolder = holders.find(h => h.type === 'p2tr')!
    const p2pkhEntry = snapshot.entries[0]
    const qbtcWallet = qbtcWalletA

    // P2TR holder tries to claim a P2PKH entry - entry.type is undefined, so ECDSA path
    // But the publicKey is 32-byte x-only, not 33-byte compressed - HASH160 won't match
    const tx = createClaimTransaction(
      p2trHolder.secretKey,
      p2trHolder.publicKey,
      p2pkhEntry,
      qbtcWallet,
      snapshot.btcBlockHash
    )

    const result = verifyClaimProof(tx, snapshot)
    expect(result.valid).toBe(false)
    expect(result.error).toContain('does not match BTC address')
  })

  it('end-to-end: P2TR claim → mine → spend', () => {
    const { snapshot, holders } = createMockSnapshot()
    const chain = new Blockchain(snapshot)
    const genesisHash = chain.blocks[0].hash
    const qbtcWallet = qbtcWalletA
    const recipient = qbtcWalletB

    const p2trHolder = holders.find(h => h.type === 'p2tr')!
    const p2trEntry = snapshot.entries.find(e => e.type === 'p2tr')!

    // Claim
    const claimTx = createClaimTransaction(
      p2trHolder.secretKey,
      p2trHolder.publicKey,
      p2trEntry,
      qbtcWallet,
      snapshot.btcBlockHash,
      genesisHash
    )
    const block1 = mineOnChain(chain, 'f'.repeat(64), [claimTx])
    const addResult = chain.addBlock(block1)
    expect(addResult.success).toBe(true)
    expect(chain.getBalance(qbtcWallet.address)).toBe(p2trHolder.amount)

    // Mine CLAIM_MATURITY blocks to mature the claim output
    for (let i = 0; i < CLAIM_MATURITY; i++) {
      const emptyBlock = mineOnChain(chain, 'f'.repeat(64))
      expect(chain.addBlock(emptyBlock).success).toBe(true)
    }

    // Spend claimed coins
    const utxos = chain.findUTXOs(qbtcWallet.address)
    expect(utxos.length).toBe(1)

    const spendTx = createTransaction(
      qbtcWallet,
      utxos,
      [{ address: recipient.address, amount: 10_000_000_000 }],
      100_000_000
    )
    const block2 = mineOnChain(chain, 'f'.repeat(64), [spendTx])
    const addResult2 = chain.addBlock(block2)
    expect(addResult2.success).toBe(true)

    expect(chain.getBalance(recipient.address)).toBe(10_000_000_000)
    expect(chain.getBalance(qbtcWallet.address)).toBe(p2trHolder.amount - 10_000_000_000 - 100_000_000)
  })
})

describe('verifyClaimProof — improved catch error messages', () => {
  it('includes parse detail when P2TR public key is invalid', () => {
    const { snapshot, holders } = createMockSnapshot()
    const p2trHolder = holders.find(h => h.type === 'p2tr')!
    const p2trEntry = snapshot.entries.find(e => e.type === 'p2tr')!
    const qbtcWallet = qbtcWalletA

    const tx = createClaimTransaction(
      p2trHolder.secretKey,
      p2trHolder.publicKey,
      p2trEntry,
      qbtcWallet,
      snapshot.btcBlockHash
    )
    // Replace schnorrPublicKey with garbage bytes that will fail computeTaprootOutputKey
    tx.claimData!.schnorrPublicKey = new Uint8Array(32).fill(0xff)

    const result = verifyClaimProof(tx, snapshot)
    expect(result.valid).toBe(false)
    // Error should include the detail from the thrown error, not just a bare message
    expect(result.error).toMatch(/Invalid P2TR public key:/)
  })
})
