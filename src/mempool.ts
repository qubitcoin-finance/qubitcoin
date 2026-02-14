/**
 * Transaction mempool - queue of unconfirmed transactions
 */
import {
  type Transaction,
  type UTXO,
  isClaimTransaction,
  validateTransaction,
  calculateFee,
  utxoKey,
} from './transaction.js'
import { transactionSize } from './block.js'

/** Maximum mempool size in bytes (50 MB) */
export const MAX_MEMPOOL_BYTES = 50 * 1024 * 1024

export class Mempool {
  private transactions: Map<string, Transaction> = new Map()
  private claimedUTXOs: Set<string> = new Set()
  private pendingBtcClaims: Set<string> = new Set() // btcAddress hex
  private totalBytes = 0

  /** Add a validated transaction to the mempool */
  addTransaction(
    tx: Transaction,
    utxoSet: Map<string, UTXO>,
    claimedBtcAddresses?: Set<string>,
    currentHeight?: number
  ): { success: boolean; error?: string } {
    // Already in mempool?
    if (this.transactions.has(tx.id)) {
      return { success: false, error: 'Transaction already in mempool' }
    }

    const txSize = transactionSize(tx)

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

      // Claims always accepted — evict a non-claim tx if needed
      if (this.totalBytes + txSize > MAX_MEMPOOL_BYTES) {
        this.evictLowest(utxoSet, txSize)
      }

      this.transactions.set(tx.id, tx)
      this.pendingBtcClaims.add(claimKey)
      this.totalBytes += txSize
      return { success: true }
    }

    // Validate against UTXO set
    const result = validateTransaction(tx, utxoSet, currentHeight)
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

    // Mempool size limit with eviction
    if (this.totalBytes + txSize > MAX_MEMPOOL_BYTES) {
      const txFeeDensity = calculateFee(tx, utxoSet) / txSize
      const evicted = this.evictLowest(utxoSet, txSize)
      if (!evicted) {
        // Could not free space — new tx has lower fee density than everything in pool
        return { success: false, error: 'Mempool full: transaction fee density too low' }
      }
    }

    // Add to mempool and mark UTXOs as claimed
    this.transactions.set(tx.id, tx)
    for (const input of tx.inputs) {
      this.claimedUTXOs.add(utxoKey(input.txId, input.outputIndex))
    }
    this.totalBytes += txSize

    return { success: true }
  }

  /** Get transactions for inclusion in a block, sorted by fee density (fee/byte) descending */
  getTransactionsForBlock(utxoSet?: Map<string, UTXO>): Transaction[] {
    const txs = Array.from(this.transactions.values())

    // Sort by fee density (fee per byte) if UTXO set available — claims first, then highest fee/byte
    if (utxoSet) {
      txs.sort((a, b) => {
        const aClaim = isClaimTransaction(a) ? 1 : 0
        const bClaim = isClaimTransaction(b) ? 1 : 0
        if (aClaim !== bClaim) return bClaim - aClaim // claims first
        const aFeeDensity = calculateFee(a, utxoSet) / transactionSize(a)
        const bFeeDensity = calculateFee(b, utxoSet) / transactionSize(b)
        return bFeeDensity - aFeeDensity
      })
    }

    return txs
  }

  /** Remove transactions that were included in a mined block */
  removeTransactions(txIds: string[]): void {
    for (const id of txIds) {
      const tx = this.transactions.get(id)
      if (tx) {
        this.totalBytes -= transactionSize(tx)
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

  /** Re-validate all transactions against current UTXO set after a reorg */
  revalidate(utxoSet: Map<string, UTXO>, claimedBtcAddresses: Set<string>, currentHeight?: number): void {
    const toRemove: string[] = []

    for (const [id, tx] of this.transactions) {
      if (isClaimTransaction(tx)) {
        const claimKey = tx.claimData!.btcAddress
        if (claimedBtcAddresses.has(claimKey)) {
          toRemove.push(id)
        }
        continue
      }

      // Re-validate regular transactions against updated UTXO set
      const result = validateTransaction(tx, utxoSet, currentHeight)
      if (!result.valid) {
        toRemove.push(id)
        continue
      }

      // Check that inputs still exist in UTXO set
      for (const input of tx.inputs) {
        const key = utxoKey(input.txId, input.outputIndex)
        if (!utxoSet.has(key)) {
          toRemove.push(id)
          break
        }
      }
    }

    // Remove invalid transactions and rebuild tracking sets
    for (const id of toRemove) {
      const tx = this.transactions.get(id)
      if (tx) {
        this.totalBytes -= transactionSize(tx)
        this.transactions.delete(id)
      }
    }

    // Rebuild claimedUTXOs and pendingBtcClaims from remaining transactions
    this.claimedUTXOs.clear()
    this.pendingBtcClaims.clear()
    for (const tx of this.transactions.values()) {
      if (isClaimTransaction(tx)) {
        this.pendingBtcClaims.add(tx.claimData!.btcAddress)
      } else {
        for (const input of tx.inputs) {
          this.claimedUTXOs.add(utxoKey(input.txId, input.outputIndex))
        }
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
    this.totalBytes = 0
  }

  /** Number of pending transactions */
  size(): number {
    return this.transactions.size
  }

  /** Current mempool size in bytes */
  sizeBytes(): number {
    return this.totalBytes
  }

  /**
   * Evict lowest fee-density non-claim transactions until `needed` bytes are freed.
   * Returns true if enough space was freed, false otherwise.
   */
  private evictLowest(utxoSet: Map<string, UTXO>, needed: number): boolean {
    // Collect non-claim txs sorted by fee density ascending (lowest first)
    const candidates: Array<{ id: string; tx: Transaction; density: number; size: number }> = []
    for (const [id, tx] of this.transactions) {
      if (isClaimTransaction(tx)) continue
      const size = transactionSize(tx)
      const density = calculateFee(tx, utxoSet) / size
      candidates.push({ id, tx, density, size })
    }
    candidates.sort((a, b) => a.density - b.density)

    let freed = 0
    const target = this.totalBytes + needed - MAX_MEMPOOL_BYTES
    for (const c of candidates) {
      if (freed >= target) break
      // Remove this transaction
      this.totalBytes -= c.size
      for (const input of c.tx.inputs) {
        this.claimedUTXOs.delete(utxoKey(input.txId, input.outputIndex))
      }
      this.transactions.delete(c.id)
      freed += c.size
    }

    return freed >= target
  }
}
