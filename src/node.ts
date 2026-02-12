/**
 * Node - combines blockchain, mempool, and miner
 *
 * Each node maintains its own chain state and can mine blocks
 * or receive blocks/transactions from other nodes.
 */
import { Blockchain } from './chain.js'
import { Mempool } from './mempool.js'
import { assembleCandidateBlock, mineBlock, mineBlockAsync } from './miner.js'
import type { Transaction } from './transaction.js'
import type { Block } from './block.js'
import { TARGET_BLOCK_TIME_MS } from './block.js'
import { blockSubsidy } from './transaction.js'
import { DIFFICULTY_ADJUSTMENT_INTERVAL } from './block.js'
import type { BtcSnapshot } from './snapshot.js'
import type { BlockStorage } from './storage.js'
import { log } from './log.js'

export class Node {
  readonly name: string
  readonly chain: Blockchain
  readonly mempool: Mempool

  /** Callbacks set by P2P layer for broadcasting */
  onNewBlock: ((block: Block) => void) | null = null
  onNewTransaction: ((tx: Transaction) => void) | null = null

  /** Active mining abort controller (null when not mining) */
  private miningAbort: AbortController | null = null

  constructor(name: string, snapshot?: BtcSnapshot, storage?: BlockStorage) {
    this.name = name
    this.chain = new Blockchain(snapshot, storage)
    this.mempool = new Mempool()
  }

  /** Receive and validate a transaction into the mempool */
  receiveTransaction(tx: Transaction): { success: boolean; error?: string } {
    const result = this.mempool.addTransaction(
      tx,
      this.chain.utxoSet,
      this.chain.claimedBtcAddresses
    )
    if (result.success) {
      log.info({ component: 'mempool', txid: tx.id.slice(0, 16) }, 'Accepted tx')
      this.onNewTransaction?.(tx)
    }
    return result
  }

  /** Mine a new block with pending transactions */
  mine(minerAddress: string, verbose = true, message?: string): Block {
    if (verbose) {
      log.info({ component: 'miner', block: this.chain.getHeight() + 1, pendingTxs: this.mempool.size() }, 'Mining block')
    }

    const candidate = assembleCandidateBlock(
      this.chain,
      this.mempool,
      minerAddress,
      message
    )
    const block = mineBlock(candidate, verbose)

    // Add to own chain
    const result = this.chain.addBlock(block)
    if (!result.success) {
      throw new Error(`[${this.name}] Failed to add own block: ${result.error}`)
    }

    // Remove mined transactions from mempool
    const minedTxIds = block.transactions.map((tx) => tx.id)
    this.mempool.removeTransactions(minedTxIds)

    // Broadcast to peers
    this.onNewBlock?.(block)

    return block
  }

  /** Receive a block mined by another node */
  receiveBlock(block: Block): { success: boolean; error?: string } {
    const result = this.chain.addBlock(block)
    if (result.success) {
      // Remove any mempool transactions that were included
      const minedTxIds = block.transactions.map((tx) => tx.id)
      this.mempool.removeTransactions(minedTxIds)

      // Abort in-progress mining so it restarts with the new tip
      this.miningAbort?.abort()
    }
    return result
  }

  /**
   * Start continuous async mining. Yields to the event loop between
   * nonce batches so RPC/P2P stay responsive. Automatically restarts
   * when a peer's block arrives (receiveBlock aborts the current round).
   */
  async startMining(minerAddress: string, message?: string): Promise<void> {
    log.info({ component: 'miner', address: minerAddress }, 'Mining started')

    while (true) {
      this.miningAbort = new AbortController()

      const candidate = assembleCandidateBlock(
        this.chain,
        this.mempool,
        minerAddress,
        message
      )

      const block = await mineBlockAsync(candidate, this.miningAbort.signal)

      if (block) {
        const result = this.chain.addBlock(block)
        if (result.success) {
          const minedTxIds = block.transactions.map((tx) => tx.id)
          this.mempool.removeTransactions(minedTxIds)
          this.onNewBlock?.(block)
        }
      }
      // else: aborted by receiveBlock → loop restarts with new tip
    }
  }

  /** Reset node to a target height: rollback chain, clear mempool, abort mining */
  resetToHeight(height: number): void {
    log.warn({ component: 'node', from: this.chain.getHeight(), to: height }, 'Resetting to height')
    this.chain.resetToHeight(height)
    this.mempool.clear()
    this.miningAbort?.abort()
  }

  stopMining(): void {
    this.miningAbort?.abort()
    this.miningAbort = null
  }

  /** Get node state summary */
  getState() {
    const height = this.chain.getHeight()
    const blocks = this.chain.blocks

    // Avg block time from last N blocks
    const window = Math.min(DIFFICULTY_ADJUSTMENT_INTERVAL, height)
    let avgBlockTime = 0
    if (window > 0) {
      const elapsed = blocks[blocks.length - 1].header.timestamp - blocks[blocks.length - 1 - window].header.timestamp
      avgBlockTime = Math.round(elapsed / window)
    }

    // Total transactions
    let totalTxs = 0
    for (const b of blocks) totalTxs += b.transactions.length

    // Estimated hashrate: hashes = 2^256 / target, rate = hashes / avgBlockTimeSec
    let hashrate = 0
    if (avgBlockTime > 0) {
      const target = BigInt('0x' + this.chain.getDifficulty())
      if (target > 0n) {
        const hashes = (2n ** 256n) / target
        hashrate = Number(hashes / BigInt(Math.max(1, Math.round(avgBlockTime / 1000))))
      }
    }

    return {
      name: this.name,
      height,
      mempoolSize: this.mempool.size(),
      utxoCount: this.chain.utxoSet.size,
      difficulty: this.chain.getDifficulty().slice(0, 16) + '...',
      lastBlockTime: this.chain.getChainTip().header.timestamp,
      targetBlockTime: TARGET_BLOCK_TIME_MS,
      avgBlockTime,
      blockReward: blockSubsidy(height + 1),
      totalTxs,
      hashrate,
    }
  }
}
