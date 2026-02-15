/**
 * Blockchain state management
 *
 * Maintains the canonical chain, UTXO set, and handles difficulty adjustment.
 */
import { type UTXO, utxoKey, isCoinbase, isClaimTransaction, validateTransaction, COINBASE_MATURITY } from './transaction.js'
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
  blockWork,
  DIFFICULTY_ADJUSTMENT_INTERVAL,
  TARGET_BLOCK_TIME_MS,
  STARTING_DIFFICULTY,
} from './block.js'
import { type BlockStorage } from './storage.js'
import { getSnapshotIndex, type ShardedIndex } from './snapshot.js'

export interface BlockUndo {
  spentUtxos: Array<{ key: string; utxo: UTXO }>  // UTXOs consumed by inputs — restore on disconnect
  createdUtxoKeys: string[]                         // UTXOs created by outputs — remove on disconnect
  claimedAddresses: string[]                        // BTC addresses claimed — unclaim on disconnect
  previousDifficulty: string                        // difficulty before this block — restore on disconnect
  blockWork: bigint                                 // work contributed by this block — subtract on disconnect
}

export class Blockchain {
  blocks: Block[] = []
  undoData: BlockUndo[] = []
  utxoSet: Map<string, UTXO> = new Map()
  difficulty: string = STARTING_DIFFICULTY
  btcSnapshot: BtcSnapshot | null = null
  claimedBtcAddresses: Set<string> = new Set() // btcAddress hex string
  private storage: BlockStorage | null = null
  private replayHeight = -1 // height of last block loaded from storage
  private snapshotIndex: ShardedIndex | null = null
  private snapshotTotalEntries = 0
  private snapshotTotalAmount = 0
  private claimedCount = 0
  private claimedAmount = 0
  cumulativeWork: bigint = 0n

  constructor(snapshot?: BtcSnapshot, storage?: BlockStorage) {
    this.storage = storage ?? null

    if (snapshot) {
      this.btcSnapshot = snapshot
      this.snapshotTotalEntries = snapshot.entries.length
      this.snapshotTotalAmount = snapshot.entries.reduce((s, e) => s + e.amount, 0)
      this.snapshotIndex = getSnapshotIndex(snapshot)
    }

    // Try to restore from storage first
    if (storage) {
      const persisted = storage.loadBlocks()
      if (persisted.length > 0) {
        // Replay persisted blocks (genesis is first)
        this.blocks.push(persisted[0]) // genesis
        this.cumulativeWork = blockWork(persisted[0].header.target)
        for (let i = 1; i < persisted.length; i++) {
          this.undoData.push(this.applyBlock(persisted[i]))
          this.blocks.push(persisted[i])
          this.cumulativeWork += blockWork(persisted[i].header.target)
          if (this.blocks.length % DIFFICULTY_ADJUSTMENT_INTERVAL === 0) {
            this.difficulty = this.adjustDifficulty()
          }
        }
        this.replayHeight = this.getHeight()

        // Metadata loaded for height/genesis info only.
        // Difficulty is always recomputed from block timestamps
        // so all nodes converge to the same value deterministically.
        return
      }
    }

    // No persisted data — create genesis
    if (snapshot) {
      const genesis = createForkGenesisBlock(snapshot)
      this.blocks.push(genesis)
      if (storage) {
        storage.appendBlock(genesis)
        storage.saveMetadata({ height: 0, difficulty: this.difficulty, genesisHash: genesis.hash })
      }
    } else {
      const genesis = createGenesisBlock()
      this.blocks.push(genesis)
      if (storage) {
        storage.appendBlock(genesis)
        storage.saveMetadata({ height: 0, difficulty: this.difficulty, genesisHash: genesis.hash })
      }
    }
    // Genesis coinbase goes to burn address - don't add to UTXO set
    // Initialize cumulative work from genesis block
    this.cumulativeWork = blockWork(this.blocks[0].header.target)
  }

  /** Replace genesis block with one received from a peer (fresh node without snapshot only) */
  replaceGenesis(genesis: Block): boolean {
    if (this.getHeight() !== 0) return false
    if (this.btcSnapshot) return false
    this.blocks[0] = genesis
    if (this.storage) {
      this.storage.rewriteBlocks(this.blocks)
      this.storage.saveMetadata({ height: 0, difficulty: this.difficulty, genesisHash: genesis.hash })
    }
    return true
  }

  /** Add a validated block to the chain */
  addBlock(block: Block): { success: boolean; error?: string } {
    const previousBlock = this.getChainTip()

    // Validate block target matches expected difficulty
    if (block.header.target !== this.difficulty) {
      return {
        success: false,
        error: `Block target mismatch: expected ${this.difficulty.slice(0, 16)}…, got ${block.header.target.slice(0, 16)}…`,
      }
    }

    // Validate block structure (including timestamp)
    const result = validateBlock(block, previousBlock, this.utxoSet, this.blocks)
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

    // Apply UTXO changes and record undo data
    this.undoData.push(this.applyBlock(block))

    // Track cumulative work
    this.cumulativeWork += blockWork(block.header.target)

    // Append to chain
    this.blocks.push(block)

    // Check difficulty adjustment
    if (this.blocks.length % DIFFICULTY_ADJUSTMENT_INTERVAL === 0) {
      this.difficulty = this.adjustDifficulty()
    }

    // Persist new block (skip replayed blocks)
    if (this.storage && this.getHeight() > this.replayHeight) {
      this.storage.appendBlock(block)
      this.storage.saveMetadata({
        height: this.getHeight(),
        difficulty: this.difficulty,
        genesisHash: this.blocks[0].hash,
      })
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
    // N blocks span N-1 inter-block gaps; expected time is for those gaps
    const expectedTime = (DIFFICULTY_ADJUSTMENT_INTERVAL - 1) * TARGET_BLOCK_TIME_MS

    // Clamp ratio to [0.25, 4.0]
    let ratio = actualTime / expectedTime
    ratio = Math.max(0.25, Math.min(4.0, ratio))

    // Adjust target: higher ratio = easier (bigger target), lower = harder (smaller)
    const currentTarget = BigInt('0x' + this.difficulty)
    let newTarget =
      (currentTarget * BigInt(Math.round(ratio * 10000))) / 10000n

    // Clamp to max
    const maxTarget = BigInt('0x' + STARTING_DIFFICULTY)
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

  /** Get block hash at a given height */
  getBlockHash(height: number): string | undefined {
    if (height < 0 || height >= this.blocks.length) return undefined
    return this.blocks[height].hash
  }

  /**
   * Reset chain to a target height.
   * Uses undo data to disconnect blocks in O(1) each when available,
   * falling back to full replay from genesis if undo data is missing.
   * Rewrites storage to match the truncated chain.
   */
  resetToHeight(targetHeight: number): void {
    if (targetHeight < 0 || targetHeight > this.getHeight()) {
      throw new Error(`Invalid target height ${targetHeight} (current: ${this.getHeight()})`)
    }

    // undoData[i] corresponds to blocks[i+1] (block at height i+1)
    // Check if we have undo data for all blocks we need to disconnect
    const currentHeight = this.getHeight()
    const hasUndoData = this.undoData.length === currentHeight

    if (hasUndoData && targetHeight > 0) {
      // Fast path: disconnect blocks backwards using undo data — O(blocks_removed)
      for (let h = currentHeight; h > targetHeight; h--) {
        this.disconnectBlock(this.undoData[h - 1])
        this.undoData.pop()
        this.blocks.pop()
      }
    } else {
      // Slow path: full replay from genesis
      this.blocks.length = targetHeight + 1
      this.undoData.length = 0
      this.utxoSet.clear()
      this.claimedBtcAddresses.clear()
      this.claimedCount = 0
      this.claimedAmount = 0
      this.difficulty = STARTING_DIFFICULTY
      this.cumulativeWork = blockWork(this.blocks[0].header.target)

      for (let i = 1; i <= targetHeight; i++) {
        this.undoData.push(this.applyBlock(this.blocks[i]))
        this.cumulativeWork += blockWork(this.blocks[i].header.target)
        if ((i + 1) % DIFFICULTY_ADJUSTMENT_INTERVAL === 0) {
          this.difficulty = this.adjustDifficulty()
        }
      }
    }

    // Update storage
    if (this.storage) {
      this.storage.rewriteBlocks(this.blocks)
      this.storage.saveMetadata({
        height: targetHeight,
        difficulty: this.difficulty,
        genesisHash: this.blocks[0].hash,
      })
    }

    this.replayHeight = targetHeight
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

  /** Get claim statistics (O(1) — uses incrementally tracked counters) */
  getClaimStats(): { btcBlockHeight: number; totalEntries: number; claimed: number; unclaimed: number; claimedAmount: number; unclaimedAmount: number } {
    if (!this.btcSnapshot) {
      return { btcBlockHeight: 0, totalEntries: 0, claimed: 0, unclaimed: 0, claimedAmount: 0, unclaimedAmount: 0 }
    }
    return {
      btcBlockHeight: this.btcSnapshot.btcBlockHeight,
      totalEntries: this.snapshotTotalEntries,
      claimed: this.claimedCount,
      unclaimed: this.snapshotTotalEntries - this.claimedCount,
      claimedAmount: this.claimedAmount,
      unclaimedAmount: this.snapshotTotalAmount - this.claimedAmount,
    }
  }

  /** Apply UTXO set changes for a validated block and return undo data (private) */
  private applyBlock(block: Block): BlockUndo {
    const undo: BlockUndo = {
      spentUtxos: [],
      createdUtxoKeys: [],
      claimedAddresses: [],
      previousDifficulty: this.difficulty,
      blockWork: blockWork(block.header.target),
    }

    for (const tx of block.transactions) {
      const txIsCoinbase = isCoinbase(tx)

      // Handle claim transactions: mark BTC UTXO as claimed, create PQ UTXO
      if (isClaimTransaction(tx)) {
        const claim = tx.claimData!
        this.claimedBtcAddresses.add(claim.btcAddress)
        undo.claimedAddresses.push(claim.btcAddress)
        if (this.snapshotIndex) {
          const entry = this.snapshotIndex.get(claim.btcAddress)
          if (entry) {
            this.claimedCount++
            this.claimedAmount += entry.amount
          }
        }
        // Create new PQ UTXO from claim output
        for (let i = 0; i < tx.outputs.length; i++) {
          const output = tx.outputs[i]
          const key = utxoKey(tx.id, i)
          const overwritten = this.utxoSet.get(key)
          if (overwritten) {
            undo.spentUtxos.push({ key, utxo: overwritten })
          }
          this.utxoSet.set(key, {
            txId: tx.id,
            outputIndex: i,
            address: output.address,
            amount: output.amount,
            height: block.height,
          })
          undo.createdUtxoKeys.push(key)
        }
        continue
      }

      // Remove spent UTXOs (skip coinbase inputs)
      if (!txIsCoinbase) {
        for (const input of tx.inputs) {
          const key = utxoKey(input.txId, input.outputIndex)
          const existing = this.utxoSet.get(key)
          if (existing) {
            undo.spentUtxos.push({ key, utxo: existing })
          }
          this.utxoSet.delete(key)
        }
      }

      // Add new UTXOs from outputs
      for (let i = 0; i < tx.outputs.length; i++) {
        const output = tx.outputs[i]
        const key = utxoKey(tx.id, i)
        // Save overwritten UTXO if key already exists (e.g. duplicate coinbase txid)
        const overwritten = this.utxoSet.get(key)
        if (overwritten) {
          undo.spentUtxos.push({ key, utxo: overwritten })
        }
        this.utxoSet.set(key, {
          txId: tx.id,
          outputIndex: i,
          address: output.address,
          amount: output.amount,
          height: block.height,
          isCoinbase: txIsCoinbase || undefined,
        })
        undo.createdUtxoKeys.push(key)
      }
    }

    return undo
  }

  /** Disconnect a block using its undo data — O(1) per block */
  private disconnectBlock(undo: BlockUndo): void {
    // Remove created UTXOs
    for (const key of undo.createdUtxoKeys) {
      this.utxoSet.delete(key)
    }
    // Restore spent UTXOs
    for (const { key, utxo } of undo.spentUtxos) {
      this.utxoSet.set(key, utxo)
    }
    // Unclaim BTC addresses
    for (const addr of undo.claimedAddresses) {
      this.claimedBtcAddresses.delete(addr)
      if (this.snapshotIndex) {
        const entry = this.snapshotIndex.get(addr)
        if (entry) {
          this.claimedCount--
          this.claimedAmount -= entry.amount
        }
      }
    }
    // Restore difficulty
    this.difficulty = undo.previousDifficulty
    // Subtract work
    this.cumulativeWork -= undo.blockWork
  }
}
