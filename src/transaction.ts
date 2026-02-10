/**
 * UTXO Transaction Model for qcoin
 *
 * Each transaction consumes UTXOs (inputs) and creates new UTXOs (outputs).
 * Inputs carry ML-DSA-65 signatures proving ownership.
 * No script system - ownership is address-based (SHA-256 of public key).
 */
import {
  doubleSha256Hex,
  deriveAddress,
  signData,
  verifySignature,
  uint32LE,
  uint64LE,
  concatBytes,
  bytesToHex,
  type Wallet,
} from './crypto.js'

export interface TransactionInput {
  txId: string           // hex txid of the UTXO being spent
  outputIndex: number    // which output of that tx
  publicKey: Uint8Array  // spender's ML-DSA-65 public key (1,952 bytes)
  signature: Uint8Array  // ML-DSA-65 signature (3,309 bytes)
}

export interface TransactionOutput {
  address: string // recipient address (64-char hex)
  amount: number  // coin amount (integer, satoshi-like units)
}

export interface ClaimData {
  btcAddress: string          // the BTC address being claimed (40-char hex HASH160)
  ecdsaPublicKey: Uint8Array  // compressed secp256k1 public key (33 bytes)
  ecdsaSignature: Uint8Array  // ECDSA signature proving BTC ownership (64 bytes)
  qcoinAddress: string        // destination ML-DSA-65 address
}

export interface Transaction {
  id: string // double-SHA-256 of serialized tx (excluding witness data)
  inputs: TransactionInput[]
  outputs: TransactionOutput[]
  timestamp: number // unix timestamp ms
  claimData?: ClaimData // present only for BTC claim transactions
}

export interface UTXO {
  txId: string
  outputIndex: number
  address: string
  amount: number
}

export const COINBASE_TXID = '0'.repeat(64)
export const CLAIM_TXID = 'c'.repeat(64) // sentinel for BTC claim transactions
export const HALVING_INTERVAL = 210_000

/**
 * Block mining reward.
 * Starts at 3.125 QTC (matching BTC's current post-4th-halving subsidy)
 * and halves every 210,000 blocks from there.
 */
const INITIAL_SUBSIDY = 3.125

export function blockSubsidy(height: number): number {
  const halvings = Math.floor(height / HALVING_INTERVAL)
  if (halvings >= 26) return 0
  return INITIAL_SUBSIDY / Math.pow(2, halvings)
}

/** UTXO map key */
export function utxoKey(txId: string, outputIndex: number): string {
  return `${txId}:${outputIndex}`
}

/**
 * Serialize transaction data for signing (sighash).
 * Excludes signatures and public keys - only structural data.
 */
export function serializeForSigning(
  inputs: Array<{ txId: string; outputIndex: number }>,
  outputs: TransactionOutput[],
  timestamp: number,
  claimData?: ClaimData
): Uint8Array {
  const encoder = new TextEncoder()
  const parts: Uint8Array[] = []

  // Serialize inputs (outpoints only)
  parts.push(uint32LE(inputs.length))
  for (const input of inputs) {
    parts.push(encoder.encode(input.txId))
    parts.push(uint32LE(input.outputIndex))
  }

  // Serialize outputs
  parts.push(uint32LE(outputs.length))
  for (const output of outputs) {
    parts.push(encoder.encode(output.address))
    parts.push(uint64LE(output.amount))
  }

  // Timestamp
  parts.push(uint64LE(timestamp))

  // Include claim data in sighash if present
  if (claimData) {
    parts.push(encoder.encode(claimData.btcAddress))
    parts.push(encoder.encode(claimData.qcoinAddress))
  }

  return concatBytes(...parts)
}

/** Compute transaction ID from unsigned data */
export function computeTxId(
  inputs: Array<{ txId: string; outputIndex: number }>,
  outputs: TransactionOutput[],
  timestamp: number
): string {
  return doubleSha256Hex(serializeForSigning(inputs, outputs, timestamp))
}

/** Check if a transaction is a coinbase */
export function isCoinbase(tx: Transaction): boolean {
  return (
    tx.inputs.length === 1 &&
    tx.inputs[0].txId === COINBASE_TXID &&
    tx.inputs[0].outputIndex === 0xffffffff
  )
}

/** Check if a transaction is a BTC claim */
export function isClaimTransaction(tx: Transaction): boolean {
  return tx.claimData !== undefined
}

/** Create a coinbase transaction (mining reward) */
export function createCoinbaseTransaction(
  minerAddress: string,
  blockHeight: number,
  fees: number
): Transaction {
  const reward = blockSubsidy(blockHeight) + fees
  const timestamp = Date.now()

  const inputs: TransactionInput[] = [
    {
      txId: COINBASE_TXID,
      outputIndex: 0xffffffff,
      publicKey: new Uint8Array(0),
      signature: new Uint8Array(0),
    },
  ]

  const outputs: TransactionOutput[] = [{ address: minerAddress, amount: reward }]

  const id = computeTxId(
    [{ txId: COINBASE_TXID, outputIndex: 0xffffffff }],
    outputs,
    timestamp
  )

  return { id, inputs, outputs, timestamp }
}

/** Create and sign a transaction spending UTXOs */
export function createTransaction(
  wallet: Wallet,
  utxos: UTXO[],
  recipients: Array<{ address: string; amount: number }>,
  fee: number
): Transaction {
  const totalIn = utxos.reduce((sum, u) => sum + u.amount, 0)
  const totalOut = recipients.reduce((sum, r) => sum + r.amount, 0)
  const change = totalIn - totalOut - fee

  if (change < 0) {
    throw new Error(
      `Insufficient funds: have ${totalIn}, need ${totalOut + fee} (${totalOut} + ${fee} fee)`
    )
  }

  // Build outputs
  const outputs: TransactionOutput[] = recipients.map((r) => ({
    address: r.address,
    amount: r.amount,
  }))

  // Add change output if needed
  if (change > 0) {
    outputs.push({ address: wallet.address, amount: change })
  }

  // Build unsigned inputs
  const inputOutpoints = utxos.map((u) => ({
    txId: u.txId,
    outputIndex: u.outputIndex,
  }))

  const timestamp = Date.now()

  // Compute sighash
  const sighash = serializeForSigning(inputOutpoints, outputs, timestamp)

  // Sign each input
  const inputs: TransactionInput[] = utxos.map((u) => ({
    txId: u.txId,
    outputIndex: u.outputIndex,
    publicKey: wallet.publicKey,
    signature: signData(sighash, wallet.secretKey),
  }))

  const id = computeTxId(inputOutpoints, outputs, timestamp)

  return { id, inputs, outputs, timestamp }
}

/** Validate a transaction against the UTXO set */
export function validateTransaction(
  tx: Transaction,
  utxoSet: Map<string, UTXO>
): { valid: boolean; error?: string } {
  if (isCoinbase(tx)) {
    // Coinbase validation is handled at block level
    return { valid: true }
  }

  if (isClaimTransaction(tx)) {
    // Claim validation is handled at chain/block level (ECDSA proof check)
    return { valid: true }
  }

  if (tx.inputs.length === 0) {
    return { valid: false, error: 'Transaction has no inputs' }
  }

  if (tx.outputs.length === 0) {
    return { valid: false, error: 'Transaction has no outputs' }
  }

  // Check for duplicate inputs
  const inputKeys = new Set<string>()
  for (const input of tx.inputs) {
    const key = utxoKey(input.txId, input.outputIndex)
    if (inputKeys.has(key)) {
      return { valid: false, error: `Duplicate input: ${key}` }
    }
    inputKeys.add(key)
  }

  // Verify each input
  let totalIn = 0
  const sighash = serializeForSigning(
    tx.inputs.map((i) => ({ txId: i.txId, outputIndex: i.outputIndex })),
    tx.outputs,
    tx.timestamp
  )

  for (let i = 0; i < tx.inputs.length; i++) {
    const input = tx.inputs[i]
    const key = utxoKey(input.txId, input.outputIndex)
    const utxo = utxoSet.get(key)

    if (!utxo) {
      return { valid: false, error: `UTXO not found: ${key}` }
    }

    // Verify public key matches UTXO owner
    const inputAddress = deriveAddress(input.publicKey)
    if (inputAddress !== utxo.address) {
      return { valid: false, error: `Public key does not match UTXO owner at input ${i}` }
    }

    // Verify signature
    if (!verifySignature(input.signature, sighash, input.publicKey)) {
      return { valid: false, error: `Invalid signature at input ${i}` }
    }

    totalIn += utxo.amount
  }

  // Check amounts
  const totalOut = tx.outputs.reduce((sum, o) => sum + o.amount, 0)
  if (totalIn < totalOut) {
    return {
      valid: false,
      error: `Outputs (${totalOut}) exceed inputs (${totalIn})`,
    }
  }

  // Check all outputs are positive
  for (let i = 0; i < tx.outputs.length; i++) {
    if (tx.outputs[i].amount <= 0) {
      return { valid: false, error: `Output ${i} has non-positive amount` }
    }
  }

  // Verify txId
  const expectedId = computeTxId(
    tx.inputs.map((i) => ({ txId: i.txId, outputIndex: i.outputIndex })),
    tx.outputs,
    tx.timestamp
  )
  if (tx.id !== expectedId) {
    return { valid: false, error: 'Transaction ID mismatch' }
  }

  return { valid: true }
}

/** Calculate the fee of a transaction (input total - output total) */
export function calculateFee(tx: Transaction, utxoSet: Map<string, UTXO>): number {
  if (isCoinbase(tx)) return 0
  if (isClaimTransaction(tx)) return 0 // claims are fee-free

  let totalIn = 0
  for (const input of tx.inputs) {
    const utxo = utxoSet.get(utxoKey(input.txId, input.outputIndex))
    if (utxo) totalIn += utxo.amount
  }

  const totalOut = tx.outputs.reduce((sum, o) => sum + o.amount, 0)
  return totalIn - totalOut
}
