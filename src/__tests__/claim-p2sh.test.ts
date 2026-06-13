import { describe, it, expect } from 'vitest'
import {
  createClaimTransaction,
  verifyClaimProof,
} from '../claim.js'
import { createMockSnapshot } from '../snapshot.js'
import { generateBtcKeypair, bytesToHex, hash160, deriveP2shP2wpkhAddress } from '../crypto.js'
import { CLAIM_MATURITY } from '../transaction.js'
import { Blockchain } from '../chain.js'
import { createTransaction } from '../transaction.js'
import { walletA as qbtcWalletA, walletB as qbtcWalletB } from './fixtures.js'
import { mineOnChain } from './claim-test-helpers.js'

describe('P2SH-P2WPKH claims', () => {
  it('deriveP2shP2wpkhAddress produces correct 40-char hex', () => {
    const kp = generateBtcKeypair()
    const addr = deriveP2shP2wpkhAddress(kp.publicKey)
    expect(addr).toHaveLength(40)
    expect(/^[0-9a-f]{40}$/.test(addr)).toBe(true)
    // Must differ from plain HASH160
    const plainAddr = bytesToHex(hash160(kp.publicKey))
    expect(addr).not.toBe(plainAddr)
  })

  it('creates and verifies a P2SH-P2WPKH claim', () => {
    const { snapshot, holders } = createMockSnapshot()
    // The last holder is P2SH-P2WPKH
    const p2shHolder = holders.find(h => h.type === 'p2sh')!
    expect(p2shHolder).toBeDefined()

    const p2shEntry = snapshot.entries.find(e => e.type === 'p2sh')!
    expect(p2shEntry).toBeDefined()

    const qbtcWallet = qbtcWalletA
    const tx = createClaimTransaction(
      p2shHolder.secretKey,
      p2shHolder.publicKey,
      p2shEntry,
      qbtcWallet,
      snapshot.btcBlockHash
    )

    const result = verifyClaimProof(tx, snapshot)
    expect(result.valid).toBe(true)
  })

  it('rejects wrong key for P2SH-P2WPKH claim', () => {
    const { snapshot } = createMockSnapshot()
    const p2shEntry = snapshot.entries.find(e => e.type === 'p2sh')!
    const wrongKey = generateBtcKeypair()
    const qbtcWallet = qbtcWalletA

    const tx = createClaimTransaction(
      wrongKey.secretKey,
      wrongKey.publicKey,
      p2shEntry,
      qbtcWallet,
      snapshot.btcBlockHash
    )

    const result = verifyClaimProof(tx, snapshot)
    expect(result.valid).toBe(false)
    expect(result.error).toContain('does not match P2SH-P2WPKH address')
  })

  it('P2PKH key cannot claim P2SH address', () => {
    const { snapshot, holders } = createMockSnapshot()
    // Use a P2PKH holder's key to try claiming a P2SH entry
    const p2pkhHolder = holders[0] // first holder is P2PKH
    const p2shEntry = snapshot.entries.find(e => e.type === 'p2sh')!
    const qbtcWallet = qbtcWalletA

    const tx = createClaimTransaction(
      p2pkhHolder.secretKey,
      p2pkhHolder.publicKey,
      p2shEntry,
      qbtcWallet,
      snapshot.btcBlockHash
    )

    const result = verifyClaimProof(tx, snapshot)
    expect(result.valid).toBe(false)
    expect(result.error).toContain('does not match P2SH-P2WPKH address')
  })

  it('P2SH key cannot claim P2PKH address', () => {
    const { snapshot, holders } = createMockSnapshot()
    // Use a P2SH holder's key to try claiming a P2PKH entry
    const p2shHolder = holders.find(h => h.type === 'p2sh')!
    const p2pkhEntry = snapshot.entries[0] // first entry is P2PKH
    const qbtcWallet = qbtcWalletA

    const tx = createClaimTransaction(
      p2shHolder.secretKey,
      p2shHolder.publicKey,
      p2pkhEntry,
      qbtcWallet,
      snapshot.btcBlockHash
    )

    const result = verifyClaimProof(tx, snapshot)
    expect(result.valid).toBe(false)
    expect(result.error).toContain('does not match BTC address')
  })

  it('end-to-end: P2SH-P2WPKH claim → mine → spend', () => {
    const { snapshot, holders } = createMockSnapshot()
    const chain = new Blockchain(snapshot)
    const genesisHash = chain.blocks[0].hash
    const qbtcWallet = qbtcWalletA
    const recipient = qbtcWalletB

    const p2shHolder = holders.find(h => h.type === 'p2sh')!
    const p2shEntry = snapshot.entries.find(e => e.type === 'p2sh')!

    // Claim
    const claimTx = createClaimTransaction(
      p2shHolder.secretKey,
      p2shHolder.publicKey,
      p2shEntry,
      qbtcWallet,
      snapshot.btcBlockHash,
      genesisHash
    )
    const block1 = mineOnChain(chain, 'f'.repeat(64), [claimTx])
    const addResult = chain.addBlock(block1)
    expect(addResult.success).toBe(true)
    expect(chain.getBalance(qbtcWallet.address)).toBe(p2shHolder.amount)

    // Mine CLAIM_MATURITY blocks to mature the claim output
    for (let i = 0; i < CLAIM_MATURITY; i++) {
      const emptyBlock = mineOnChain(chain, 'f'.repeat(64))
      expect(chain.addBlock(emptyBlock).success).toBe(true)
    }

    // Spend
    const utxos = chain.findUTXOs(qbtcWallet.address)
    expect(utxos.length).toBe(1)

    const spendTx = createTransaction(
      qbtcWallet,
      utxos,
      [{ address: recipient.address, amount: 5_000_000_000 }],
      100_000_000
    )
    const block2 = mineOnChain(chain, 'f'.repeat(64), [spendTx])
    const addResult2 = chain.addBlock(block2)
    expect(addResult2.success).toBe(true)

    expect(chain.getBalance(recipient.address)).toBe(5_000_000_000)
    expect(chain.getBalance(qbtcWallet.address)).toBe(p2shHolder.amount - 5_000_000_000 - 100_000_000)
  })
})
