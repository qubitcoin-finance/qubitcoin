/**
 * Node - combines blockchain, mempool, and miner
 *
 * Each node maintains its own chain state and can mine blocks
 * or receive blocks/transactions from other nodes.
 */
import { Blockchain } from './chain.js'
import { Mempool } from './mempool.js'
import { assembleCandidateBlock, mineBlock } from './miner.js'
import type { Transaction } from './transaction.js'
import type { Block } from './block.js'
import type { BtcSnapshot } from './snapshot.js'

export class Node {
  readonly name: string
  readonly chain: Blockchain
  readonly mempool: Mempool

  constructor(name: string, snapshot?: BtcSnapshot) {
    this.name = name
    this.chain = new Blockchain(snapshot)
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
      console.log(`  [${this.name}] Accepted tx ${tx.id.slice(0, 16)}...`)
    }
    return result
  }

  /** Mine a new block with pending transactions */
  mine(minerAddress: string, verbose = true): Block {
    if (verbose) {
      console.log(
        `  [${this.name}] Mining block #${this.chain.getHeight() + 1} (${this.mempool.size()} pending txs)...`
      )
    }

    const candidate = assembleCandidateBlock(
      this.chain,
      this.mempool,
      minerAddress
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

    return block
  }

  /** Receive a block mined by another node */
  receiveBlock(block: Block): { success: boolean; error?: string } {
    const result = this.chain.addBlock(block)
    if (result.success) {
      // Remove any mempool transactions that were included
      const minedTxIds = block.transactions.map((tx) => tx.id)
      this.mempool.removeTransactions(minedTxIds)
    }
    return result
  }

  /** Get node state summary */
  getState() {
    return {
      name: this.name,
      height: this.chain.getHeight(),
      mempoolSize: this.mempool.size(),
      utxoCount: this.chain.utxoSet.size,
      difficulty: this.chain.getDifficulty().slice(0, 16) + '...',
    }
  }
}
