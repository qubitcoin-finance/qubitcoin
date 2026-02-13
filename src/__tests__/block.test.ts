import { describe, it, expect } from 'vitest'
import {
  computeMerkleRoot,
  computeBlockHash,
  hashMeetsTarget,
  createGenesisBlock,
  createForkGenesisBlock,
  validateBlock,
  INITIAL_TARGET,
} from '../block.js'
import { createCoinbaseTransaction, type UTXO, type Transaction, CLAIM_TXID } from '../transaction.js'
import { doubleSha256Hex } from '../crypto.js'
import { createMockSnapshot } from '../snapshot.js'

describe('computeMerkleRoot', () => {
  it('returns zeros for empty list', () => {
    expect(computeMerkleRoot([])).toBe('0'.repeat(64))
  })

  it('returns the id for single tx', () => {
    const id = 'a'.repeat(64)
    expect(computeMerkleRoot([id])).toBe(id)
  })

  it('returns 64-char hex for two txs', () => {
    const root = computeMerkleRoot(['a'.repeat(64), 'b'.repeat(64)])
    expect(root.length).toBe(64)
    expect(/^[0-9a-f]+$/.test(root)).toBe(true)
  })

  it('handles odd number of txs (duplicates last)', () => {
    const root3 = computeMerkleRoot(['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)])
    expect(root3.length).toBe(64)
    // Should differ from 2-tx root
    const root2 = computeMerkleRoot(['a'.repeat(64), 'b'.repeat(64)])
    expect(root3).not.toBe(root2)
  })
})

describe('computeBlockHash', () => {
  it('returns deterministic 64-char hex', () => {
    const header = {
      version: 1,
      previousHash: '0'.repeat(64),
      merkleRoot: 'a'.repeat(64),
      timestamp: 1000,
      target: INITIAL_TARGET,
      nonce: 0,
    }
    const hash1 = computeBlockHash(header)
    const hash2 = computeBlockHash(header)
    expect(hash1).toBe(hash2)
    expect(hash1.length).toBe(64)
  })

  it('different nonce produces different hash', () => {
    const header1 = {
      version: 1,
      previousHash: '0'.repeat(64),
      merkleRoot: 'a'.repeat(64),
      timestamp: 1000,
      target: INITIAL_TARGET,
      nonce: 0,
    }
    const header2 = { ...header1, nonce: 1 }
    expect(computeBlockHash(header1)).not.toBe(computeBlockHash(header2))
  })
})

describe('hashMeetsTarget', () => {
  it('small hash meets large target', () => {
    const smallHash = '0000' + 'f'.repeat(60)
    const largeTarget = '000f' + 'f'.repeat(60)
    expect(hashMeetsTarget(smallHash, largeTarget)).toBe(true)
  })

  it('large hash fails small target', () => {
    const largeHash = 'ffff' + '0'.repeat(60)
    const smallTarget = '0001' + '0'.repeat(60)
    expect(hashMeetsTarget(largeHash, smallTarget)).toBe(false)
  })

  it('equal hash and target returns false (must be strictly less)', () => {
    const hash = '0001' + '0'.repeat(60)
    expect(hashMeetsTarget(hash, hash)).toBe(false)
  })
})

describe('createGenesisBlock', () => {
  it('creates valid genesis block', () => {
    const genesis = createGenesisBlock()
    expect(genesis.height).toBe(0)
    expect(genesis.header.previousHash).toBe('0'.repeat(64))
    expect(genesis.header.version).toBe(1)
    expect(genesis.transactions.length).toBe(1)
    expect(genesis.hash.length).toBe(64)
    expect(hashMeetsTarget(genesis.hash, INITIAL_TARGET)).toBe(true)
  })
})

describe('createForkGenesisBlock', () => {
  it('creates fork genesis with version 2', () => {
    const { snapshot } = createMockSnapshot()
    const genesis = createForkGenesisBlock(snapshot)
    expect(genesis.header.version).toBe(2)
    expect(genesis.height).toBe(0)
    expect(genesis.transactions[0].outputs[0].amount).toBe(0) // no free coins
    expect(hashMeetsTarget(genesis.hash, INITIAL_TARGET)).toBe(true)
  })
})

describe('validateBlock', () => {
  it('validates genesis block', () => {
    const genesis = createGenesisBlock()
    const result = validateBlock(genesis, null, new Map())
    expect(result.valid).toBe(true)
  })

  it('rejects tampered hash', () => {
    const genesis = createGenesisBlock()
    genesis.hash = 'deadbeef'.repeat(8)
    const result = validateBlock(genesis, null, new Map())
    expect(result.valid).toBe(false)
    expect(result.error).toContain('hash mismatch')
  })

  it('validates claim tx structure in block', () => {
    // A claim tx with correct structure should pass block structural validation
    const genesis = createGenesisBlock()

    const claimTx: Transaction = {
      id: doubleSha256Hex(new TextEncoder().encode('claim-test')),
      inputs: [{ txId: CLAIM_TXID, outputIndex: 0, publicKey: new Uint8Array(0), signature: new Uint8Array(0) }],
      outputs: [{ address: 'a'.repeat(64), amount: 100 }],
      timestamp: Date.now(),
      claimData: {
        btcAddress: 'b'.repeat(40),
        ecdsaPublicKey: new Uint8Array(33),
        ecdsaSignature: new Uint8Array(64),
        qbtcAddress: 'a'.repeat(64),
      },
    }

    // Use easy target for fast test mining
    const easyTarget = '0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

    // Build a block manually with this claim tx
    const coinbase = createCoinbaseTransaction('c'.repeat(64), 1, 0)
    const txs = [coinbase, claimTx]
    const merkleRoot = computeMerkleRoot(txs.map((t) => t.id))

    const header = {
      version: 1,
      previousHash: genesis.hash,
      merkleRoot,
      timestamp: Date.now(),
      target: easyTarget,
      nonce: 0,
    }

    // Find valid nonce (fast with easy target)
    let hash = computeBlockHash(header)
    while (!hashMeetsTarget(hash, easyTarget)) {
      header.nonce++
      hash = computeBlockHash(header)
    }

    const block = { header, hash, transactions: txs, height: 1 }
    const result = validateBlock(block, genesis, new Map())
    expect(result.valid).toBe(true)
  })
})
