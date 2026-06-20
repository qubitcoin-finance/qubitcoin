/**
 * File-based persistence for blocks and metadata.
 *
 * Blocks are appended to an NDJSON file (blocks.jsonl).
 * Metadata (difficulty, height, genesis hash) stored in metadata.json.
 * Uint8Array fields are serialized as hex strings.
 */
import fs from 'node:fs'
import path from 'node:path'
import { hexToBytes } from './crypto.js'
import { isValidHash, sanitize } from './utils.js'
import { log } from './log.js'
import { MAX_BLOCK_TRANSACTIONS } from './block.js'
import type { Block } from './block.js'
import { MAX_TX_INPUTS, MAX_TX_OUTPUTS } from './transaction.js'
import type { Transaction, TransactionInput, ClaimData } from './transaction.js'

export interface BlockStorageMetadata {
  height: number
  difficulty: string
  genesisHash: string
}

export interface BlockStorage {
  appendBlock(block: Block): void
  rewriteBlocks(blocks: Block[]): void
  loadBlocks(): Block[]
  loadMetadata(): BlockStorageMetadata | null
  saveMetadata(meta: BlockStorageMetadata): void
}

/** Recursively convert Uint8Array fields to hex strings for JSON serialization */
export { sanitize as sanitizeForStorage } from './utils.js'

/** Known Uint8Array fields in transactions that need deserialization */
export const TX_INPUT_BINARY_FIELDS = ['publicKey', 'signature'] as const
export const CLAIM_DATA_BINARY_FIELDS = ['ecdsaPublicKey', 'ecdsaSignature', 'schnorrPublicKey', 'schnorrSignature', 'witnessScript', 'witnessSignatures'] as const
const SERVER_TX_METADATA_FIELDS = ['blockHash', 'blockHeight', 'confirmations'] as const

/**
 * Maximum hex string lengths for binary fields.
 * Prevents DoS via unbounded hexToBytes allocations on untrusted input.
 * Limits are derived from protocol-defined field sizes (2 hex chars per byte).
 */
const BINARY_FIELD_MAX_HEX_LEN: Record<string, number> = {
  publicKey:          3904,  // ML-DSA-65 public key: 1,952 bytes
  signature:          6618,  // ML-DSA-65 signature: 3,309 bytes
  ecdsaPublicKey:       66,  // compressed secp256k1: 33 bytes (0 for P2TR/P2WSH)
  ecdsaSignature:      128,  // ECDSA signature: 64 bytes (0 for P2TR/P2WSH)
  schnorrPublicKey:     64,  // x-only Schnorr pubkey: 32 bytes
  schnorrSignature:    128,  // BIP340 Schnorr signature: 64 bytes
  witnessScript:     10240,  // witness/redeem script: max 5,120 bytes
  witnessSignatures:  3840,  // up to 30 × 64-byte ECDSA sigs
}

type RawTransactionRecord = Record<string, unknown> & {
  id: string
  inputs: unknown[]
  outputs: unknown[]
  timestamp: number
  claimData?: Record<string, unknown>
}

type RawBlockRecord = Record<string, unknown> & {
  transactions: unknown[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeHexToBytes(field: string, hex: string): Uint8Array {
  const maxLen = BINARY_FIELD_MAX_HEX_LEN[field]
  if (maxLen !== undefined && hex.length > maxLen) {
    throw new Error(`Field '${field}' hex string too large: ${hex.length} chars (max ${maxLen})`)
  }
  return hexToBytes(hex)
}

function validateTransactionShape(raw: Record<string, unknown>): void {
  if (typeof raw.id !== 'string') {
    throw new Error('Transaction id must be a string')
  }
  if (!Array.isArray(raw.inputs)) {
    throw new Error('Transaction inputs must be an array')
  }
  if (!Array.isArray(raw.outputs)) {
    throw new Error('Transaction outputs must be an array')
  }
  if (typeof raw.timestamp !== 'number' || !Number.isFinite(raw.timestamp)) {
    throw new Error('Transaction timestamp must be a finite number')
  }
  if (raw.inputs.length > MAX_TX_INPUTS) {
    throw new Error(`Transaction input count ${raw.inputs.length} exceeds limit ${MAX_TX_INPUTS}`)
  }
  if (raw.outputs.length > MAX_TX_OUTPUTS) {
    throw new Error(`Transaction output count ${raw.outputs.length} exceeds limit ${MAX_TX_OUTPUTS}`)
  }

  for (const [index, input] of raw.inputs.entries()) {
    if (!isRecord(input)) {
      throw new Error(`Transaction input at index ${index} must be an object`)
    }
    if (typeof input.txId !== 'string') {
      throw new Error(`Transaction input at index ${index} must have a string txId`)
    }
    const outputIndex = input.outputIndex
    if (typeof outputIndex !== 'number' || !Number.isInteger(outputIndex) || outputIndex < 0) {
      throw new Error(`Transaction input at index ${index} must have a non-negative integer outputIndex`)
    }
  }

  for (const [index, output] of raw.outputs.entries()) {
    if (!isRecord(output)) {
      throw new Error(`Transaction output at index ${index} must be an object`)
    }
    if (typeof output.address !== 'string') {
      throw new Error(`Transaction output at index ${index} must have a string address`)
    }
    if (typeof output.amount !== 'number' || !Number.isFinite(output.amount)) {
      throw new Error(`Transaction output at index ${index} must have a finite numeric amount`)
    }
  }

  if (raw.claimData !== undefined) {
    if (!isRecord(raw.claimData)) {
      throw new Error('Transaction claimData must be an object')
    }
    if (typeof raw.claimData.btcAddress !== 'string') {
      throw new Error('Transaction claimData.btcAddress must be a string')
    }
    if (typeof raw.claimData.qbtcAddress !== 'string') {
      throw new Error('Transaction claimData.qbtcAddress must be a string')
    }
  }
}

/** Restore hex strings back to Uint8Array for known binary fields */
export function deserializeTransaction(raw: unknown): Transaction {
  if (!isRecord(raw)) {
    throw new Error('Transaction must be an object')
  }
  validateTransactionShape(raw)
  const txRaw = raw as RawTransactionRecord
  const txRecord: Record<string, unknown> = { ...raw }
  for (const field of SERVER_TX_METADATA_FIELDS) {
    delete txRecord[field]
  }
  const tx = txRecord as unknown as Transaction

  // Restore inputs
  tx.inputs = txRaw.inputs.map((inp: unknown, index: number) => {
    if (!isRecord(inp)) {
      throw new Error(`Transaction input at index ${index} must be an object`)
    }
    const input = inp as unknown as TransactionInput
    for (const field of TX_INPUT_BINARY_FIELDS) {
      if (typeof inp[field] === 'string') {
        (input as unknown as Record<string, unknown>)[field] = safeHexToBytes(field, inp[field] as string)
      }
    }
    return input
  })

  // Restore claimData
  if (txRaw.claimData !== undefined) {
    const cd = txRaw.claimData
    for (const field of CLAIM_DATA_BINARY_FIELDS) {
      if (typeof cd[field] === 'string') {
        (cd as Record<string, unknown>)[field] = safeHexToBytes(field, cd[field] as string)
      }
    }
    tx.claimData = cd as unknown as ClaimData
  }

  return tx
}

function validateBlockShape(raw: unknown): asserts raw is RawBlockRecord {
  if (!isRecord(raw)) {
    throw new Error('Block must be an object')
  }
  if (!isRecord(raw.header)) {
    throw new Error('Block missing valid header object')
  }
  const hdr = raw.header as Record<string, unknown>
  if (typeof hdr.version !== 'number') throw new Error('Block header.version must be a number')
  if (typeof hdr.previousHash !== 'string') throw new Error('Block header.previousHash must be a string')
  if (!isValidHash(hdr.previousHash)) {
    throw new Error('Block header.previousHash must be a 64-character lowercase hex string')
  }
  if (typeof hdr.merkleRoot !== 'string') throw new Error('Block header.merkleRoot must be a string')
  if (!isValidHash(hdr.merkleRoot)) {
    throw new Error('Block header.merkleRoot must be a 64-character lowercase hex string')
  }
  if (typeof hdr.timestamp !== 'number') throw new Error('Block header.timestamp must be a number')
  if (typeof hdr.target !== 'string') throw new Error('Block header.target must be a string')
  if (!isValidHash(hdr.target)) {
    throw new Error('Block header.target must be a 64-character lowercase hex string')
  }
  if (typeof hdr.nonce !== 'number') throw new Error('Block header.nonce must be a number')
  if (typeof raw.hash !== 'string') throw new Error('Block missing valid hash string')
  if (!isValidHash(raw.hash)) {
    throw new Error('Block hash must be a 64-character lowercase hex string')
  }
  if (!Number.isInteger(raw.height) || (raw.height as number) < 0) {
    throw new Error(`Block height must be a non-negative integer, got ${String(raw.height)}`)
  }
  if (!Array.isArray(raw.transactions)) {
    throw new Error('Block transactions must be an array')
  }
}

export function deserializeBlock(raw: unknown): Block {
  validateBlockShape(raw)
  const block = raw as unknown as Block
  if (raw.transactions.length > MAX_BLOCK_TRANSACTIONS) {
    throw new Error(`Block transaction count ${raw.transactions.length} exceeds limit ${MAX_BLOCK_TRANSACTIONS}`)
  }
  block.transactions = raw.transactions.map((tx, index) => {
    if (!isRecord(tx)) {
      throw new Error(`Block transaction at index ${index} must be an object`)
    }
    try {
      return deserializeTransaction(tx)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      throw new Error(`Block transaction at index ${index} is invalid: ${detail}`)
    }
  })
  return block
}

export class FileBlockStorage implements BlockStorage {
  private readonly blocksPath: string
  private readonly metadataPath: string

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true })
    this.blocksPath = path.join(dataDir, 'blocks.jsonl')
    this.metadataPath = path.join(dataDir, 'metadata.json')
  }

  appendBlock(block: Block): void {
    const serialized = JSON.stringify(sanitize(block))
    fs.appendFileSync(this.blocksPath, serialized + '\n')
  }

  rewriteBlocks(blocks: Block[]): void {
    const lines = blocks.map((b) => JSON.stringify(sanitize(b)))
    fs.writeFileSync(this.blocksPath, lines.join('\n') + (lines.length > 0 ? '\n' : ''))
  }

  loadBlocks(): Block[] {
    let content: string
    try {
      content = fs.readFileSync(this.blocksPath, 'utf-8').trimEnd()
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    if (!content) return []

    const blocks: Block[] = []
    for (const [i, line] of content.split('\n').entries()) {
      try {
        blocks.push(deserializeBlock(JSON.parse(line)))
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        log.error({ component: 'storage', line: i + 1, err, detail }, 'Skipping corrupted block entry in blocks.jsonl')
      }
    }
    return blocks
  }

  loadMetadata(): BlockStorageMetadata | null {
    try {
      const content = fs.readFileSync(this.metadataPath, 'utf-8')
      return JSON.parse(content) as BlockStorageMetadata
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      if (!(err instanceof SyntaxError)) throw err
      log.error({ component: 'storage', err }, 'Failed to parse metadata.json; treating as missing')
      return null
    }
  }

  saveMetadata(meta: BlockStorageMetadata): void {
    fs.writeFileSync(this.metadataPath, JSON.stringify(meta, null, 2) + '\n')
  }
}
