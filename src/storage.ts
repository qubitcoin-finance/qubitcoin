/**
 * File-based persistence for blocks and metadata.
 *
 * Blocks are appended to an NDJSON file (blocks.jsonl).
 * Metadata (difficulty, height) stored in metadata.json.
 * Uint8Array fields are serialized as hex strings.
 */
import fs from 'node:fs'
import path from 'node:path'
import { bytesToHex, hexToBytes } from './crypto.js'
import type { Block } from './block.js'
import type { Transaction, TransactionInput, ClaimData } from './transaction.js'

export interface BlockStorageMetadata {
  height: number
  difficulty: string
  genesisHash: string
}

export interface BlockStorage {
  appendBlock(block: Block): void
  loadBlocks(): Block[]
  loadMetadata(): BlockStorageMetadata | null
  saveMetadata(meta: BlockStorageMetadata): void
}

/** Recursively convert Uint8Array fields to hex strings for JSON serialization */
export function sanitizeForStorage(obj: unknown): unknown {
  if (obj instanceof Uint8Array) return bytesToHex(obj)
  if (Array.isArray(obj)) return obj.map(sanitizeForStorage)
  if (obj !== null && typeof obj === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) {
      out[k] = sanitizeForStorage(v)
    }
    return out
  }
  return obj
}

/** Known Uint8Array fields in transactions that need deserialization */
const TX_INPUT_BINARY_FIELDS = ['publicKey', 'signature'] as const
const CLAIM_DATA_BINARY_FIELDS = ['ecdsaPublicKey', 'ecdsaSignature'] as const

/** Restore hex strings back to Uint8Array for known binary fields */
function deserializeTransaction(raw: Record<string, unknown>): Transaction {
  const tx = raw as unknown as Transaction

  // Restore inputs
  if (Array.isArray(raw.inputs)) {
    tx.inputs = raw.inputs.map((inp: Record<string, unknown>) => {
      const input = inp as unknown as TransactionInput
      for (const field of TX_INPUT_BINARY_FIELDS) {
        if (typeof inp[field] === 'string') {
          (input as Record<string, unknown>)[field] = hexToBytes(inp[field] as string)
        }
      }
      return input
    })
  }

  // Restore claimData
  if (raw.claimData && typeof raw.claimData === 'object') {
    const cd = raw.claimData as Record<string, unknown>
    for (const field of CLAIM_DATA_BINARY_FIELDS) {
      if (typeof cd[field] === 'string') {
        (cd as Record<string, unknown>)[field] = hexToBytes(cd[field] as string)
      }
    }
    tx.claimData = cd as unknown as ClaimData
  }

  return tx
}

function deserializeBlock(raw: Record<string, unknown>): Block {
  const block = raw as unknown as Block
  if (Array.isArray(raw.transactions)) {
    block.transactions = raw.transactions.map((t: Record<string, unknown>) =>
      deserializeTransaction(t)
    )
  }
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
    const serialized = JSON.stringify(sanitizeForStorage(block))
    fs.appendFileSync(this.blocksPath, serialized + '\n')
  }

  loadBlocks(): Block[] {
    if (!fs.existsSync(this.blocksPath)) return []

    const content = fs.readFileSync(this.blocksPath, 'utf-8').trimEnd()
    if (!content) return []

    return content.split('\n').map((line) => {
      const raw = JSON.parse(line)
      return deserializeBlock(raw)
    })
  }

  loadMetadata(): BlockStorageMetadata | null {
    if (!fs.existsSync(this.metadataPath)) return null
    const content = fs.readFileSync(this.metadataPath, 'utf-8')
    return JSON.parse(content) as BlockStorageMetadata
  }

  saveMetadata(meta: BlockStorageMetadata): void {
    fs.writeFileSync(this.metadataPath, JSON.stringify(meta, null, 2) + '\n')
  }
}
