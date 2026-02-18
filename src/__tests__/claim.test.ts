import { describe, it, expect } from 'vitest'
import {
  createClaimTransaction,
  createP2wshClaimTransaction,
  createP2shMultisigClaimTransaction,
  verifyClaimProof,
  serializeClaimMessage,
} from '../claim.js'
import { createMockSnapshot, computeSnapshotMerkleRoot, type BtcAddressBalance, type BtcSnapshot } from '../snapshot.js'
import { generateWallet, generateBtcKeypair, bytesToHex, hash160, doubleSha256Hex, deriveP2shP2wpkhAddress, deriveP2shMultisigAddress, getSchnorrPublicKey, deriveP2trAddress, buildMultisigScript, deriveP2wshAddress, parseWitnessScript } from '../crypto.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { isClaimTransaction, CLAIM_TXID, CLAIM_MATURITY } from '../transaction.js'
import { Blockchain } from '../chain.js'
import { createCoinbaseTransaction, createTransaction, utxoKey } from '../transaction.js'
import {
  computeMerkleRoot,
  computeBlockHash,
  hashMeetsTarget,
  type Block,
  type BlockHeader,
} from '../block.js'

import { walletA as qbtcWalletA, walletB as qbtcWalletB } from './fixtures.js'

// Easy target for tests: ~16 attempts to find valid hash
const TEST_TARGET = '0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

// Dummy genesis hash for standalone claim tests (not going through chain)
const DUMMY_GENESIS = '0'.repeat(64)

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
    timestamp: tip.header.timestamp + 1,
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
