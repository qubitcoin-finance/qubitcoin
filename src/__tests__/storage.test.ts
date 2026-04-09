import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { FileBlockStorage, sanitizeForStorage, deserializeTransaction, deserializeBlock } from '../storage.js'
import { Blockchain } from '../chain.js'
import {
  createCoinbaseTransaction,
  utxoKey,
} from '../transaction.js'
import {
  computeMerkleRoot,
  computeBlockHash,
  hashMeetsTarget,
  type Block,
  type BlockHeader,
} from '../block.js'

import { walletA } from './fixtures.js'
const TEST_TARGET = '0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

function mineOnChain(chain: Blockchain, minerAddress: string): Block {
  chain.difficulty = TEST_TARGET
  const tip = chain.getChainTip()
  const height = chain.getHeight() + 1
  const coinbase = createCoinbaseTransaction(minerAddress, height, 0)
  const txs = [coinbase]
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

describe('FileBlockStorage', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-storage-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('should write and read blocks round-trip', () => {
    const storage = new FileBlockStorage(tmpDir)
    const chain = new Blockchain()

    const wallet = walletA
    const block = mineOnChain(chain, wallet.address)
    chain.addBlock(block)

    storage.appendBlock(block)
    const loaded = storage.loadBlocks()

    expect(loaded).toHaveLength(1)
    expect(loaded[0].hash).toBe(block.hash)
    expect(loaded[0].height).toBe(block.height)
    expect(loaded[0].header.nonce).toBe(block.header.nonce)
    expect(loaded[0].transactions).toHaveLength(1)
    expect(loaded[0].transactions[0].id).toBe(block.transactions[0].id)
  })

  it('should handle Uint8Array serialization correctly', () => {
    const storage = new FileBlockStorage(tmpDir)
    const chain = new Blockchain()
    const wallet = walletA
    const block = mineOnChain(chain, wallet.address)

    // Verify that Uint8Array fields survive round-trip
    storage.appendBlock(block)
    const loaded = storage.loadBlocks()

    const origInput = block.transactions[0].inputs[0]
    const loadedInput = loaded[0].transactions[0].inputs[0]

    // publicKey and signature should be Uint8Array after deserialization
    expect(loadedInput.publicKey).toBeInstanceOf(Uint8Array)
    expect(loadedInput.signature).toBeInstanceOf(Uint8Array)
  })

  it('should read/write metadata', () => {
    const storage = new FileBlockStorage(tmpDir)

    expect(storage.loadMetadata()).toBeNull()

    const meta = {
      height: 42,
      difficulty: '00000fff' + 'f'.repeat(56),
      genesisHash: 'a'.repeat(64),
    }
    storage.saveMetadata(meta)

    const loaded = storage.loadMetadata()
    expect(loaded).toEqual(meta)
  })

  it('should return empty array for non-existent blocks file', () => {
    const storage = new FileBlockStorage(tmpDir)
    expect(storage.loadBlocks()).toEqual([])
  })

  it('should append multiple blocks', () => {
    const storage = new FileBlockStorage(tmpDir)
    const chain = new Blockchain()
    const wallet = walletA

    const block1 = mineOnChain(chain, wallet.address)
    chain.addBlock(block1)
    storage.appendBlock(block1)

    const block2 = mineOnChain(chain, wallet.address)
    chain.addBlock(block2)
    storage.appendBlock(block2)

    const loaded = storage.loadBlocks()
    expect(loaded).toHaveLength(2)
    expect(loaded[0].hash).toBe(block1.hash)
    expect(loaded[1].hash).toBe(block2.hash)
  })

  it('should rewrite blocks correctly', () => {
    const storage = new FileBlockStorage(tmpDir)
    const chain = new Blockchain()
    const wallet = walletA

    // Mine and append 3 blocks
    const blocks = []
    for (let i = 0; i < 3; i++) {
      const block = mineOnChain(chain, wallet.address)
      chain.addBlock(block)
      storage.appendBlock(block)
      blocks.push(block)
    }

    let loaded = storage.loadBlocks()
    expect(loaded).toHaveLength(3)

    // Rewrite with only the first 2 blocks
    storage.rewriteBlocks(blocks.slice(0, 2))

    loaded = storage.loadBlocks()
    expect(loaded).toHaveLength(2)
    expect(loaded[0].hash).toBe(blocks[0].hash)
    expect(loaded[1].hash).toBe(blocks[1].hash)
  })

  it('should handle rewrite with empty array', () => {
    const storage = new FileBlockStorage(tmpDir)
    const chain = new Blockchain()
    const wallet = walletA

    const block = mineOnChain(chain, wallet.address)
    chain.addBlock(block)
    storage.appendBlock(block)

    storage.rewriteBlocks([])
    const loaded = storage.loadBlocks()
    expect(loaded).toHaveLength(0)
  })

  it('should persist and restore chain state via Blockchain constructor', () => {
    const wallet = walletA

    // Create chain with storage, mine some blocks
    const storage1 = new FileBlockStorage(tmpDir)
    const chain1 = new Blockchain(undefined, storage1)
    chain1.difficulty = TEST_TARGET

    const block1 = mineOnChain(chain1, wallet.address)
    chain1.addBlock(block1)

    const block2 = mineOnChain(chain1, wallet.address)
    chain1.addBlock(block2)

    const height1 = chain1.getHeight()
    const utxoCount1 = chain1.utxoSet.size

    // Create new chain from same storage directory — should restore
    const storage2 = new FileBlockStorage(tmpDir)
    const chain2 = new Blockchain(undefined, storage2)

    expect(chain2.getHeight()).toBe(height1)
    expect(chain2.utxoSet.size).toBe(utxoCount1)
    expect(chain2.blocks[chain2.blocks.length - 1].hash).toBe(block2.hash)
  })
})

describe('deserializeTransaction', () => {
  it('restores publicKey and signature hex strings to Uint8Array', () => {
    const raw = {
      id: 'abc123',
      inputs: [{ txId: 'deadbeef', outputIndex: 0, publicKey: '0102', signature: 'aabb' }],
      outputs: [{ address: 'someaddr', amount: 100 }],
      timestamp: 1000,
    }
    const tx = deserializeTransaction(raw as any)
    expect(tx.inputs[0].publicKey).toBeInstanceOf(Uint8Array)
    expect(tx.inputs[0].publicKey).toEqual(new Uint8Array([0x01, 0x02]))
    expect(tx.inputs[0].signature).toBeInstanceOf(Uint8Array)
    expect(tx.inputs[0].signature).toEqual(new Uint8Array([0xaa, 0xbb]))
  })

  it('restores all claimData binary fields from hex to Uint8Array', () => {
    const raw = {
      id: 'abc123',
      inputs: [],
      outputs: [],
      timestamp: 1000,
      claimData: {
        btcAddress: 'btcaddr',
        qbtcAddress: 'qbtcaddr',
        ecdsaPublicKey: 'aabb',
        ecdsaSignature: 'ccdd',
        schnorrPublicKey: 'eeff',
        schnorrSignature: '1122',
        witnessScript: '3344',
        witnessSignatures: '5566',
      },
    }
    const tx = deserializeTransaction(raw as any)
    const cd = tx.claimData!
    expect(cd.ecdsaPublicKey).toBeInstanceOf(Uint8Array)
    expect(cd.ecdsaPublicKey).toEqual(new Uint8Array([0xaa, 0xbb]))
    expect(cd.ecdsaSignature).toBeInstanceOf(Uint8Array)
    expect(cd.schnorrPublicKey).toBeInstanceOf(Uint8Array)
    expect(cd.schnorrSignature).toBeInstanceOf(Uint8Array)
    expect(cd.witnessScript).toBeInstanceOf(Uint8Array)
    expect(cd.witnessSignatures).toBeInstanceOf(Uint8Array)
  })

  it('handles transaction without claimData', () => {
    const raw = {
      id: 'abc',
      inputs: [{ txId: 'x', outputIndex: 0, publicKey: 'ff', signature: '00' }],
      outputs: [],
      timestamp: 1,
    }
    const tx = deserializeTransaction(raw as any)
    expect(tx.claimData).toBeUndefined()
    expect(tx.inputs[0].publicKey).toBeInstanceOf(Uint8Array)
  })

  it('leaves non-string binary fields unchanged', () => {
    const existingBytes = new Uint8Array([0x01])
    const raw = {
      id: 'abc',
      inputs: [{ txId: 'x', outputIndex: 0, publicKey: existingBytes, signature: existingBytes }],
      outputs: [],
      timestamp: 1,
    }
    const tx = deserializeTransaction(raw as any)
    expect(tx.inputs[0].publicKey).toBe(existingBytes)
  })
})

describe('deserializeBlock', () => {
  it('deserializes all transactions in a block', () => {
    const raw = {
      hash: 'blockhash',
      height: 1,
      header: { version: 1, previousHash: '0'.repeat(64), merkleRoot: 'mr', timestamp: 1, target: 'tt', nonce: 0 },
      transactions: [
        {
          id: 'tx1',
          inputs: [{ txId: 'prev', outputIndex: 0, publicKey: 'aabb', signature: 'ccdd' }],
          outputs: [{ address: 'addr', amount: 50 }],
          timestamp: 1,
        },
        {
          id: 'tx2',
          inputs: [{ txId: 'prev2', outputIndex: 1, publicKey: '1234', signature: '5678' }],
          outputs: [],
          timestamp: 2,
        },
      ],
    }
    const block = deserializeBlock(raw as any)
    expect(block.transactions).toHaveLength(2)
    expect(block.transactions[0].inputs[0].publicKey).toBeInstanceOf(Uint8Array)
    expect(block.transactions[0].inputs[0].publicKey).toEqual(new Uint8Array([0xaa, 0xbb]))
    expect(block.transactions[1].inputs[0].publicKey).toBeInstanceOf(Uint8Array)
    expect(block.transactions[1].inputs[0].publicKey).toEqual(new Uint8Array([0x12, 0x34]))
  })

  it('handles block with no transactions', () => {
    const raw = {
      hash: 'bh',
      height: 0,
      header: { version: 1, previousHash: '0'.repeat(64), merkleRoot: 'mr', timestamp: 1, target: 'tt', nonce: 0 },
      transactions: [],
    }
    const block = deserializeBlock(raw as any)
    expect(block.transactions).toHaveLength(0)
  })
})

describe('sanitizeForStorage', () => {
  it('should convert Uint8Array to hex', () => {
    const result = sanitizeForStorage(new Uint8Array([0xab, 0xcd]))
    expect(result).toBe('abcd')
  })

  it('should handle nested objects', () => {
    const result = sanitizeForStorage({
      a: new Uint8Array([1, 2]),
      b: { c: new Uint8Array([3]) },
    }) as Record<string, unknown>
    expect(result.a).toBe('0102')
    expect((result.b as Record<string, unknown>).c).toBe('03')
  })

  it('should handle arrays', () => {
    const result = sanitizeForStorage([new Uint8Array([0xff])]) as unknown[]
    expect(result[0]).toBe('ff')
  })
})
