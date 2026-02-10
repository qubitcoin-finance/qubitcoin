/**
 * Transaction mempool - queue of unconfirmed transactions
 */
import {
  type Transaction,
  type UTXO,
  isClaimTransaction,
  validateTransaction,
  utxoKey,
} from './transaction.js'

export class Mempool {
  private transactions: Map<string, Transaction> = new Map()
  private claimedUTXOs: Set<string> = new Set()
  private pendingBtcClaims: Set<string> = new Set() // btcAddress hex

  /** Add a validated transaction to the mempool */
  addTransaction(
    tx: Transaction,
    utxoSet: Map<string, UTXO>,
    claimedBtcAddresses?: Set<string>
  ): { success: boolean; error?: string } {
    // Already in mempool?
    if (this.transactions.has(tx.id)) {
      return { success: false, error: 'Transaction already in mempool' }
    }

    // Claim transactions: skip UTXO validation, check for duplicate claims
    if (isClaimTransaction(tx)) {
      const claim = tx.claimData!
      const claimKey = claim.btcAddress

      // Already claimed on-chain?
      if (claimedBtcAddresses?.has(claimKey)) {
        return { success: false, error: `BTC address already claimed on-chain: ${claimKey}` }
      }

      // Already pending in mempool?
      if (this.pendingBtcClaims.has(claimKey)) {
        return { success: false, error: `BTC address already pending claim: ${claimKey}` }
      }

      this.transactions.set(tx.id, tx)
      this.pendingBtcClaims.add(claimKey)
      return { success: true }
    }

    // Validate against UTXO set
    const result = validateTransaction(tx, utxoSet)
    if (!result.valid) {
      return { success: false, error: result.error }
    }

    // Check for double-spend with other mempool transactions
    for (const input of tx.inputs) {
      const key = utxoKey(input.txId, input.outputIndex)
      if (this.claimedUTXOs.has(key)) {
        return {
          success: false,
          error: `UTXO ${key} already claimed by pending transaction`,
        }
      }
    }

    // Add to mempool and mark UTXOs as claimed
    this.transactions.set(tx.id, tx)
    for (const input of tx.inputs) {
      this.claimedUTXOs.add(utxoKey(input.txId, input.outputIndex))
    }

    return { success: true }
  }

  /** Get transactions for inclusion in a block */
  getTransactionsForBlock(maxCount: number = 10): Transaction[] {
    const txs: Transaction[] = []
    for (const tx of this.transactions.values()) {
      txs.push(tx)
      if (txs.length >= maxCount) break
    }
    return txs
  }

  /** Remove transactions that were included in a mined block */
  removeTransactions(txIds: string[]): void {
    for (const id of txIds) {
      const tx = this.transactions.get(id)
      if (tx) {
        if (isClaimTransaction(tx)) {
          const claim = tx.claimData!
          this.pendingBtcClaims.delete(claim.btcAddress)
        } else {
          for (const input of tx.inputs) {
            this.claimedUTXOs.delete(utxoKey(input.txId, input.outputIndex))
          }
        }
        this.transactions.delete(id)
      }
    }
  }

  /** Get a specific transaction */
  getTransaction(txId: string): Transaction | undefined {
    return this.transactions.get(txId)
  }

  /** Clear all pending transactions and tracking state */
  clear(): void {
    this.transactions.clear()
    this.claimedUTXOs.clear()
    this.pendingBtcClaims.clear()
  }

  /** Number of pending transactions */
  size(): number {
    return this.transactions.size
  }
}
