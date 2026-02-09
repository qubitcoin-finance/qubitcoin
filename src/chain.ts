/**
 * Blockchain state management
 *
 * Maintains the canonical chain, UTXO set, and handles difficulty adjustment.
 */
import { type UTXO, utxoKey, isCoinbase, isClaimTransaction, validateTransaction } from './transaction.js'
import { type BtcSnapshot } from './snapshot.js'
import { verifyClaimProof } from './claim.js'
import {
  type Block,
  createGenesisBlock,
  createForkGenesisBlock,
  validateBlock,
  computeBlockHash,
  computeMerkleRoot,
  hashMeetsTarget,
  DIFFICULTY_ADJUSTMENT_INTERVAL,
  TARGET_BLOCK_TIME_MS,
  INITIAL_TARGET,
} from './block.js'

export class Blockchain {
  blocks: Block[] = []
  utxoSet: Map<string, UTXO> = new Map()
  difficulty: string = INITIAL_TARGET
  btcSnapshot: BtcSnapshot | null = null
  claimedBtcAddresses: Set<string> = new Set() // btcAddress hex string

  constructor(snapshot?: BtcSnapshot) {
    if (snapshot) {
      this.btcSnapshot = snapshot
      const genesis = createForkGenesisBlock(snapshot)
      this.blocks.push(genesis)
    } else {
      const genesis = createGenesisBlock()
      this.blocks.push(genesis)
    }
    // Genesis coinbase goes to burn address - don't add to UTXO set
  }

  /** Add a validated block to the chain */
  addBlock(block: Block): { success: boolean; error?: string } {
    const previousBlock = this.getChainTip()

    // Validate block structure
    const result = validateBlock(block, previousBlock, this.utxoSet)
    if (!result.valid) {
      return { success: false, error: result.error }
    }

    // Verify claim transactions (ECDSA proofs)
    for (let i = 1; i < block.transactions.length; i++) {
      const tx = block.transactions[i]
      if (isClaimTransaction(tx)) {
        if (!this.btcSnapshot) {
          return { success: false, error: 'No BTC snapshot loaded for claim verification' }
        }
        // Check not already claimed
        const claimKey = tx.claimData!.btcAddress
        if (this.claimedBtcAddresses.has(claimKey)) {
          return { success: false, error: `BTC address already claimed: ${claimKey}` }
        }
        // Verify ECDSA proof
        const claimResult = verifyClaimProof(tx, this.btcSnapshot)
        if (!claimResult.valid) {
          return { success: false, error: `Claim tx ${i} invalid: ${claimResult.error}` }
        }
      }
    }

    // Apply UTXO changes
    this.applyBlock(block)

    // Append to chain
    this.blocks.push(block)

    // Check difficulty adjustment
    if (this.blocks.length % DIFFICULTY_ADJUSTMENT_INTERVAL === 0) {
      this.difficulty = this.adjustDifficulty()
    }

    return { success: true }
  }

  /** Get balance for an address */
  getBalance(address: string): number {
    let balance = 0
    for (const utxo of this.utxoSet.values()) {
      if (utxo.address === address) {
        balance += utxo.amount
      }
    }
    return balance
  }

  /** Find UTXOs for an address, optionally enough to cover an amount */
  findUTXOs(address: string, amount?: number): UTXO[] {
    const result: UTXO[] = []
    let accumulated = 0

    for (const utxo of this.utxoSet.values()) {
      if (utxo.address === address) {
        result.push(utxo)
        accumulated += utxo.amount
        if (amount !== undefined && accumulated >= amount) {
          return result
        }
      }
    }

    return result
  }

  /** Get the chain tip (last block) */
  getChainTip(): Block {
    return this.blocks[this.blocks.length - 1]
  }

  /** Get chain height (0-indexed) */
  getHeight(): number {
    return this.blocks.length - 1
  }

  /** Get current difficulty target */
  getDifficulty(): string {
    return this.difficulty
  }

  /**
   * Adjust difficulty based on actual vs expected block time.
   * Clamped to 4x change in either direction (like Bitcoin).
   */
  adjustDifficulty(): string {
    const chainLen = this.blocks.length
    if (chainLen < DIFFICULTY_ADJUSTMENT_INTERVAL + 1) return this.difficulty

    const latestBlock = this.blocks[chainLen - 1]
    const intervalStart = this.blocks[chainLen - DIFFICULTY_ADJUSTMENT_INTERVAL]

    const actualTime = latestBlock.header.timestamp - intervalStart.header.timestamp
    const expectedTime = DIFFICULTY_ADJUSTMENT_INTERVAL * TARGET_BLOCK_TIME_MS

    // Clamp ratio to [0.25, 4.0]
    let ratio = actualTime / expectedTime
    ratio = Math.max(0.25, Math.min(4.0, ratio))

    // Adjust target: higher ratio = easier (bigger target), lower = harder (smaller)
    const currentTarget = BigInt('0x' + this.difficulty)
    let newTarget =
      (currentTarget * BigInt(Math.round(ratio * 10000))) / 10000n

    // Clamp to max
    const maxTarget = BigInt('0x' + INITIAL_TARGET)
    if (newTarget > maxTarget) newTarget = maxTarget

    // Ensure target is at least 1
    if (newTarget < 1n) newTarget = 1n

    const hex = newTarget.toString(16).padStart(64, '0')
    return hex
  }

  /**
   * Re-validate the entire chain from genesis.
   * Used for tamper detection demo.
   */
  validateChain(): { valid: boolean; error?: string; invalidAtHeight?: number } {
    const tempUtxoSet = new Map<string, UTXO>()
    const tempClaimed = new Set<string>()

    for (let i = 0; i < this.blocks.length; i++) {
      const block = this.blocks[i]
      const prev = i > 0 ? this.blocks[i - 1] : null

      // Re-verify block hash
      const expectedHash = computeBlockHash(block.header)
      if (block.hash !== expectedHash) {
        return {
          valid: false,
          error: `Block ${i}: hash mismatch (expected ${expectedHash.slice(0, 16)}..., got ${block.hash.slice(0, 16)}...)`,
          invalidAtHeight: i,
        }
      }

      // Re-verify PoW
      if (!hashMeetsTarget(block.hash, block.header.target)) {
        return {
          valid: false,
          error: `Block ${i}: hash does not meet target`,
          invalidAtHeight: i,
        }
      }

      // Re-verify previous hash chain
      if (prev && block.header.previousHash !== prev.hash) {
        return {
          valid: false,
          error: `Block ${i}: previous hash mismatch`,
          invalidAtHeight: i,
        }
      }

      // Re-verify merkle root
      const txIds = block.transactions.map((tx) => tx.id)
      const expectedMerkle = computeMerkleRoot(txIds)
      if (block.header.merkleRoot !== expectedMerkle) {
        return {
          valid: false,
          error: `Block ${i}: merkle root mismatch`,
          invalidAtHeight: i,
        }
      }

      // Validate non-coinbase transactions against temp UTXO set
      for (let j = 1; j < block.transactions.length; j++) {
        const tx = block.transactions[j]
        // Re-verify claim transactions
        if (isClaimTransaction(tx) && this.btcSnapshot) {
          const claimKey = tx.claimData!.btcAddress
          if (tempClaimed.has(claimKey)) {
            return {
              valid: false,
              error: `Block ${i}, tx ${j}: double-claim of ${claimKey}`,
              invalidAtHeight: i,
            }
          }
          const claimResult = verifyClaimProof(tx, this.btcSnapshot)
          if (!claimResult.valid) {
            return {
              valid: false,
              error: `Block ${i}, tx ${j}: ${claimResult.error}`,
              invalidAtHeight: i,
            }
          }
          continue
        }
        const result = validateTransaction(tx, tempUtxoSet)
        if (!result.valid) {
          return {
            valid: false,
            error: `Block ${i}, tx ${j}: ${result.error}`,
            invalidAtHeight: i,
          }
        }
      }

      // Apply UTXO changes to temp set
      // Skip genesis coinbase (burn address)
      if (i > 0) {
        for (const tx of block.transactions) {
          if (isClaimTransaction(tx)) {
            // Mark as claimed, add outputs
            const claim = tx.claimData!
            tempClaimed.add(claim.btcAddress)
            for (let k = 0; k < tx.outputs.length; k++) {
              const output = tx.outputs[k]
              tempUtxoSet.set(utxoKey(tx.id, k), {
                txId: tx.id,
                outputIndex: k,
                address: output.address,
                amount: output.amount,
              })
            }
            continue
          }
          // Remove spent UTXOs
          if (!isCoinbase(tx)) {
            for (const input of tx.inputs) {
              tempUtxoSet.delete(utxoKey(input.txId, input.outputIndex))
            }
          }
          // Add new UTXOs
          for (let k = 0; k < tx.outputs.length; k++) {
            const output = tx.outputs[k]
            tempUtxoSet.set(utxoKey(tx.id, k), {
              txId: tx.id,
              outputIndex: k,
              address: output.address,
              amount: output.amount,
            })
          }
        }
      }
    }

    return { valid: true }
  }

  /** Check if a BTC address has been claimed */
  isClaimed(btcAddress: string): boolean {
    return this.claimedBtcAddresses.has(btcAddress)
  }

  /** Get all claimable (unclaimed) BTC address balances */
  getClaimableEntries(): import('./snapshot.js').BtcAddressBalance[] {
    if (!this.btcSnapshot) return []
    return this.btcSnapshot.entries.filter(
      (e) => !this.claimedBtcAddresses.has(e.btcAddress)
    )
  }

  /** Get total value of unclaimed BTC addresses */
  getUnclaimedValue(): number {
    return this.getClaimableEntries().reduce((sum, e) => sum + e.amount, 0)
  }

  /** Get claim statistics */
  getClaimStats(): { totalEntries: number; claimed: number; unclaimed: number; claimedAmount: number; unclaimedAmount: number } {
    if (!this.btcSnapshot) {
      return { totalEntries: 0, claimed: 0, unclaimed: 0, claimedAmount: 0, unclaimedAmount: 0 }
    }
    const entries = this.btcSnapshot.entries
    const claimed = entries.filter((e) => this.claimedBtcAddresses.has(e.btcAddress))
    const unclaimed = entries.filter((e) => !this.claimedBtcAddresses.has(e.btcAddress))
    return {
      totalEntries: entries.length,
      claimed: claimed.length,
      unclaimed: unclaimed.length,
      claimedAmount: claimed.reduce((s, e) => s + e.amount, 0),
      unclaimedAmount: unclaimed.reduce((s, e) => s + e.amount, 0),
    }
  }

  /** Apply UTXO set changes for a validated block (private) */
  private applyBlock(block: Block): void {
    for (const tx of block.transactions) {
      // Handle claim transactions: mark BTC UTXO as claimed, create PQ UTXO
      if (isClaimTransaction(tx)) {
        const claim = tx.claimData!
        this.claimedBtcAddresses.add(claim.btcAddress)
        // Create new PQ UTXO from claim output
        for (let i = 0; i < tx.outputs.length; i++) {
          const output = tx.outputs[i]
          this.utxoSet.set(utxoKey(tx.id, i), {
            txId: tx.id,
            outputIndex: i,
            address: output.address,
            amount: output.amount,
          })
        }
        continue
      }

      // Remove spent UTXOs (skip coinbase inputs)
      if (!isCoinbase(tx)) {
        for (const input of tx.inputs) {
          this.utxoSet.delete(utxoKey(input.txId, input.outputIndex))
        }
      }

      // Add new UTXOs from outputs
      for (let i = 0; i < tx.outputs.length; i++) {
        const output = tx.outputs[i]
        this.utxoSet.set(utxoKey(tx.id, i), {
          txId: tx.id,
          outputIndex: i,
          address: output.address,
          amount: output.amount,
        })
      }
    }
  }
}
