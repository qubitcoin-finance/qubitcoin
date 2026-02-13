import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { FileBlockStorage, sanitizeForStorage } from '../storage.js'
import { Blockchain } from '../chain.js'
import { generateWallet } from '../crypto.js'
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

const walletA = generateWallet()
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
