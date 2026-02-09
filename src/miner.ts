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

  // Get transactions from mempool
  const pendingTxs = mempool.getTransactionsForBlock()

  // Calculate total fees
  let totalFees = 0
  for (const tx of pendingTxs) {
    totalFees += calculateFee(tx, chain.utxoSet)
  }

  // Create coinbase
  const coinbase = createCoinbaseTransaction(minerAddress, height, totalFees)

  // All transactions: coinbase first
  const transactions: Transaction[] = [coinbase, ...pendingTxs]

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
