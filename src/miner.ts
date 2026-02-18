/**
 * Proof-of-Work miner for qbtc
 *
 * Uses SHA-256 double-hash (same as Bitcoin).
 * SHA-256 is already quantum-resistant for mining
 * (Grover's gives only quadratic speedup, halving security from 256→128 bit).
 */
import {
  type Block,
  type BlockHeader,
  computeBlockHash,
  computeMerkleRoot,
  hashMeetsTarget,
  transactionSize,
  medianTimestamp,
  MAX_BLOCK_SIZE,
} from './block.js'
import { type Blockchain } from './chain.js'
import { type Mempool } from './mempool.js'
import {
  type Transaction,
  createCoinbaseTransaction,
  calculateFee,
} from './transaction.js'
import { log } from './log.js'

/** Assemble a candidate block from chain state and mempool */
export function assembleCandidateBlock(
  chain: Blockchain,
  mempool: Mempool,
  minerAddress: string,
  message?: string
): Block {
  const tip = chain.getChainTip()
  const height = chain.getHeight() + 1

  // Get transactions from mempool, respecting 1MB block size limit
  const pendingTxs = mempool.getTransactionsForBlock(chain.utxoSet)

  // Reserve space for header + coinbase
  const HEADER_SIZE = 112
  const coinbaseEstimate = 80 // conservative estimate for coinbase tx
  let remainingSize = MAX_BLOCK_SIZE - HEADER_SIZE - coinbaseEstimate

  const includedTxs: Transaction[] = []
  let totalFees = 0
  for (const tx of pendingTxs) {
    const txSize = transactionSize(tx)
    if (txSize > remainingSize) break
    includedTxs.push(tx)
    totalFees += calculateFee(tx, chain.utxoSet)
    remainingSize -= txSize
  }

  // Create coinbase
  const coinbase = createCoinbaseTransaction(minerAddress, height, totalFees, message)

  // All transactions: coinbase first
  const transactions: Transaction[] = [coinbase, ...includedTxs]

  // Merkle root
  const merkleRoot = computeMerkleRoot(transactions.map((tx) => tx.id))

  // Timestamp must be > median time past of last 11 blocks
  const tipIndex = chain.blocks.length - 1
  const mtp = chain.blocks.length > 1 ? medianTimestamp(chain.blocks, tipIndex) : 0
  const timestamp = Math.max(Date.now(), mtp + 1)

  const header: BlockHeader = {
    version: 1,
    previousHash: tip.hash,
    merkleRoot,
    timestamp,
    target: chain.getDifficulty(),
    nonce: 0,
  }

  return {
    header,
    hash: '', // computed during mining
    transactions,
    height,
  }
}

/** Mine a block by finding a valid nonce (synchronous PoW loop) */
export function mineBlock(block: Block, verbose = true): Block {
  const startTime = performance.now()
  let nonce = 0
  let hash = ''
  const target = block.header.target

  while (true) {
    block.header.nonce = nonce
    hash = computeBlockHash(block.header)

    if (hashMeetsTarget(hash, target)) {
      break
    }

    nonce++

    // Log progress
    if (verbose && nonce % 500_000 === 0) {
      const elapsed = ((performance.now() - startTime) / 1000).toFixed(1)
      log.debug({ component: 'miner', nonce, elapsed: `${elapsed}s` }, 'Mining in progress')
    }

    // Nonce overflow: bump timestamp
    if (nonce > 0xffffffff) {
      nonce = 0
      block.header.timestamp += 1
    }
  }

  block.hash = hash
  const elapsed = ((performance.now() - startTime) / 1000).toFixed(2)

  if (verbose) {
    log.info({ component: 'miner', block: block.height, nonce, elapsed: `${elapsed}s`, hash: hash.slice(0, 20) }, 'Block mined')
  }

  return block
}

/**
 * Async non-blocking mining — yields to the event loop between nonce batches
 * so RPC and P2P stay responsive during mining.
 *
 * Uses adaptive batch sizing: targets ~100ms per batch to balance throughput
 * with event loop responsiveness. Batch size auto-tunes based on measured time.
 *
 * Returns the mined block, or null if the AbortSignal fires (e.g. a peer
 * broadcast a new block and we need to restart with the new tip).
 */
export interface MiningProgress {
  nonce: number
  elapsed: number   // seconds
  hashrate: number  // hashes per second
}

export function mineBlockAsync(
  block: Block,
  signal?: AbortSignal,
  onProgress?: (progress: MiningProgress) => void,
): Promise<Block | null> {
  return new Promise((resolve) => {
    let nonce = 0
    let batchSize = 100_000  // initial guess, auto-tunes
    const TARGET_BATCH_MS = 100
    const target = block.header.target
    const startTime = performance.now()

    function batch() {
      if (signal?.aborted) {
        resolve(null)
        return
      }

      const batchStart = performance.now()

      for (let i = 0; i < batchSize; i++) {
        block.header.nonce = nonce
        const hash = computeBlockHash(block.header)

        if (hashMeetsTarget(hash, target)) {
          block.hash = hash
          const elapsed = ((performance.now() - startTime) / 1000).toFixed(2)
          log.info({ component: 'miner', block: block.height, nonce, elapsed: `${elapsed}s`, hash: hash.slice(0, 20) }, 'Block mined')
          resolve(block)
          return
        }

        nonce++

        if (nonce > 0xffffffff) {
          nonce = 0
          block.header.timestamp += 1
        }
      }

      // Adaptive batch sizing with exponential smoothing: aim for ~100ms per batch
      const batchMs = performance.now() - batchStart
      if (batchMs > 0) {
        const idealBatch = Math.round(batchSize * TARGET_BATCH_MS / batchMs)
        const ALPHA = 0.3
        batchSize = Math.max(10_000, Math.min(500_000, Math.round(ALPHA * idealBatch + (1 - ALPHA) * batchSize)))
      }

      // Report progress every ~100k nonces
      if (onProgress && nonce % 100_000 < batchSize) {
        const elapsedMs = performance.now() - startTime
        const elapsedSec = elapsedMs / 1000
        onProgress({
          nonce,
          elapsed: Math.round(elapsedSec),
          hashrate: elapsedSec > 0 ? Math.round(nonce / elapsedSec) : 0,
        })
      }

      // Log progress every ~500k nonces
      if (nonce % 500_000 < batchSize) {
        const elapsed = ((performance.now() - startTime) / 1000).toFixed(1)
        log.debug({ component: 'miner', nonce, elapsed: `${elapsed}s` }, 'Mining in progress')
      }

      // Yield to event loop (setTimeout avoids starvation under GC pressure)
      setTimeout(batch, 0)
    }

    batch()
  })
}
