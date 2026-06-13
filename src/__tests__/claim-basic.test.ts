import { describe, it, expect } from 'vitest'
import {
  createClaimTransaction,
  verifyClaimProof,
  serializeClaimMessage,
} from '../claim.js'
import { createMockSnapshot } from '../snapshot.js'
import { generateBtcKeypair, bytesToHex } from '../crypto.js'
import { isClaimTransaction, CLAIM_TXID, CLAIM_MATURITY } from '../transaction.js'
import { Blockchain } from '../chain.js'
import { createTransaction } from '../transaction.js'
import { walletA as qbtcWalletA, walletB as qbtcWalletB } from './fixtures.js'
import { mineOnChain } from './claim-test-helpers.js'

describe('createClaimTransaction', () => {
  it('creates correct structure', () => {
    const { snapshot, holders } = createMockSnapshot()
    const qbtcWallet = qbtcWalletA

    const tx = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      qbtcWallet,
      snapshot.btcBlockHash
    )

    expect(isClaimTransaction(tx)).toBe(true)
    expect(tx.claimData).toBeDefined()
    expect(tx.claimData!.btcAddress).toBe(snapshot.entries[0].btcAddress)
    expect(tx.claimData!.qbtcAddress).toBe(qbtcWallet.address)
    expect(tx.inputs[0].txId).toBe(CLAIM_TXID)
    expect(tx.inputs[0].outputIndex).toBe(0)
    expect(tx.outputs.length).toBe(1)
    expect(tx.outputs[0].amount).toBe(holders[0].amount)
    expect(tx.outputs[0].address).toBe(qbtcWallet.address)
    expect(tx.id.length).toBe(64)
  })

  it('ECDSA signature is valid', () => {
    const { snapshot, holders } = createMockSnapshot()
    const qbtcWallet = qbtcWalletA

    const tx = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      qbtcWallet,
      snapshot.btcBlockHash
    )

    const result = verifyClaimProof(tx, snapshot)
    expect(result.valid).toBe(true)
  })
})

describe('verifyClaimProof', () => {
  it('accepts valid proof', () => {
    const { snapshot, holders } = createMockSnapshot()
    const qbtcWallet = qbtcWalletA

    const tx = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      qbtcWallet,
      snapshot.btcBlockHash
    )

    expect(verifyClaimProof(tx, snapshot).valid).toBe(true)
  })

  it('rejects wrong ECDSA key', () => {
    const { snapshot, holders } = createMockSnapshot()
    const qbtcWallet = qbtcWalletA
    const wrongKey = generateBtcKeypair()

    // Sign with wrong key
    const tx = createClaimTransaction(
      wrongKey.secretKey,
      wrongKey.publicKey,
      snapshot.entries[0],
      qbtcWallet,
      snapshot.btcBlockHash
    )

    const result = verifyClaimProof(tx, snapshot)
    expect(result.valid).toBe(false)
    expect(result.error).toContain('does not match BTC address')
  })

  it('rejects wrong amount', () => {
    const { snapshot, holders } = createMockSnapshot()
    const qbtcWallet = qbtcWalletA

    const tx = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      qbtcWallet,
      snapshot.btcBlockHash
    )

    // Tamper with amount
    tx.outputs[0].amount = 999999

    const result = verifyClaimProof(tx, snapshot)
    expect(result.valid).toBe(false)
    expect(result.error).toContain('amount mismatch')
  })

  it('rejects missing entry', () => {
    const { snapshot, holders } = createMockSnapshot()
    const qbtcWallet = qbtcWalletA

    const tx = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      qbtcWallet,
      snapshot.btcBlockHash
    )

    // Tamper with btcAddress in claim data
    tx.claimData!.btcAddress = 'f'.repeat(40)

    const result = verifyClaimProof(tx, snapshot)
    expect(result.valid).toBe(false)
    expect(result.error).toContain('not found in snapshot')
  })

  it('rejects tx without claimData', () => {
    const tx = {
      id: 'x'.repeat(64),
      inputs: [],
      outputs: [{ address: 'a'.repeat(64), amount: 100 }],
      timestamp: Date.now(),
    }

    const { snapshot } = createMockSnapshot()
    const result = verifyClaimProof(tx, snapshot)
    expect(result.valid).toBe(false)
    expect(result.error).toContain('no claim data')
  })
})

describe('serializeClaimMessage', () => {
  it('is deterministic', () => {
    const msg1 = serializeClaimMessage('a'.repeat(40), 'b'.repeat(64), 'c'.repeat(64), 'd'.repeat(64))
    const msg2 = serializeClaimMessage('a'.repeat(40), 'b'.repeat(64), 'c'.repeat(64), 'd'.repeat(64))
    expect(bytesToHex(msg1)).toBe(bytesToHex(msg2))
  })

  it('different inputs produce different hashes', () => {
    const msg1 = serializeClaimMessage('a'.repeat(40), 'b'.repeat(64), 'c'.repeat(64), 'd'.repeat(64))
    const msg2 = serializeClaimMessage('d'.repeat(40), 'b'.repeat(64), 'c'.repeat(64), 'd'.repeat(64))
    expect(bytesToHex(msg1)).not.toBe(bytesToHex(msg2))
  })
})

describe('end-to-end: claim → mine → spend', () => {
  it('claim, mine, then spend with ML-DSA-65', () => {
    const { snapshot, holders } = createMockSnapshot()
    const chain = new Blockchain(snapshot)
    const genesisHash = chain.blocks[0].hash
    const qbtcWallet = qbtcWalletA
    const recipient = qbtcWalletB

    // Step 1: Create claim and mine it
    const claimTx = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      qbtcWallet,
      snapshot.btcBlockHash,
      genesisHash
    )
    const block1 = mineOnChain(chain, 'f'.repeat(64), [claimTx])
    const addResult = chain.addBlock(block1)
    expect(addResult.success).toBe(true)
    expect(chain.getBalance(qbtcWallet.address)).toBe(holders[0].amount)

    // Mine CLAIM_MATURITY blocks to mature the claim output
    for (let i = 0; i < CLAIM_MATURITY; i++) {
      const emptyBlock = mineOnChain(chain, 'f'.repeat(64))
      expect(chain.addBlock(emptyBlock).success).toBe(true)
    }

    // Step 2: Spend claimed coins with ML-DSA-65
    const utxos = chain.findUTXOs(qbtcWallet.address)
    expect(utxos.length).toBe(1)

    const spendTx = createTransaction(
      qbtcWallet,
      utxos,
      [{ address: recipient.address, amount: 3_000_000_000 }],
      100_000_000
    )

    const block2 = mineOnChain(chain, 'f'.repeat(64), [spendTx])
    const addResult2 = chain.addBlock(block2)
    expect(addResult2.success).toBe(true)

    // Verify balances
    expect(chain.getBalance(recipient.address)).toBe(3_000_000_000)
    expect(chain.getBalance(qbtcWallet.address)).toBe(holders[0].amount - 3_000_000_000 - 100_000_000)
  })
})
