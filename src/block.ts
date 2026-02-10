/**
 * Block structure for qcoin
 *
 * Block header uses fixed-size binary serialization for consistent hashing.
 * Block hash = doubleSha256(serialized header), same as Bitcoin.
 * Merkle tree uses doubleSha256 pairs, same as Bitcoin.
 */
import {
  doubleSha256,
  doubleSha256Hex,
  uint32LE,
  uint64LE,
  concatBytes,
  bytesToHex,
  hexToBytes,
} from './crypto.js'
import {
  type Transaction,
  type UTXO,
  isCoinbase,
  isClaimTransaction,
  blockSubsidy,
  calculateFee,
  validateTransaction,
  utxoKey,
} from './transaction.js'
import { type BtcSnapshot } from './snapshot.js'

export interface BlockHeader {
  version: number       // protocol version
  previousHash: string  // 64-char hex
  merkleRoot: string    // 64-char hex
  timestamp: number     // unix ms
  target: string        // 64-char hex difficulty target
  nonce: number         // 32-bit PoW nonce
}

export interface Block {
  header: BlockHeader
  hash: string          // doubleSha256 of serialized header
  transactions: Transaction[]
  height: number
}

/**
 * Genesis target — easy, used only for mining the genesis block itself.
 * Tests also use this so they stay fast.
 */
export const INITIAL_TARGET =
  '00000fffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

/**
 * Starting difficulty for the live chain.
 * Currently set easy for testing (~5s blocks). Production target: 0000000fff...
 */
export const STARTING_DIFFICULTY =
  '00000fffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

/** Difficulty adjustment interval (blocks) */
export const DIFFICULTY_ADJUSTMENT_INTERVAL = 10

/** Target block time in ms (30 seconds) */
export const TARGET_BLOCK_TIME_MS = 30_000

/** Maximum block size in bytes (1 MB, same as Bitcoin) */
export const MAX_BLOCK_SIZE = 1_000_000

/** Block header size: version(4) + prevHash(32) + merkleRoot(32) + timestamp(8) + target(32) + nonce(4) = 112 */
const BLOCK_HEADER_SIZE = 112

/** Estimate serialized transaction size in bytes */
export function transactionSize(tx: Transaction): number {
  let size = 32 + 8 // txId(32) + timestamp(8)
  for (const inp of tx.inputs) {
    size += 32 + 4 // txId(32) + outputIndex(4)
    size += (inp.publicKey instanceof Uint8Array ? inp.publicKey.length : 0)
    size += (inp.signature instanceof Uint8Array ? inp.signature.length : 0)
  }
  for (const out of tx.outputs) {
    size += 32 + 8 // address(32) + amount(8)
  }
  if (tx.claimData) {
    size += 20 // btcAddress
    size += (tx.claimData.ecdsaPublicKey instanceof Uint8Array ? tx.claimData.ecdsaPublicKey.length : 33)
    size += (tx.claimData.ecdsaSignature instanceof Uint8Array ? tx.claimData.ecdsaSignature.length : 72)
    size += 32 // qcoinAddress
  }
  return size
}

/** Estimate serialized block size in bytes */
export function blockSize(block: Block): number {
  let size = BLOCK_HEADER_SIZE
  for (const tx of block.transactions) {
    size += transactionSize(tx)
  }
  return size
}

/**
 * Compute merkle root from transaction IDs.
 * Bitcoin-style: doubleSha256(concat(left, right)), duplicate last if odd.
 */
export function computeMerkleRoot(txIds: string[]): string {
  if (txIds.length === 0) return '0'.repeat(64)
  if (txIds.length === 1) return txIds[0]

  let level = txIds.map((id) => hexToBytes(id))

  while (level.length > 1) {
    if (level.length % 2 !== 0) {
      level.push(level[level.length - 1])
    }

    const nextLevel: Uint8Array[] = []
    for (let i = 0; i < level.length; i += 2) {
      nextLevel.push(doubleSha256(concatBytes(level[i], level[i + 1])))
    }
    level = nextLevel
  }

  return bytesToHex(level[0])
}

/** Serialize block header to fixed-size binary for hashing */
export function serializeBlockHeader(header: BlockHeader): Uint8Array {
  return concatBytes(
    uint32LE(header.version),          // 4 bytes
    hexToBytes(header.previousHash),   // 32 bytes
    hexToBytes(header.merkleRoot),     // 32 bytes
    uint64LE(header.timestamp),        // 8 bytes
    hexToBytes(header.target),         // 32 bytes
    uint32LE(header.nonce)             // 4 bytes
  )                                    // total: 112 bytes
}

/** Compute block hash from header */
export function computeBlockHash(header: BlockHeader): string {
  return bytesToHex(doubleSha256(serializeBlockHeader(header)))
}

/** Check if hash meets difficulty target (hash < target) */
export function hashMeetsTarget(hash: string, target: string): boolean {
  return BigInt('0x' + hash) < BigInt('0x' + target)
}

/** Cached genesis block (deterministic — same inputs always produce same result) */
let _cachedGenesis: Block | null = null

/** Create the genesis block (cached — mined once, cloned on subsequent calls) */
export function createGenesisBlock(): Block {
  if (_cachedGenesis) return structuredClone(_cachedGenesis)

  const burnAddress = '0'.repeat(64)
  const timestamp = Date.parse('2025-01-01T00:00:00Z')

  // Genesis coinbase - pays to burn address (unspendable, like Bitcoin's genesis)
  const coinbaseTx: Transaction = {
    id: '',
    inputs: [
      {
        txId: '0'.repeat(64),
        outputIndex: 0xffffffff,
        publicKey: new Uint8Array(0),
        signature: new Uint8Array(0),
      },
    ],
    outputs: [{ address: burnAddress, amount: 0 }],
    timestamp,
  }

  // Compute coinbase txid
  coinbaseTx.id = doubleSha256Hex(
    concatBytes(
      uint32LE(1), // 1 input
      new TextEncoder().encode('0'.repeat(64)),
      uint32LE(0xffffffff),
      uint32LE(1), // 1 output
      new TextEncoder().encode(burnAddress),
      uint64LE(0),
      uint64LE(timestamp)
    )
  )

  const merkleRoot = coinbaseTx.id

  const header: BlockHeader = {
    version: 1,
    previousHash: '0'.repeat(64),
    merkleRoot,
    timestamp,
    target: INITIAL_TARGET,
    nonce: 0,
  }

  // Mine genesis with easy target - find a valid nonce
  let nonce = 0
  let hash = computeBlockHash(header)
  while (!hashMeetsTarget(hash, INITIAL_TARGET)) {
    nonce++
    header.nonce = nonce
    hash = computeBlockHash(header)
  }

  _cachedGenesis = { header, hash, transactions: [coinbaseTx], height: 0 }
  return structuredClone(_cachedGenesis)
}

/** Cached fork genesis blocks (keyed by snapshot merkle root) */
const _cachedForkGenesis = new Map<string, Block>()

/**
 * Create a fork genesis block that commits to a Bitcoin UTXO snapshot.
 * The genesis is tiny: just a coinbase embedding the snapshot commitment.
 * No coins are minted - all value comes from BTC claims.
 * Cached per snapshot (deterministic — same snapshot always produces same result).
 */
export function createForkGenesisBlock(snapshot: BtcSnapshot): Block {
  const cacheKey = snapshot.merkleRoot
  const cached = _cachedForkGenesis.get(cacheKey)
  if (cached) return structuredClone(cached)

  const burnAddress = '0'.repeat(64)
  const timestamp = Date.parse('2025-01-01T00:00:00Z')
  const encoder = new TextEncoder()

  // Genesis coinbase embeds the snapshot commitment
  // Format: "QCOIN_FORK:btcHeight:btcBlockHash:snapshotMerkleRoot"
  const commitmentMsg = `QCOIN_FORK:${snapshot.btcBlockHeight}:${snapshot.btcBlockHash}:${snapshot.merkleRoot}`

  const coinbaseTx: Transaction = {
    id: '',
    inputs: [
      {
        txId: '0'.repeat(64),
        outputIndex: 0xffffffff,
        publicKey: encoder.encode(commitmentMsg), // embed commitment as "pubkey" data
        signature: new Uint8Array(0),
      },
    ],
    outputs: [{ address: burnAddress, amount: 0 }], // no free coins
    timestamp,
  }

  // Compute coinbase txid (includes commitment in hash)
  coinbaseTx.id = doubleSha256Hex(
    concatBytes(
      uint32LE(1),
      encoder.encode('0'.repeat(64)),
      uint32LE(0xffffffff),
      encoder.encode(commitmentMsg),
      uint32LE(1),
      encoder.encode(burnAddress),
      uint64LE(0),
      uint64LE(timestamp)
    )
  )

  const merkleRoot = coinbaseTx.id

  const header: BlockHeader = {
    version: 2, // version 2 = fork genesis
    previousHash: '0'.repeat(64),
    merkleRoot,
    timestamp,
    target: INITIAL_TARGET,
    nonce: 0,
  }

  // Mine genesis
  let nonce = 0
  let hash = computeBlockHash(header)
  while (!hashMeetsTarget(hash, INITIAL_TARGET)) {
    nonce++
    header.nonce = nonce
    hash = computeBlockHash(header)
  }

  const result = { header, hash, transactions: [coinbaseTx], height: 0 }
  _cachedForkGenesis.set(cacheKey, result)
  return structuredClone(result)
}

/** Validate a block against the previous block and UTXO set */
export function validateBlock(
  block: Block,
  previousBlock: Block | null,
  utxoSet: Map<string, UTXO>
): { valid: boolean; error?: string } {
  // Verify block hash
  const expectedHash = computeBlockHash(block.header)
  if (block.hash !== expectedHash) {
    return { valid: false, error: `Block hash mismatch: expected ${expectedHash}, got ${block.hash}` }
  }

  // Verify PoW
  if (!hashMeetsTarget(block.hash, block.header.target)) {
    return { valid: false, error: 'Block hash does not meet difficulty target' }
  }

  // Verify previous hash
  if (previousBlock) {
    if (block.header.previousHash !== previousBlock.hash) {
      return { valid: false, error: 'Previous hash does not match' }
    }
  } else {
    if (block.header.previousHash !== '0'.repeat(64)) {
      return { valid: false, error: 'Genesis block must have zero previous hash' }
    }
  }

  // Verify merkle root
  const txIds = block.transactions.map((tx) => tx.id)
  const expectedMerkle = computeMerkleRoot(txIds)
  if (block.header.merkleRoot !== expectedMerkle) {
    return { valid: false, error: `Merkle root mismatch: expected ${expectedMerkle}` }
  }

  // Verify block size
  const size = blockSize(block)
  if (size > MAX_BLOCK_SIZE) {
    return { valid: false, error: `Block size ${size} exceeds max ${MAX_BLOCK_SIZE}` }
  }

  // First transaction must be coinbase
  if (block.transactions.length === 0) {
    return { valid: false, error: 'Block has no transactions' }
  }
  if (!isCoinbase(block.transactions[0])) {
    return { valid: false, error: 'First transaction must be coinbase' }
  }

  // No other coinbases
  for (let i = 1; i < block.transactions.length; i++) {
    if (isCoinbase(block.transactions[i])) {
      return { valid: false, error: `Transaction ${i} is an unexpected coinbase` }
    }
  }

  // Validate non-coinbase transactions and calculate fees
  let totalFees = 0
  const spentInBlock = new Set<string>()

  for (let i = 1; i < block.transactions.length; i++) {
    const tx = block.transactions[i]

    // Claim transactions: structural validation only (ECDSA proof checked at chain level)
    if (isClaimTransaction(tx)) {
      if (!tx.claimData) {
        return { valid: false, error: `Transaction ${i}: claim tx missing claimData` }
      }
      if (tx.outputs.length !== 1) {
        return { valid: false, error: `Transaction ${i}: claim tx must have exactly 1 output` }
      }
      if (tx.outputs[0].amount <= 0) {
        return { valid: false, error: `Transaction ${i}: claim tx must have positive amount` }
      }
      continue // skip regular UTXO validation
    }

    // Check no double-spend within block
    for (const input of tx.inputs) {
      const key = utxoKey(input.txId, input.outputIndex)
      if (spentInBlock.has(key)) {
        return { valid: false, error: `Double-spend in block: ${key}` }
      }
      spentInBlock.add(key)
    }

    const result = validateTransaction(tx, utxoSet)
    if (!result.valid) {
      return { valid: false, error: `Transaction ${i} invalid: ${result.error}` }
    }

    totalFees += calculateFee(tx, utxoSet)
  }

  // Verify coinbase amount
  const coinbase = block.transactions[0]
  const coinbaseAmount = coinbase.outputs.reduce((sum, o) => sum + o.amount, 0)
  const maxReward = blockSubsidy(block.height) + totalFees
  if (coinbaseAmount > maxReward) {
    return {
      valid: false,
      error: `Coinbase amount ${coinbaseAmount} exceeds max reward ${maxReward}`,
    }
  }

  return { valid: true }
}
