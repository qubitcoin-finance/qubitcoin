import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { FileBlockStorage, sanitizeForStorage, deserializeTransaction, deserializeBlock } from '../storage.js'
import { Blockchain } from '../chain.js'
import { log } from '../log.js'
import {
  createCoinbaseTransaction,
  utxoKey,
  MAX_TX_INPUTS,
  MAX_TX_OUTPUTS,
} from '../transaction.js'
import {
  computeMerkleRoot,
  computeBlockHash,
  hashMeetsTarget,
  MAX_BLOCK_TRANSACTIONS,
  type Block,
  type BlockHeader,
} from '../block.js'

import { walletA } from './fixtures.js'
const TEST_TARGET = '0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
const VALID_BLOCK_HEADER_FIELDS = {
  previousHash: '0'.repeat(64),
  merkleRoot: '1'.repeat(64),
  target: 'f'.repeat(64),
}
const VALID_BLOCK_HASH = '2'.repeat(64)

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

  it('should restore the genesis transaction index via Blockchain constructor', () => {
    const storage1 = new FileBlockStorage(tmpDir)
    const chain1 = new Blockchain(undefined, storage1)
    const genesisTxId = chain1.blocks[0].transactions[0].id

    const storage2 = new FileBlockStorage(tmpDir)
    const chain2 = new Blockchain(undefined, storage2)

    expect(chain2.findTransactionBlock(genesisTxId)).toBe(chain2.blocks[0])
  })

  it('should skip corrupted lines in blocks.jsonl and load valid ones', () => {
    const storage = new FileBlockStorage(tmpDir)
    const chain = new Blockchain()
    const wallet = walletA

    const block1 = mineOnChain(chain, wallet.address)
    chain.addBlock(block1)
    storage.appendBlock(block1)

    const block2 = mineOnChain(chain, wallet.address)
    chain.addBlock(block2)
    storage.appendBlock(block2)

    // Inject a corrupted line between valid blocks
    const blocksPath = path.join(tmpDir, 'blocks.jsonl')
    const lines = fs.readFileSync(blocksPath, 'utf-8').trimEnd().split('\n')
    lines.splice(1, 0, 'NOT VALID JSON {{{')
    fs.writeFileSync(blocksPath, lines.join('\n') + '\n')

    const loaded = storage.loadBlocks()
    expect(loaded).toHaveLength(2)
    expect(loaded[0].hash).toBe(block1.hash)
    expect(loaded[1].hash).toBe(block2.hash)
  })

  it('should skip top-level non-object persisted entries and keep loading valid blocks', () => {
    const storage = new FileBlockStorage(tmpDir)
    const chain = new Blockchain()
    const wallet = walletA
    const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => log)

    const block1 = mineOnChain(chain, wallet.address)
    chain.addBlock(block1)
    const block2 = mineOnChain(chain, wallet.address)
    chain.addBlock(block2)
    const blocksPath = path.join(tmpDir, 'blocks.jsonl')

    fs.writeFileSync(
      blocksPath,
      [
        JSON.stringify(sanitizeForStorage(block1)),
        'null',
        JSON.stringify(sanitizeForStorage(block2)),
      ].join('\n') + '\n'
    )

    const loaded = storage.loadBlocks()

    expect(loaded).toHaveLength(2)
    expect(loaded[0].hash).toBe(block1.hash)
    expect(loaded[1].hash).toBe(block2.hash)
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        component: 'storage',
        line: 2,
        detail: 'Block must be an object',
      }),
      'Skipping corrupted block entry in blocks.jsonl'
    )

    errorSpy.mockRestore()
  })

  it('should skip persisted block entries missing transactions and keep loading valid blocks', () => {
    const storage = new FileBlockStorage(tmpDir)
    const chain = new Blockchain()
    const wallet = walletA
    const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => log)

    const block1 = mineOnChain(chain, wallet.address)
    chain.addBlock(block1)
    const block2 = mineOnChain(chain, wallet.address)
    chain.addBlock(block2)
    const blocksPath = path.join(tmpDir, 'blocks.jsonl')
    const malformedBlock = {
      hash: VALID_BLOCK_HASH,
      height: 1,
      header: {
        version: 1,
        previousHash: VALID_BLOCK_HEADER_FIELDS.previousHash,
        merkleRoot: VALID_BLOCK_HEADER_FIELDS.merkleRoot,
        timestamp: 1,
        target: VALID_BLOCK_HEADER_FIELDS.target,
        nonce: 0,
      },
    }

    fs.writeFileSync(
      blocksPath,
      [
        JSON.stringify(sanitizeForStorage(block1)),
        JSON.stringify(malformedBlock),
        JSON.stringify(sanitizeForStorage(block2)),
      ].join('\n') + '\n'
    )

    const loaded = storage.loadBlocks()

    expect(loaded).toHaveLength(2)
    expect(loaded[0].hash).toBe(block1.hash)
    expect(loaded[1].hash).toBe(block2.hash)
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        component: 'storage',
        line: 2,
        detail: 'Block transactions must be an array',
      }),
      'Skipping corrupted block entry in blocks.jsonl'
    )

    errorSpy.mockRestore()
  })

  it('should return null for corrupted metadata.json', () => {
    const storage = new FileBlockStorage(tmpDir)
    const metadataPath = path.join(tmpDir, 'metadata.json')
    fs.writeFileSync(metadataPath, 'NOT VALID JSON {{{')
    expect(storage.loadMetadata()).toBeNull()
  })

  it('should log line number and transaction detail for malformed persisted blocks', () => {
    const storage = new FileBlockStorage(tmpDir)
    const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => log)
    const blocksPath = path.join(tmpDir, 'blocks.jsonl')
    const malformedBlock = {
      hash: VALID_BLOCK_HASH,
      height: 1,
      header: {
        version: 1,
        previousHash: VALID_BLOCK_HEADER_FIELDS.previousHash,
        merkleRoot: VALID_BLOCK_HEADER_FIELDS.merkleRoot,
        timestamp: 1,
        target: VALID_BLOCK_HEADER_FIELDS.target,
        nonce: 0,
      },
      transactions: [
        {
          id: 'tx1',
          inputs: [null],
          outputs: [],
          timestamp: 1,
        },
      ],
    }

    fs.writeFileSync(blocksPath, JSON.stringify(malformedBlock) + '\n')

    expect(storage.loadBlocks()).toEqual([])
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        component: 'storage',
        line: 1,
        detail: 'Block transaction at index 0 is invalid: Transaction input at index 0 must be an object',
      }),
      'Skipping corrupted block entry in blocks.jsonl'
    )

    errorSpy.mockRestore()
  })

  it('should skip persisted blocks with non-canonical hash strings', () => {
    const storage = new FileBlockStorage(tmpDir)
    const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => log)
    const blocksPath = path.join(tmpDir, 'blocks.jsonl')
    const malformedBlock = {
      hash: 'A'.repeat(64),
      height: 1,
      header: {
        version: 1,
        previousHash: VALID_BLOCK_HEADER_FIELDS.previousHash,
        merkleRoot: VALID_BLOCK_HEADER_FIELDS.merkleRoot,
        timestamp: 1,
        target: VALID_BLOCK_HEADER_FIELDS.target,
        nonce: 0,
      },
      transactions: [],
    }

    fs.writeFileSync(blocksPath, JSON.stringify(malformedBlock) + '\n')

    expect(storage.loadBlocks()).toEqual([])
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        component: 'storage',
        line: 1,
        detail: 'Block hash must be a 64-character lowercase hex string',
      }),
      'Skipping corrupted block entry in blocks.jsonl'
    )

    errorSpy.mockRestore()
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

  it('strips server-owned confirmation metadata from untrusted transactions', () => {
    const raw = {
      id: 'abc',
      inputs: [{ txId: 'x', outputIndex: 0, publicKey: 'ff', signature: '00' }],
      outputs: [],
      timestamp: 1,
      blockHash: 'f'.repeat(64),
      blockHeight: 123,
      confirmations: 456,
    }
    const tx = deserializeTransaction(raw)
    const txRecord = tx as unknown as Record<string, unknown>

    expect(txRecord.blockHash).toBeUndefined()
    expect(txRecord.blockHeight).toBeUndefined()
    expect(txRecord.confirmations).toBeUndefined()
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

  it('throws when publicKey hex exceeds 3904 chars (1952 bytes)', () => {
    const oversized = 'ab'.repeat(1953) // 3906 chars — 1 byte over ML-DSA-65 key size
    const raw = {
      id: 'abc',
      inputs: [{ txId: 'x', outputIndex: 0, publicKey: oversized, signature: '00' }],
      outputs: [],
      timestamp: 1,
    }
    expect(() => deserializeTransaction(raw as any)).toThrow("Field 'publicKey' hex string too large")
  })

  it('throws when signature hex exceeds 6618 chars (3309 bytes)', () => {
    const oversized = 'ab'.repeat(3310) // 6620 chars — 1 byte over ML-DSA-65 signature size
    const raw = {
      id: 'abc',
      inputs: [{ txId: 'x', outputIndex: 0, publicKey: '00', signature: oversized }],
      outputs: [],
      timestamp: 1,
    }
    expect(() => deserializeTransaction(raw as any)).toThrow("Field 'signature' hex string too large")
  })

  it('throws when ecdsaPublicKey hex exceeds 66 chars (33 bytes)', () => {
    const oversized = 'ab'.repeat(34) // 68 chars — over compressed secp256k1 key size
    const raw = {
      id: 'abc',
      inputs: [],
      outputs: [],
      timestamp: 1,
      claimData: { btcAddress: 'addr', qbtcAddress: 'qaddr', ecdsaPublicKey: oversized, ecdsaSignature: '00' },
    }
    expect(() => deserializeTransaction(raw as any)).toThrow("Field 'ecdsaPublicKey' hex string too large")
  })

  it('accepts publicKey hex at exactly the maximum length (3904 chars)', () => {
    const maxSize = 'ab'.repeat(1952) // exactly 3904 chars
    const raw = {
      id: 'abc',
      inputs: [{ txId: 'x', outputIndex: 0, publicKey: maxSize, signature: '00' }],
      outputs: [],
      timestamp: 1,
    }
    const tx = deserializeTransaction(raw as any)
    expect(tx.inputs[0].publicKey).toHaveLength(1952)
  })

  it('throws when input count exceeds MAX_TX_INPUTS before any hex conversion', () => {
    const raw = {
      id: 'abc',
      inputs: new Array(MAX_TX_INPUTS + 1).fill({ txId: 'x', outputIndex: 0, publicKey: '00', signature: '00' }),
      outputs: [],
      timestamp: 1,
    }
    expect(() => deserializeTransaction(raw as any)).toThrow(/input count.*exceeds limit/)
  })

  it('throws when output count exceeds MAX_TX_OUTPUTS before validating output entries', () => {
    const raw = {
      id: 'abc',
      inputs: [],
      outputs: new Array(MAX_TX_OUTPUTS + 1).fill(null),
      timestamp: 1,
    }
    expect(() => deserializeTransaction(raw as any)).toThrow(/output count.*exceeds limit/)
  })

  it('throws when an input entry is not an object', () => {
    const raw = {
      id: 'abc',
      inputs: [null],
      outputs: [],
      timestamp: 1,
    }
    expect(() => deserializeTransaction(raw as any)).toThrow('Transaction input at index 0 must be an object')
  })

  it('throws when claimData is present but not an object', () => {
    const raw = {
      id: 'abc',
      inputs: [],
      outputs: [],
      timestamp: 1,
      claimData: 'not-an-object',
    }
    expect(() => deserializeTransaction(raw as any)).toThrow('Transaction claimData must be an object')
  })

  it('throws when transaction is not an object', () => {
    expect(() => deserializeTransaction(null)).toThrow('Transaction must be an object')
  })

  it('throws when inputs is missing or not an array', () => {
    const raw = {
      id: 'abc',
      outputs: [],
      timestamp: 1,
    }
    expect(() => deserializeTransaction(raw as unknown as Record<string, unknown>)).toThrow('Transaction inputs must be an array')
  })

  it('throws when an input txId is not a string', () => {
    const raw = {
      id: 'abc',
      inputs: [{ txId: 123, outputIndex: 0, publicKey: '00', signature: '00' }],
      outputs: [],
      timestamp: 1,
    }
    expect(() => deserializeTransaction(raw as any)).toThrow('Transaction input at index 0 must have a string txId')
  })

  it('throws when an output entry is not an object', () => {
    const raw = {
      id: 'abc',
      inputs: [],
      outputs: [null],
      timestamp: 1,
    }
    expect(() => deserializeTransaction(raw as any)).toThrow('Transaction output at index 0 must be an object')
  })

  it('throws when an output amount is not a finite number', () => {
    const raw = {
      id: 'abc',
      inputs: [],
      outputs: [{ address: 'someaddr', amount: Number.NaN }],
      timestamp: 1,
    }
    expect(() => deserializeTransaction(raw as any)).toThrow('Transaction output at index 0 must have a finite numeric amount')
  })

  it('throws when claimData addresses are not strings', () => {
    const raw = {
      id: 'abc',
      inputs: [],
      outputs: [],
      timestamp: 1,
      claimData: {
        btcAddress: 123,
        qbtcAddress: 'qbtcaddr',
      },
    }
    expect(() => deserializeTransaction(raw as any)).toThrow('Transaction claimData.btcAddress must be a string')
  })
})

describe('deserializeBlock', () => {
  const validHeaderFields = {
    ...VALID_BLOCK_HEADER_FIELDS,
  }

  it('deserializes all transactions in a block', () => {
    const raw = {
      hash: VALID_BLOCK_HASH,
      height: 1,
      header: { version: 1, previousHash: validHeaderFields.previousHash, merkleRoot: validHeaderFields.merkleRoot, timestamp: 1, target: validHeaderFields.target, nonce: 0 },
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
      hash: VALID_BLOCK_HASH,
      height: 0,
      header: { version: 1, previousHash: validHeaderFields.previousHash, merkleRoot: validHeaderFields.merkleRoot, timestamp: 1, target: validHeaderFields.target, nonce: 0 },
      transactions: [],
    }
    const block = deserializeBlock(raw as any)
    expect(block.transactions).toHaveLength(0)
  })

  it('throws when transaction count exceeds MAX_BLOCK_TRANSACTIONS', () => {
    const raw = {
      hash: VALID_BLOCK_HASH,
      height: 1,
      header: { version: 1, previousHash: validHeaderFields.previousHash, merkleRoot: validHeaderFields.merkleRoot, timestamp: 1, target: validHeaderFields.target, nonce: 0 },
      transactions: new Array(MAX_BLOCK_TRANSACTIONS + 1).fill({ id: 'x', inputs: [], outputs: [], timestamp: 0 }),
    }
    expect(() => deserializeBlock(raw as any)).toThrow(/exceeds limit/)
  })

  it('throws when a transaction entry is not an object', () => {
    const raw = {
      hash: VALID_BLOCK_HASH,
      height: 1,
      header: { version: 1, previousHash: validHeaderFields.previousHash, merkleRoot: validHeaderFields.merkleRoot, timestamp: 1, target: validHeaderFields.target, nonce: 0 },
      transactions: [null],
    }
    expect(() => deserializeBlock(raw as any)).toThrow('Block transaction at index 0 must be an object')
  })

  it('wraps nested transaction failures with the block transaction index', () => {
    const raw = {
      hash: VALID_BLOCK_HASH,
      height: 1,
      header: { version: 1, previousHash: validHeaderFields.previousHash, merkleRoot: validHeaderFields.merkleRoot, timestamp: 1, target: validHeaderFields.target, nonce: 0 },
      transactions: [
        {
          id: 'tx1',
          inputs: [null],
          outputs: [],
          timestamp: 1,
        },
      ],
    }
    expect(() => deserializeBlock(raw as any)).toThrow(
      'Block transaction at index 0 is invalid: Transaction input at index 0 must be an object'
    )
  })

  it('wraps oversized transaction output arrays before validating output entries', () => {
    const raw = {
      hash: VALID_BLOCK_HASH,
      height: 1,
      header: { version: 1, previousHash: validHeaderFields.previousHash, merkleRoot: validHeaderFields.merkleRoot, timestamp: 1, target: validHeaderFields.target, nonce: 0 },
      transactions: [
        {
          id: 'tx1',
          inputs: [],
          outputs: new Array(MAX_TX_OUTPUTS + 1).fill(null),
          timestamp: 1,
        },
      ],
    }
    expect(() => deserializeBlock(raw as any)).toThrow(
      `Block transaction at index 0 is invalid: Transaction output count ${MAX_TX_OUTPUTS + 1} exceeds limit ${MAX_TX_OUTPUTS}`
    )
  })

  it('throws when header is missing', () => {
    const raw = { hash: 'a'.repeat(64), height: 0, transactions: [] }
    expect(() => deserializeBlock(raw as any)).toThrow('Block missing valid header object')
  })

  it('throws when block is null', () => {
    expect(() => deserializeBlock(null)).toThrow('Block must be an object')
  })

  it('throws when block is an array', () => {
    expect(() => deserializeBlock([])).toThrow('Block must be an object')
  })

  it('throws when header is null', () => {
    const raw = { hash: 'a'.repeat(64), height: 0, header: null, transactions: [] }
    expect(() => deserializeBlock(raw as any)).toThrow('Block missing valid header object')
  })

  it('throws when header is a non-object type', () => {
    const raw = { hash: 'a'.repeat(64), height: 0, header: 'not-an-object', transactions: [] }
    expect(() => deserializeBlock(raw as any)).toThrow('Block missing valid header object')
  })

  it('throws when header.version is not a number', () => {
    const raw = {
      hash: 'a'.repeat(64), height: 0,
      header: { version: '1', previousHash: validHeaderFields.previousHash, merkleRoot: validHeaderFields.merkleRoot, timestamp: 1, target: validHeaderFields.target, nonce: 0 },
      transactions: [],
    }
    expect(() => deserializeBlock(raw as any)).toThrow('Block header.version must be a number')
  })

  it('throws when header.previousHash is not a string', () => {
    const raw = {
      hash: 'a'.repeat(64), height: 0,
      header: { version: 1, previousHash: null, merkleRoot: validHeaderFields.merkleRoot, timestamp: 1, target: validHeaderFields.target, nonce: 0 },
      transactions: [],
    }
    expect(() => deserializeBlock(raw as any)).toThrow('Block header.previousHash must be a string')
  })

  it('throws when header.previousHash is not canonical lowercase hex', () => {
    const raw = {
      hash: 'a'.repeat(64), height: 0,
      header: { version: 1, previousHash: 'A'.repeat(64), merkleRoot: validHeaderFields.merkleRoot, timestamp: 1, target: validHeaderFields.target, nonce: 0 },
      transactions: [],
    }
    expect(() => deserializeBlock(raw as any)).toThrow('Block header.previousHash must be a 64-character lowercase hex string')
  })

  it('throws when header.merkleRoot is not a string', () => {
    const raw = {
      hash: 'a'.repeat(64), height: 0,
      header: { version: 1, previousHash: validHeaderFields.previousHash, merkleRoot: 99, timestamp: 1, target: validHeaderFields.target, nonce: 0 },
      transactions: [],
    }
    expect(() => deserializeBlock(raw as any)).toThrow('Block header.merkleRoot must be a string')
  })

  it('throws when header.merkleRoot is not canonical lowercase hex', () => {
    const raw = {
      hash: 'a'.repeat(64), height: 0,
      header: { version: 1, previousHash: validHeaderFields.previousHash, merkleRoot: 'g'.repeat(64), timestamp: 1, target: validHeaderFields.target, nonce: 0 },
      transactions: [],
    }
    expect(() => deserializeBlock(raw as any)).toThrow('Block header.merkleRoot must be a 64-character lowercase hex string')
  })

  it('throws when header.timestamp is not a number', () => {
    const raw = {
      hash: 'a'.repeat(64), height: 0,
      header: { version: 1, previousHash: validHeaderFields.previousHash, merkleRoot: validHeaderFields.merkleRoot, timestamp: '1', target: validHeaderFields.target, nonce: 0 },
      transactions: [],
    }
    expect(() => deserializeBlock(raw as any)).toThrow('Block header.timestamp must be a number')
  })

  it('throws when header.target is not a string', () => {
    const raw = {
      hash: 'a'.repeat(64), height: 0,
      header: { version: 1, previousHash: validHeaderFields.previousHash, merkleRoot: validHeaderFields.merkleRoot, timestamp: 1, target: 42, nonce: 0 },
      transactions: [],
    }
    expect(() => deserializeBlock(raw as any)).toThrow('Block header.target must be a string')
  })

  it('throws when header.target is not canonical lowercase hex', () => {
    const raw = {
      hash: 'a'.repeat(64), height: 0,
      header: { version: 1, previousHash: validHeaderFields.previousHash, merkleRoot: validHeaderFields.merkleRoot, timestamp: 1, target: 'f'.repeat(63), nonce: 0 },
      transactions: [],
    }
    expect(() => deserializeBlock(raw as any)).toThrow('Block header.target must be a 64-character lowercase hex string')
  })

  it('throws when header.nonce is not a number', () => {
    const raw = {
      hash: 'a'.repeat(64), height: 0,
      header: { version: 1, previousHash: validHeaderFields.previousHash, merkleRoot: validHeaderFields.merkleRoot, timestamp: 1, target: validHeaderFields.target, nonce: null },
      transactions: [],
    }
    expect(() => deserializeBlock(raw as any)).toThrow('Block header.nonce must be a number')
  })

  it('throws when hash is missing', () => {
    const raw = {
      height: 0,
      header: { version: 1, previousHash: validHeaderFields.previousHash, merkleRoot: validHeaderFields.merkleRoot, timestamp: 1, target: validHeaderFields.target, nonce: 0 },
      transactions: [],
    }
    expect(() => deserializeBlock(raw as any)).toThrow('Block missing valid hash string')
  })

  it('throws when hash is not a string', () => {
    const raw = {
      hash: 123, height: 0,
      header: { version: 1, previousHash: validHeaderFields.previousHash, merkleRoot: validHeaderFields.merkleRoot, timestamp: 1, target: validHeaderFields.target, nonce: 0 },
      transactions: [],
    }
    expect(() => deserializeBlock(raw as any)).toThrow('Block missing valid hash string')
  })

  it('throws when hash is uppercase hex', () => {
    const raw = {
      hash: 'A'.repeat(64), height: 0,
      header: { version: 1, previousHash: validHeaderFields.previousHash, merkleRoot: validHeaderFields.merkleRoot, timestamp: 1, target: validHeaderFields.target, nonce: 0 },
      transactions: [],
    }
    expect(() => deserializeBlock(raw as any)).toThrow('Block hash must be a 64-character lowercase hex string')
  })

  it('throws when hash is too short', () => {
    const raw = {
      hash: 'a'.repeat(63), height: 0,
      header: { version: 1, previousHash: validHeaderFields.previousHash, merkleRoot: validHeaderFields.merkleRoot, timestamp: 1, target: validHeaderFields.target, nonce: 0 },
      transactions: [],
    }
    expect(() => deserializeBlock(raw as any)).toThrow('Block hash must be a 64-character lowercase hex string')
  })

  it('throws when hash is non-hex', () => {
    const raw = {
      hash: 'g'.repeat(64), height: 0,
      header: { version: 1, previousHash: validHeaderFields.previousHash, merkleRoot: validHeaderFields.merkleRoot, timestamp: 1, target: validHeaderFields.target, nonce: 0 },
      transactions: [],
    }
    expect(() => deserializeBlock(raw as any)).toThrow('Block hash must be a 64-character lowercase hex string')
  })

  it('throws when height is missing', () => {
    const raw = {
      hash: 'a'.repeat(64),
      header: { version: 1, previousHash: validHeaderFields.previousHash, merkleRoot: validHeaderFields.merkleRoot, timestamp: 1, target: validHeaderFields.target, nonce: 0 },
      transactions: [],
    }
    expect(() => deserializeBlock(raw as any)).toThrow('Block height must be a non-negative integer')
  })

  it('throws when height is a float', () => {
    const raw = {
      hash: 'a'.repeat(64), height: 1.5,
      header: { version: 1, previousHash: validHeaderFields.previousHash, merkleRoot: validHeaderFields.merkleRoot, timestamp: 1, target: validHeaderFields.target, nonce: 0 },
      transactions: [],
    }
    expect(() => deserializeBlock(raw as any)).toThrow('Block height must be a non-negative integer')
  })

  it('throws when height is negative', () => {
    const raw = {
      hash: 'a'.repeat(64), height: -1,
      header: { version: 1, previousHash: validHeaderFields.previousHash, merkleRoot: validHeaderFields.merkleRoot, timestamp: 1, target: validHeaderFields.target, nonce: 0 },
      transactions: [],
    }
    expect(() => deserializeBlock(raw as any)).toThrow('Block height must be a non-negative integer')
  })

  it('throws when transactions is missing', () => {
    const raw = {
      hash: 'a'.repeat(64), height: 0,
      header: { version: 1, previousHash: validHeaderFields.previousHash, merkleRoot: validHeaderFields.merkleRoot, timestamp: 1, target: validHeaderFields.target, nonce: 0 },
    }
    expect(() => deserializeBlock(raw as any)).toThrow('Block transactions must be an array')
  })

  it('throws when transactions is not an array', () => {
    const raw = {
      hash: 'a'.repeat(64), height: 0,
      header: { version: 1, previousHash: validHeaderFields.previousHash, merkleRoot: validHeaderFields.merkleRoot, timestamp: 1, target: validHeaderFields.target, nonce: 0 },
      transactions: 'not-an-array',
    }
    expect(() => deserializeBlock(raw as any)).toThrow('Block transactions must be an array')
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
