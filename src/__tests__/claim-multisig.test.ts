import { describe, it, expect } from 'vitest'
import {
  createClaimTransaction,
  createP2wshClaimTransaction,
  createP2shMultisigClaimTransaction,
  verifyClaimProof,
} from '../claim.js'
import { createMockSnapshot, computeSnapshotMerkleRoot, type BtcAddressBalance, type BtcSnapshot } from '../snapshot.js'
import { generateBtcKeypair, bytesToHex, doubleSha256Hex, deriveP2shMultisigAddress, buildMultisigScript, deriveP2wshAddress, parseWitnessScript } from '../crypto.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { CLAIM_MATURITY } from '../transaction.js'
import { Blockchain } from '../chain.js'
import { createTransaction } from '../transaction.js'
import { walletA as qbtcWalletA, walletB as qbtcWalletB } from './fixtures.js'
import { mineOnChain } from './claim-test-helpers.js'

describe('P2WSH claims', () => {
  it('deriveP2wshAddress computes correct 64-char hex SHA256', () => {
    const kp1 = generateBtcKeypair()
    const kp2 = generateBtcKeypair()
    const script = buildMultisigScript(1, [kp1.publicKey, kp2.publicKey])
    const addr = deriveP2wshAddress(script)
    expect(addr).toHaveLength(64)
    expect(/^[0-9a-f]{64}$/.test(addr)).toBe(true)
  })

  it('buildMultisigScript / parseWitnessScript roundtrip', () => {
    const kp1 = generateBtcKeypair()
    const kp2 = generateBtcKeypair()
    const kp3 = generateBtcKeypair()
    const script = buildMultisigScript(2, [kp1.publicKey, kp2.publicKey, kp3.publicKey])
    const parsed = parseWitnessScript(script)
    expect(parsed.type).toBe('multisig')
    if (parsed.type === 'multisig') {
      expect(parsed.m).toBe(2)
      expect(parsed.n).toBe(3)
      expect(parsed.pubkeys.length).toBe(3)
      expect(bytesToHex(parsed.pubkeys[0])).toBe(bytesToHex(kp1.publicKey))
      expect(bytesToHex(parsed.pubkeys[1])).toBe(bytesToHex(kp2.publicKey))
      expect(bytesToHex(parsed.pubkeys[2])).toBe(bytesToHex(kp3.publicKey))
    }
  })

  it('creates and verifies a valid 2-of-3 P2WSH claim', () => {
    const { snapshot, holders } = createMockSnapshot()
    const p2wshHolder = holders.find(h => h.type === 'p2wsh')!
    expect(p2wshHolder).toBeDefined()
    expect(p2wshHolder.signerKeys).toBeDefined()

    const p2wshEntry = snapshot.entries.find(e => e.type === 'p2wsh')!
    expect(p2wshEntry).toBeDefined()

    const qbtcWallet = qbtcWalletA
    // Sign with first two keys (2-of-3)
    const tx = createP2wshClaimTransaction(
      [p2wshHolder.signerKeys![0].secretKey, p2wshHolder.signerKeys![1].secretKey],
      p2wshHolder.witnessScript!,
      p2wshEntry,
      qbtcWallet,
      snapshot.btcBlockHash
    )

    expect(tx.claimData!.witnessScript).toBeDefined()
    expect(tx.claimData!.witnessSignatures).toBeDefined()
    expect(tx.claimData!.witnessSignatures!.length).toBe(128) // 2 × 64

    const result = verifyClaimProof(tx, snapshot)
    expect(result.valid).toBe(true)
  })

  it('rejects wrong witness script (hash mismatch)', () => {
    const { snapshot, holders } = createMockSnapshot()
    const p2wshHolder = holders.find(h => h.type === 'p2wsh')!
    const p2wshEntry = snapshot.entries.find(e => e.type === 'p2wsh')!
    const qbtcWallet = qbtcWalletA

    // Build a different witness script
    const wrongKeys = [generateBtcKeypair(), generateBtcKeypair(), generateBtcKeypair()]
    const wrongScript = buildMultisigScript(2, wrongKeys.map(k => k.publicKey))

    const tx = createP2wshClaimTransaction(
      [wrongKeys[0].secretKey, wrongKeys[1].secretKey],
      p2wshHolder.witnessScript!,
      p2wshEntry,
      qbtcWallet,
      snapshot.btcBlockHash
    )
    // Tamper: replace witness script with wrong one
    tx.claimData!.witnessScript = wrongScript

    const result = verifyClaimProof(tx, snapshot)
    expect(result.valid).toBe(false)
    expect(result.error).toContain('does not match P2WSH address')
  })

  it('rejects insufficient signatures (1 of required 2)', () => {
    const { snapshot, holders } = createMockSnapshot()
    const p2wshHolder = holders.find(h => h.type === 'p2wsh')!
    const p2wshEntry = snapshot.entries.find(e => e.type === 'p2wsh')!
    const qbtcWallet = qbtcWalletA

    // Only provide 1 signature for a 2-of-3
    const tx = createP2wshClaimTransaction(
      [p2wshHolder.signerKeys![0].secretKey],
      p2wshHolder.witnessScript!,
      p2wshEntry,
      qbtcWallet,
      snapshot.btcBlockHash
    )

    const result = verifyClaimProof(tx, snapshot)
    expect(result.valid).toBe(false)
    expect(result.error).toContain('requires exactly 2 signatures')
  })

  it('rejects invalid signature (wrong key)', () => {
    const { snapshot, holders } = createMockSnapshot()
    const p2wshHolder = holders.find(h => h.type === 'p2wsh')!
    const p2wshEntry = snapshot.entries.find(e => e.type === 'p2wsh')!
    const qbtcWallet = qbtcWalletA

    // Sign with one valid key and one wrong key
    const wrongKey = generateBtcKeypair()
    const tx = createP2wshClaimTransaction(
      [p2wshHolder.signerKeys![0].secretKey, wrongKey.secretKey],
      p2wshHolder.witnessScript!,
      p2wshEntry,
      qbtcWallet,
      snapshot.btcBlockHash
    )

    const result = verifyClaimProof(tx, snapshot)
    expect(result.valid).toBe(false)
    expect(result.error).toContain('signatures verified')
  })

  it('rejects cross-type: P2WSH claim against P2PKH entry', () => {
    const { snapshot, holders } = createMockSnapshot()
    const p2wshHolder = holders.find(h => h.type === 'p2wsh')!
    const p2pkhEntry = snapshot.entries[0] // first entry is P2PKH
    const qbtcWallet = qbtcWalletA

    // Try to use P2WSH claim against a P2PKH entry - the witness script hash won't match
    // But we need to bypass the constructor check, so build manually
    const tx = createP2wshClaimTransaction(
      [p2wshHolder.signerKeys![0].secretKey, p2wshHolder.signerKeys![1].secretKey],
      p2wshHolder.witnessScript!,
      { ...p2pkhEntry, btcAddress: p2wshHolder.address, type: 'p2wsh' } as any,
      qbtcWallet,
      snapshot.btcBlockHash
    )
    // Tamper btcAddress to point at P2PKH entry
    tx.claimData!.btcAddress = p2pkhEntry.btcAddress

    const result = verifyClaimProof(tx, snapshot)
    expect(result.valid).toBe(false)
    // P2PKH entry has no type, so it takes the ECDSA path, not P2WSH
    expect(result.error).toContain('does not match BTC address')
  })

  it('end-to-end: P2WSH claim → mine → spend with ML-DSA-65', () => {
    const { snapshot, holders } = createMockSnapshot()
    const chain = new Blockchain(snapshot)
    const genesisHash = chain.blocks[0].hash
    const qbtcWallet = qbtcWalletA
    const recipient = qbtcWalletB

    const p2wshHolder = holders.find(h => h.type === 'p2wsh')!
    const p2wshEntry = snapshot.entries.find(e => e.type === 'p2wsh')!

    // Claim with 2-of-3 signatures
    const claimTx = createP2wshClaimTransaction(
      [p2wshHolder.signerKeys![0].secretKey, p2wshHolder.signerKeys![1].secretKey],
      p2wshHolder.witnessScript!,
      p2wshEntry,
      qbtcWallet,
      snapshot.btcBlockHash,
      genesisHash
    )
    const block1 = mineOnChain(chain, 'f'.repeat(64), [claimTx])
    const addResult = chain.addBlock(block1)
    expect(addResult.success).toBe(true)
    expect(chain.getBalance(qbtcWallet.address)).toBe(p2wshHolder.amount)

    // Mine CLAIM_MATURITY blocks to mature the claim output
    for (let i = 0; i < CLAIM_MATURITY; i++) {
      const emptyBlock = mineOnChain(chain, 'f'.repeat(64))
      expect(chain.addBlock(emptyBlock).success).toBe(true)
    }

    // Spend claimed coins with ML-DSA-65
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
    expect(chain.getBalance(qbtcWallet.address)).toBe(p2wshHolder.amount - 10_000_000_000 - 100_000_000)
  })
})

describe('P2SH multisig claims', () => {
  it('deriveP2shMultisigAddress produces correct 40-char hex', () => {
    const kp1 = generateBtcKeypair()
    const kp2 = generateBtcKeypair()
    const script = buildMultisigScript(1, [kp1.publicKey, kp2.publicKey])
    const addr = deriveP2shMultisigAddress(script)
    expect(addr).toHaveLength(40)
    expect(/^[0-9a-f]{40}$/.test(addr)).toBe(true)
    // Must differ from P2WSH (SHA256 vs HASH160)
    const p2wshAddr = deriveP2wshAddress(script)
    expect(addr).not.toBe(p2wshAddr)
  })

  it('creates and verifies a valid 2-of-3 P2SH multisig claim', () => {
    const { snapshot, holders } = createMockSnapshot()
    const p2shMultisigHolder = holders.find(h => h.type === 'p2sh' && h.signerKeys)!
    expect(p2shMultisigHolder).toBeDefined()
    expect(p2shMultisigHolder.signerKeys).toBeDefined()

    const p2shMultisigEntry = snapshot.entries.find(e =>
      e.type === 'p2sh' && e.btcAddress === p2shMultisigHolder.address
    )!
    expect(p2shMultisigEntry).toBeDefined()

    const qbtcWallet = qbtcWalletA
    const tx = createP2shMultisigClaimTransaction(
      [p2shMultisigHolder.signerKeys![0].secretKey, p2shMultisigHolder.signerKeys![1].secretKey],
      p2shMultisigHolder.witnessScript!,
      p2shMultisigEntry,
      qbtcWallet,
      snapshot.btcBlockHash
    )

    expect(tx.claimData!.witnessScript).toBeDefined()
    expect(tx.claimData!.witnessSignatures).toBeDefined()
    expect(tx.claimData!.witnessSignatures!.length).toBe(128) // 2 × 64

    const result = verifyClaimProof(tx, snapshot)
    expect(result.valid).toBe(true)
  })

  it('rejects wrong redeem script (hash mismatch)', () => {
    const { snapshot, holders } = createMockSnapshot()
    const p2shMultisigHolder = holders.find(h => h.type === 'p2sh' && h.signerKeys)!
    const p2shMultisigEntry = snapshot.entries.find(e =>
      e.type === 'p2sh' && e.btcAddress === p2shMultisigHolder.address
    )!
    const qbtcWallet = qbtcWalletA

    const wrongKeys = [generateBtcKeypair(), generateBtcKeypair(), generateBtcKeypair()]
    const wrongScript = buildMultisigScript(2, wrongKeys.map(k => k.publicKey))

    const tx = createP2shMultisigClaimTransaction(
      [p2shMultisigHolder.signerKeys![0].secretKey, p2shMultisigHolder.signerKeys![1].secretKey],
      p2shMultisigHolder.witnessScript!,
      p2shMultisigEntry,
      qbtcWallet,
      snapshot.btcBlockHash
    )
    tx.claimData!.witnessScript = wrongScript

    const result = verifyClaimProof(tx, snapshot)
    expect(result.valid).toBe(false)
    expect(result.error).toContain('does not match P2SH address')
  })

  it('rejects insufficient signatures (1 of required 2)', () => {
    const { snapshot, holders } = createMockSnapshot()
    const p2shMultisigHolder = holders.find(h => h.type === 'p2sh' && h.signerKeys)!
    const p2shMultisigEntry = snapshot.entries.find(e =>
      e.type === 'p2sh' && e.btcAddress === p2shMultisigHolder.address
    )!
    const qbtcWallet = qbtcWalletA

    const tx = createP2shMultisigClaimTransaction(
      [p2shMultisigHolder.signerKeys![0].secretKey],
      p2shMultisigHolder.witnessScript!,
      p2shMultisigEntry,
      qbtcWallet,
      snapshot.btcBlockHash
    )

    const result = verifyClaimProof(tx, snapshot)
    expect(result.valid).toBe(false)
    expect(result.error).toContain('requires exactly 2 signatures')
  })

  it('rejects invalid signature (wrong key)', () => {
    const { snapshot, holders } = createMockSnapshot()
    const p2shMultisigHolder = holders.find(h => h.type === 'p2sh' && h.signerKeys)!
    const p2shMultisigEntry = snapshot.entries.find(e =>
      e.type === 'p2sh' && e.btcAddress === p2shMultisigHolder.address
    )!
    const qbtcWallet = qbtcWalletA

    const wrongKey = generateBtcKeypair()
    const tx = createP2shMultisigClaimTransaction(
      [p2shMultisigHolder.signerKeys![0].secretKey, wrongKey.secretKey],
      p2shMultisigHolder.witnessScript!,
      p2shMultisigEntry,
      qbtcWallet,
      snapshot.btcBlockHash
    )

    const result = verifyClaimProof(tx, snapshot)
    expect(result.valid).toBe(false)
    expect(result.error).toContain('signatures verified')
  })

  it('P2SH-P2WPKH claim still works alongside P2SH multisig', () => {
    const { snapshot, holders } = createMockSnapshot()
    const p2shP2wpkhHolder = holders.find(h => h.type === 'p2sh' && !h.signerKeys)!
    const p2shP2wpkhEntry = snapshot.entries.find(e =>
      e.type === 'p2sh' && e.btcAddress === p2shP2wpkhHolder.address
    )!
    const qbtcWallet = qbtcWalletA

    const tx = createClaimTransaction(
      p2shP2wpkhHolder.secretKey,
      p2shP2wpkhHolder.publicKey,
      p2shP2wpkhEntry,
      qbtcWallet,
      snapshot.btcBlockHash
    )

    const result = verifyClaimProof(tx, snapshot)
    expect(result.valid).toBe(true)
  })

  it('end-to-end: P2SH multisig claim → mine → spend', () => {
    const { snapshot, holders } = createMockSnapshot()
    const chain = new Blockchain(snapshot)
    const genesisHash = chain.blocks[0].hash
    const qbtcWallet = qbtcWalletA
    const recipient = qbtcWalletB

    const p2shMultisigHolder = holders.find(h => h.type === 'p2sh' && h.signerKeys)!
    const p2shMultisigEntry = snapshot.entries.find(e =>
      e.type === 'p2sh' && e.btcAddress === p2shMultisigHolder.address
    )!

    const claimTx = createP2shMultisigClaimTransaction(
      [p2shMultisigHolder.signerKeys![0].secretKey, p2shMultisigHolder.signerKeys![1].secretKey],
      p2shMultisigHolder.witnessScript!,
      p2shMultisigEntry,
      qbtcWallet,
      snapshot.btcBlockHash,
      genesisHash
    )
    const block1 = mineOnChain(chain, 'f'.repeat(64), [claimTx])
    const addResult = chain.addBlock(block1)
    expect(addResult.success).toBe(true)
    expect(chain.getBalance(qbtcWallet.address)).toBe(p2shMultisigHolder.amount)

    // Mine CLAIM_MATURITY blocks to mature the claim output
    for (let i = 0; i < CLAIM_MATURITY; i++) {
      const emptyBlock = mineOnChain(chain, 'f'.repeat(64))
      expect(chain.addBlock(emptyBlock).success).toBe(true)
    }

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
    expect(chain.getBalance(qbtcWallet.address)).toBe(p2shMultisigHolder.amount - 10_000_000_000 - 100_000_000)
  })
})

describe('Bare multisig claims', () => {
  // Build a custom snapshot with a bare multisig entry
  function createMultisigSnapshot() {
    const kp1 = generateBtcKeypair()
    const kp2 = generateBtcKeypair()
    const kp3 = generateBtcKeypair()
    const script = buildMultisigScript(2, [kp1.publicKey, kp2.publicKey, kp3.publicKey])
    // Bare multisig: SHA256(script) as address
    const address = bytesToHex(sha256(script))
    const amount = 15_000_000_000

    const entry: BtcAddressBalance = {
      btcAddress: address,
      amount,
      type: 'multisig',
    }

    const merkleRoot = computeSnapshotMerkleRoot([entry])
    const snapshot: BtcSnapshot = {
      btcBlockHeight: 850_000,
      btcBlockHash: doubleSha256Hex(new TextEncoder().encode('mock-multisig-block')),
      btcTimestamp: 1739482182,
      entries: [entry],
      merkleRoot,
    }

    return { snapshot, entry, script, keys: [kp1, kp2, kp3] }
  }

  it('accepts valid bare multisig claim (2-of-3)', () => {
    const { snapshot, entry, script, keys } = createMultisigSnapshot()
    const qbtcWallet = qbtcWalletA

    const tx = createP2wshClaimTransaction(
      [keys[0].secretKey, keys[1].secretKey],
      script,
      entry,
      qbtcWallet,
      snapshot.btcBlockHash
    )

    const result = verifyClaimProof(tx, snapshot)
    expect(result.valid).toBe(true)
  })

  it('rejects wrong script for bare multisig', () => {
    const { snapshot, entry, script, keys } = createMultisigSnapshot()
    const qbtcWallet = qbtcWalletA

    const tx = createP2wshClaimTransaction(
      [keys[0].secretKey, keys[1].secretKey],
      script,
      entry,
      qbtcWallet,
      snapshot.btcBlockHash
    )

    // Tamper: replace witness script with a different one
    const wrongKeys = [generateBtcKeypair(), generateBtcKeypair(), generateBtcKeypair()]
    tx.claimData!.witnessScript = buildMultisigScript(2, wrongKeys.map(k => k.publicKey))

    const result = verifyClaimProof(tx, snapshot)
    expect(result.valid).toBe(false)
    expect(result.error).toContain('does not match Bare multisig address')
  })

  it('rejects insufficient signatures for bare multisig', () => {
    const { snapshot, entry, script, keys } = createMultisigSnapshot()
    const qbtcWallet = qbtcWalletA

    // Only provide 1 signature for a 2-of-3
    const tx = createP2wshClaimTransaction(
      [keys[0].secretKey],
      script,
      entry,
      qbtcWallet,
      snapshot.btcBlockHash
    )

    const result = verifyClaimProof(tx, snapshot)
    expect(result.valid).toBe(false)
    expect(result.error).toContain('requires exactly 2 signatures')
  })

  it('rejects invalid signature for bare multisig', () => {
    const { snapshot, entry, script, keys } = createMultisigSnapshot()
    const qbtcWallet = qbtcWalletA

    // Sign with one valid key and one wrong key
    const wrongKey = generateBtcKeypair()
    const tx = createP2wshClaimTransaction(
      [keys[0].secretKey, wrongKey.secretKey],
      script,
      entry,
      qbtcWallet,
      snapshot.btcBlockHash
    )

    const result = verifyClaimProof(tx, snapshot)
    expect(result.valid).toBe(false)
    expect(result.error).toContain('signatures verified')
  })
})

describe('verifyMultisig via verifyClaimProof — missing witnessSignatures', () => {
  it('rejects P2WSH multisig claim with null witnessSignatures', () => {
    const { snapshot, holders } = createMockSnapshot()
    const p2wshHolder = holders.find(h => h.type === 'p2wsh')!
    const p2wshEntry = snapshot.entries.find(e => e.type === 'p2wsh')!
    const qbtcWallet = qbtcWalletA

    const tx = createP2wshClaimTransaction(
      [p2wshHolder.signerKeys![0].secretKey, p2wshHolder.signerKeys![1].secretKey],
      p2wshHolder.witnessScript!,
      p2wshEntry,
      qbtcWallet,
      snapshot.btcBlockHash
    )
    // Remove witnessSignatures to trigger the missing-signatures branch
    tx.claimData!.witnessSignatures = undefined as any

    const result = verifyClaimProof(tx, snapshot)
    expect(result.valid).toBe(false)
    expect(result.error).toContain('missing signatures')
  })

  it('rejects P2SH multisig claim with null witnessSignatures', () => {
    const { snapshot, holders } = createMockSnapshot()
    const p2shMultisigHolder = holders.find(h => h.type === 'p2sh' && h.signerKeys)!
    const p2shMultisigEntry = snapshot.entries.find(e =>
      e.type === 'p2sh' && e.btcAddress === p2shMultisigHolder.address
    )!
    const qbtcWallet = qbtcWalletA

    const tx = createP2shMultisigClaimTransaction(
      [p2shMultisigHolder.signerKeys![0].secretKey, p2shMultisigHolder.signerKeys![1].secretKey],
      p2shMultisigHolder.witnessScript!,
      p2shMultisigEntry,
      qbtcWallet,
      snapshot.btcBlockHash
    )
    tx.claimData!.witnessSignatures = undefined as any

    const result = verifyClaimProof(tx, snapshot)
    expect(result.valid).toBe(false)
    expect(result.error).toContain('missing signatures')
  })
})
