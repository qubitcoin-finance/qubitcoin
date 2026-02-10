import { describe, it, expect } from 'vitest'
import {
  createClaimTransaction,
  verifyClaimProof,
  serializeClaimMessage,
} from '../claim.js'
import { createMockSnapshot } from '../snapshot.js'
import { generateWallet, generateBtcKeypair, bytesToHex, hash160 } from '../crypto.js'
import { isClaimTransaction, CLAIM_TXID } from '../transaction.js'
import { Blockchain } from '../chain.js'
import { createCoinbaseTransaction, createTransaction, utxoKey } from '../transaction.js'
import {
  computeMerkleRoot,
  computeBlockHash,
  hashMeetsTarget,
  type Block,
  type BlockHeader,
} from '../block.js'

const qtcWalletA = generateWallet()
const qtcWalletB = generateWallet()

// Easy target for tests: ~16 attempts to find valid hash
const TEST_TARGET = '0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

function mineOnChain(chain: Blockchain, minerAddress: string, extraTxs: any[] = []): Block {
  chain.difficulty = TEST_TARGET
  const tip = chain.getChainTip()
  const height = chain.getHeight() + 1
  const coinbase = createCoinbaseTransaction(minerAddress, height, 0)
  const txs = [coinbase, ...extraTxs]
  const merkleRoot = computeMerkleRoot(txs.map((t) => t.id))

  const header: BlockHeader = {
    version: 1,
    previousHash: tip.hash,
    merkleRoot,
    timestamp: Date.now(),
    target: TEST_TARGET,
    nonce: 0,
  }

  let hash = computeBlockHash(header)
  while (!hashMeetsTarget(hash, header.target)) {
    header.nonce++
    hash = computeBlockHash(header)
  }

  return { header, hash, transactions: txs, height }
}

describe('createClaimTransaction', () => {
  it('creates correct structure', () => {
    const { snapshot, holders } = createMockSnapshot()
    const qtcWallet = qtcWalletA

    const tx = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      qtcWallet,
      snapshot.btcBlockHash
    )

    expect(isClaimTransaction(tx)).toBe(true)
    expect(tx.claimData).toBeDefined()
    expect(tx.claimData!.btcAddress).toBe(snapshot.entries[0].btcAddress)
    expect(tx.claimData!.qcoinAddress).toBe(qtcWallet.address)
    expect(tx.inputs[0].txId).toBe(CLAIM_TXID)
    expect(tx.inputs[0].outputIndex).toBe(0)
    expect(tx.outputs.length).toBe(1)
    expect(tx.outputs[0].amount).toBe(holders[0].amount)
    expect(tx.outputs[0].address).toBe(qtcWallet.address)
    expect(tx.id.length).toBe(64)
  })

  it('ECDSA signature is valid', () => {
    const { snapshot, holders } = createMockSnapshot()
    const qtcWallet = qtcWalletA

    const tx = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      qtcWallet,
      snapshot.btcBlockHash
    )

    const result = verifyClaimProof(tx, snapshot)
    expect(result.valid).toBe(true)
  })
})

describe('verifyClaimProof', () => {
  it('accepts valid proof', () => {
    const { snapshot, holders } = createMockSnapshot()
    const qtcWallet = qtcWalletA

    const tx = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      qtcWallet,
      snapshot.btcBlockHash
    )

    expect(verifyClaimProof(tx, snapshot).valid).toBe(true)
  })

  it('rejects wrong ECDSA key', () => {
    const { snapshot, holders } = createMockSnapshot()
    const qtcWallet = qtcWalletA
    const wrongKey = generateBtcKeypair()

    // Sign with wrong key
    const tx = createClaimTransaction(
      wrongKey.secretKey,
      wrongKey.publicKey,
      snapshot.entries[0],
      qtcWallet,
      snapshot.btcBlockHash
    )

    const result = verifyClaimProof(tx, snapshot)
    expect(result.valid).toBe(false)
    expect(result.error).toContain('does not match BTC address')
  })

  it('rejects wrong amount', () => {
    const { snapshot, holders } = createMockSnapshot()
    const qtcWallet = qtcWalletA

    const tx = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      qtcWallet,
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
    const qtcWallet = qtcWalletA

    const tx = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      qtcWallet,
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
    const msg1 = serializeClaimMessage('a'.repeat(40), 'b'.repeat(64), 'c'.repeat(64))
    const msg2 = serializeClaimMessage('a'.repeat(40), 'b'.repeat(64), 'c'.repeat(64))
    expect(bytesToHex(msg1)).toBe(bytesToHex(msg2))
  })

  it('different inputs produce different hashes', () => {
    const msg1 = serializeClaimMessage('a'.repeat(40), 'b'.repeat(64), 'c'.repeat(64))
    const msg2 = serializeClaimMessage('d'.repeat(40), 'b'.repeat(64), 'c'.repeat(64))
    expect(bytesToHex(msg1)).not.toBe(bytesToHex(msg2))
  })
})

describe('end-to-end: claim → mine → spend', () => {
  it('claim, mine, then spend with ML-DSA-65', () => {
    const { snapshot, holders } = createMockSnapshot()
    const chain = new Blockchain(snapshot)
    const qtcWallet = qtcWalletA
    const recipient = qtcWalletB

    // Step 1: Create claim and mine it
    const claimTx = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      qtcWallet,
      snapshot.btcBlockHash
    )
    const block1 = mineOnChain(chain, 'f'.repeat(64), [claimTx])
    const addResult = chain.addBlock(block1)
    expect(addResult.success).toBe(true)
    expect(chain.getBalance(qtcWallet.address)).toBe(holders[0].amount)

    // Step 2: Spend claimed coins with ML-DSA-65
    const utxos = chain.findUTXOs(qtcWallet.address)
    expect(utxos.length).toBe(1)

    const spendTx = createTransaction(
      qtcWallet,
      utxos,
      [{ address: recipient.address, amount: 30 }],
      1
    )

    const block2 = mineOnChain(chain, 'f'.repeat(64), [spendTx])
    const addResult2 = chain.addBlock(block2)
    expect(addResult2.success).toBe(true)

    // Verify balances
    expect(chain.getBalance(recipient.address)).toBe(30)
    expect(chain.getBalance(qtcWallet.address)).toBe(holders[0].amount - 30 - 1) // minus send minus fee
  })
})
