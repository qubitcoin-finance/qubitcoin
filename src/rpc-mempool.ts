import { deriveAddress } from './crypto.js'
import { COINBASE_TXID, isClaimTransaction, type Transaction, type TransactionOutput } from './transaction.js'
import { sanitize } from './utils.js'

export interface MempoolTxSummary {
  id: string
  timestamp: number
  sender: string | null
  inputs: Array<{ txId: string; outputIndex: number }>
  outputs: TransactionOutput[]
  claimData?: unknown
}

export function summarizeMempoolTransaction(tx: Transaction): MempoolTxSummary {
  const isCoinbase = tx.inputs.length === 1 && tx.inputs[0].txId === COINBASE_TXID
  const isClaim = isClaimTransaction(tx)
  let sender: string | null = null

  if (!isCoinbase && !isClaim && tx.inputs[0]?.publicKey) {
    sender = deriveAddress(tx.inputs[0].publicKey)
  }

  return {
    id: tx.id,
    timestamp: tx.timestamp,
    sender,
    inputs: tx.inputs.map(i => ({ txId: i.txId, outputIndex: i.outputIndex })),
    outputs: tx.outputs,
    claimData: tx.claimData ? sanitize(tx.claimData) : undefined,
  }
}
