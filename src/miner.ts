/**
 * Proof-of-Work miner for qcoin
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
  MAX_BLOCK_SIZE,
} from './block.js'
import { type Blockchain } from './chain.js'
import { type Mempool } from './mempool.js'
import {
  type Transaction,
  createCoinbaseTransaction,
  calculateFee,
} from './transaction.js'

/** Assemble a candidate block from chain state and mempool */
export function assembleCandidateBlock(
  chain: Blockchain,
  mempool: Mempool,
  minerAddress: string
): Block {
  const tip = chain.getChainTip()
  const height = chain.getHeight() + 1

  // Get transactions from mempool, respecting 1MB block size limit
  const pendingTxs = mempool.getTransactionsForBlock()

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
  const coinbase = createCoinbaseTransaction(minerAddress, height, totalFees)

  // All transactions: coinbase first
  const transactions: Transaction[] = [coinbase, ...includedTxs]

  // Merkle root
  const merkleRoot = computeMerkleRoot(transactions.map((tx) => tx.id))

  const header: BlockHeader = {
    version: 1,
    previousHash: tip.hash,
    merkleRoot,
    timestamp: Date.now(),
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
      console.log(`  Mining... nonce=${nonce}, ${elapsed}s elapsed`)
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
    console.log(
      `  Mined block #${block.height} | nonce=${nonce} | ${elapsed}s | hash=${hash.slice(0, 20)}...`
    )
  }

  return block
}

/**
 * Async non-blocking mining — yields to the event loop between nonce batches
 * so RPC and P2P stay responsive during mining.
 *
 * Returns the mined block, or null if the AbortSignal fires (e.g. a peer
 * broadcast a new block and we need to restart with the new tip).
 */
export function mineBlockAsync(
  block: Block,
  signal?: AbortSignal,
  batchSize = 5_000
): Promise<Block | null> {
  return new Promise((resolve) => {
    let nonce = 0
    const target = block.header.target
    const startTime = performance.now()

    function batch() {
      if (signal?.aborted) {
        resolve(null)
        return
      }

      for (let i = 0; i < batchSize; i++) {
        block.header.nonce = nonce
        const hash = computeBlockHash(block.header)

        if (hashMeetsTarget(hash, target)) {
          block.hash = hash
          const elapsed = ((performance.now() - startTime) / 1000).toFixed(2)
          console.log(
            `  Mined block #${block.height} | nonce=${nonce} | ${elapsed}s | hash=${hash.slice(0, 20)}...`
          )
          resolve(block)
          return
        }

        nonce++

        if (nonce > 0xffffffff) {
          nonce = 0
          block.header.timestamp += 1
        }
      }

      // Log progress every ~500k nonces
      if (nonce % 500_000 < batchSize) {
        const elapsed = ((performance.now() - startTime) / 1000).toFixed(1)
        console.log(`  Mining... nonce=${nonce}, ${elapsed}s elapsed`)
      }

      // Yield to event loop
      setImmediate(batch)
    }

    batch()
  })
}
