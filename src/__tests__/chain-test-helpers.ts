import { Blockchain } from '../chain.js'
import { computeMerkleRoot, computeBlockHash, hashMeetsTarget, type Block, type BlockHeader } from '../block.js'
import { createCoinbaseTransaction, type Transaction } from '../transaction.js'

// Easy target for tests: ~16 attempts to find valid hash
export const TEST_TARGET = '0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

export function mineOnChain(chain: Blockchain, minerAddress: string, extraTxs: Transaction[] = []): Block {
  chain.difficulty = TEST_TARGET
  const tip = chain.getChainTip()
  const height = chain.getHeight() + 1
  const coinbase = createCoinbaseTransaction(minerAddress, height, 0)
  const txs = [coinbase, ...extraTxs]
  const merkleRoot = computeMerkleRoot(txs.map((t) => t.id))
  const target = chain.getDifficulty()

  const header: BlockHeader = {
    version: 1,
    previousHash: tip.hash,
    merkleRoot,
    timestamp: tip.header.timestamp + 1, // always increasing for MTP validation
    target,
    nonce: 0,
  }

  let hash = computeBlockHash(header)
  while (!hashMeetsTarget(hash, header.target)) {
    header.nonce++
    hash = computeBlockHash(header)
  }

  return { header, hash, transactions: txs, height }
}
