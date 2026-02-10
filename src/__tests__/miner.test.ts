import { describe, it, expect } from 'vitest'
import {
  Block,
  BlockHeader,
  computeBlockHash,
  computeMerkleRoot,
  hashMeetsTarget,
  validateBlock,
  INITIAL_TARGET,
  MAX_BLOCK_SIZE,
  transactionSize,
  blockSize,
} from '../block.js'
import {
  createCoinbaseTransaction,
  createTransaction,
  type Transaction,
  type UTXO,
  utxoKey,
  CLAIM_TXID,
} from '../transaction.js'
import { assembleCandidateBlock, mineBlock, mineBlockAsync } from '../miner.js'
import { Blockchain } from '../chain.js'
import { Mempool } from '../mempool.js'
import { generateWallet, doubleSha256Hex } from '../crypto.js'

const TEST_TARGET = '0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

// Generate wallets once at module level to avoid repeated slow ML-DSA-65 keygen
const walletA = generateWallet()
const walletB = generateWallet()

/** Helper: mine a simple coinbase-only block on top of a chain */
function mineOnChain(chain: Blockchain, minerAddress: string): Block {
  chain.difficulty = TEST_TARGET
  const tip = chain.getChainTip()
  const height = chain.getHeight() + 1
  const coinbase = createCoinbaseTransaction(minerAddress, height, 0)
  const txs = [coinbase]
  const merkleRoot = computeMerkleRoot(txs.map((t) => t.id))

  const target = chain.getDifficulty()
  const header: BlockHeader = {
    version: 1,
    previousHash: tip.hash,
    merkleRoot,
    timestamp: Date.now(),
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

// ─────────────────────────────────────────────────────────────
// 1. transactionSize
// ─────────────────────────────────────────────────────────────
describe('transactionSize', () => {
  it('returns correct size for a coinbase transaction', () => {
    const coinbase = createCoinbaseTransaction(walletA.address, 1, 0)
    const size = transactionSize(coinbase)

    // txId(32) + timestamp(8) = 40
    // 1 input: txId(32) + outputIndex(4) + pubKey(0) + sig(0) = 36
    // 1 output: address(32) + amount(8) = 40
    // total = 40 + 36 + 40 = 116
    expect(size).toBe(116)
  })

  it('returns correct size for a regular transaction with ML-DSA-65 keys', () => {
    // Build a regular signed transaction
    const chain = new Blockchain()
    chain.difficulty = TEST_TARGET

    // Mine a block so walletA has a UTXO
    const block1 = mineOnChain(chain, walletA.address)
    chain.addBlock(block1)

    const utxos = chain.findUTXOs(walletA.address)
    expect(utxos.length).toBeGreaterThan(0)

    const tx = createTransaction(
      walletA,
      utxos,
      [{ address: walletB.address, amount: 1 }],
      0.125
    )

    const size = transactionSize(tx)

    // txId(32) + timestamp(8) = 40
    // 1 input: txId(32) + outputIndex(4) + pubKey(1952) + sig(3309) = 5297
    // 2 outputs (recipient + change): 2 * (address(32) + amount(8)) = 80
    // total = 40 + 5297 + 80 = 5417
    expect(size).toBe(5417)
  })

  it('returns correct size for a claim transaction', () => {
    const claimTx: Transaction = {
      id: 'a'.repeat(64),
      inputs: [
        {
          txId: CLAIM_TXID,
          outputIndex: 0,
          publicKey: new Uint8Array(0),
          signature: new Uint8Array(0),
        },
      ],
      outputs: [{ address: walletA.address, amount: 100_000_000 }],
      timestamp: Date.now(),
      claimData: {
        btcAddress: 'b'.repeat(40),
        ecdsaPublicKey: new Uint8Array(33), // compressed secp256k1 pubkey
        ecdsaSignature: new Uint8Array(64), // ECDSA signature
        qcoinAddress: walletA.address,
      },
    }

    const size = transactionSize(claimTx)

    // txId(32) + timestamp(8) = 40
    // 1 input: txId(32) + outputIndex(4) + pubKey(0) + sig(0) = 36
    // 1 output: address(32) + amount(8) = 40
    // claimData: btcAddress(20) + ecdsaPubKey(33) + ecdsaSig(64) + qcoinAddress(32) = 149
    // total = 40 + 36 + 40 + 149 = 265
    expect(size).toBe(265)
  })
})

// ─────────────────────────────────────────────────────────────
// 2. blockSize
// ─────────────────────────────────────────────────────────────
describe('blockSize', () => {
  it('returns correct size for a block with one coinbase transaction', () => {
    const coinbase = createCoinbaseTransaction(walletA.address, 1, 0)
    const block: Block = {
      header: {
        version: 1,
        previousHash: '0'.repeat(64),
        merkleRoot: coinbase.id,
        timestamp: Date.now(),
        target: TEST_TARGET,
        nonce: 0,
      },
      hash: 'f'.repeat(64),
      transactions: [coinbase],
      height: 1,
    }

    const size = blockSize(block)
    const expectedTxSize = transactionSize(coinbase)

    // BLOCK_HEADER_SIZE (112) + coinbase tx size
    expect(size).toBe(112 + expectedTxSize)
  })

  it('sums sizes of all transactions in the block', () => {
    const coinbase = createCoinbaseTransaction(walletA.address, 1, 0)

    // Add a fake claim tx for variety
    const claimTx: Transaction = {
      id: 'c'.repeat(64),
      inputs: [
        {
          txId: CLAIM_TXID,
          outputIndex: 0,
          publicKey: new Uint8Array(0),
          signature: new Uint8Array(0),
        },
      ],
      outputs: [{ address: walletB.address, amount: 50_000_000 }],
      timestamp: Date.now(),
      claimData: {
        btcAddress: 'd'.repeat(40),
        ecdsaPublicKey: new Uint8Array(33),
        ecdsaSignature: new Uint8Array(64),
        qcoinAddress: walletB.address,
      },
    }

    const block: Block = {
      header: {
        version: 1,
        previousHash: '0'.repeat(64),
        merkleRoot: computeMerkleRoot([coinbase.id, claimTx.id]),
        timestamp: Date.now(),
        target: TEST_TARGET,
        nonce: 0,
      },
      hash: 'f'.repeat(64),
      transactions: [coinbase, claimTx],
      height: 1,
    }

    const size = blockSize(block)
    expect(size).toBe(112 + transactionSize(coinbase) + transactionSize(claimTx))
  })
})

// ─────────────────────────────────────────────────────────────
// 3. MAX_BLOCK_SIZE enforcement in validateBlock
// ─────────────────────────────────────────────────────────────
describe('MAX_BLOCK_SIZE enforcement in validateBlock', () => {
  it('rejects a block that exceeds 1MB', () => {
    const chain = new Blockchain()
    chain.difficulty = TEST_TARGET

    // Mine a block to get past genesis
    const block1 = mineOnChain(chain, walletA.address)
    chain.addBlock(block1)

    const tip = chain.getChainTip()
    const height = chain.getHeight() + 1

    const coinbase = createCoinbaseTransaction(walletA.address, height, 0)

    // Create a fake transaction with a massive publicKey to push block over 1MB
    const hugePubKey = new Uint8Array(MAX_BLOCK_SIZE + 1000)
    const fatTx: Transaction = {
      id: 'a'.repeat(64),
      inputs: [
        {
          txId: 'b'.repeat(64),
          outputIndex: 0,
          publicKey: hugePubKey,
          signature: new Uint8Array(0),
        },
      ],
      outputs: [{ address: walletA.address, amount: 1 }],
      timestamp: Date.now(),
    }

    const transactions = [coinbase, fatTx]
    const merkleRoot = computeMerkleRoot(transactions.map((t) => t.id))

    const header: BlockHeader = {
      version: 1,
      previousHash: tip.hash,
      merkleRoot,
      timestamp: Date.now(),
      target: TEST_TARGET,
      nonce: 0,
    }

    let hash = computeBlockHash(header)
    while (!hashMeetsTarget(hash, header.target)) {
      header.nonce++
      hash = computeBlockHash(header)
    }

    const oversizedBlock: Block = {
      header,
      hash,
      transactions,
      height,
    }

    // The block size should exceed MAX_BLOCK_SIZE
    expect(blockSize(oversizedBlock)).toBeGreaterThan(MAX_BLOCK_SIZE)

    // validateBlock should reject it
    const result = validateBlock(oversizedBlock, tip, chain.utxoSet)
    expect(result.valid).toBe(false)
    expect(result.error).toContain('Block size')
    expect(result.error).toContain('exceeds max')
  })
})

// ─────────────────────────────────────────────────────────────
// 4. assembleCandidateBlock respects block size limit
// ─────────────────────────────────────────────────────────────
describe('assembleCandidateBlock respects block size limit', () => {
  it('does not include transactions that would exceed MAX_BLOCK_SIZE', () => {
    const chain = new Blockchain()
    chain.difficulty = TEST_TARGET
    const mempool = new Mempool()

    // Mine a block so walletA has a coinbase UTXO
    const block1 = mineOnChain(chain, walletA.address)
    chain.addBlock(block1)

    // Create many signed transactions from walletA to walletB.
    // Each ML-DSA-65 signed tx is ~5.4 KB. We need enough to exceed 1MB.
    // 1,000,000 / 5,400 ~ 185 txs. Create 200 to be safe.
    // But we only have one UTXO from mining, so we create claim txs which
    // skip UTXO validation in mempool. Each claim tx is ~265 bytes,
    // so we need ~4000 of them to exceed 1MB.
    const numTxs = 4500
    for (let i = 0; i < numTxs; i++) {
      const claimTx: Transaction = {
        id: doubleSha256Hex(new TextEncoder().encode(`claim-tx-${i}-${Date.now()}`)),
        inputs: [
          {
            txId: CLAIM_TXID,
            outputIndex: 0,
            publicKey: new Uint8Array(0),
            signature: new Uint8Array(0),
          },
        ],
        outputs: [{ address: walletB.address, amount: 100 }],
        timestamp: Date.now() + i,
        claimData: {
          btcAddress: doubleSha256Hex(new TextEncoder().encode(`btc-addr-${i}`)).slice(0, 40),
          ecdsaPublicKey: new Uint8Array(33),
          ecdsaSignature: new Uint8Array(64),
          qcoinAddress: walletB.address,
        },
      }
      // Add to mempool directly (bypass validation since these are synthetic)
      mempool.addTransaction(claimTx, chain.utxoSet)
    }

    expect(mempool.size()).toBe(numTxs)

    // Assemble the candidate block
    const candidate = assembleCandidateBlock(chain, mempool, walletA.address)

    // The assembled block must not exceed MAX_BLOCK_SIZE
    const size = blockSize(candidate)
    expect(size).toBeLessThanOrEqual(MAX_BLOCK_SIZE)

    // It should have included some transactions but not all
    // (coinbase + some claim txs, but fewer than numTxs)
    expect(candidate.transactions.length).toBeGreaterThan(1) // at least coinbase + 1
    expect(candidate.transactions.length).toBeLessThan(numTxs + 1) // not all of them
  })
})

// ─────────────────────────────────────────────────────────────
// 5. mineBlockAsync
// ─────────────────────────────────────────────────────────────
describe('mineBlockAsync', () => {
  it('returns a mined block with a valid hash', async () => {
    const chain = new Blockchain()
    chain.difficulty = TEST_TARGET

    const tip = chain.getChainTip()
    const height = chain.getHeight() + 1
    const coinbase = createCoinbaseTransaction(walletA.address, height, 0)
    const merkleRoot = computeMerkleRoot([coinbase.id])

    const header: BlockHeader = {
      version: 1,
      previousHash: tip.hash,
      merkleRoot,
      timestamp: Date.now(),
      target: TEST_TARGET,
      nonce: 0,
    }

    const block: Block = {
      header,
      hash: '',
      transactions: [coinbase],
      height,
    }

    const result = await mineBlockAsync(block)
    expect(result).not.toBeNull()
    expect(result!.hash).toBeTruthy()
    expect(hashMeetsTarget(result!.hash, TEST_TARGET)).toBe(true)
    expect(computeBlockHash(result!.header)).toBe(result!.hash)
  })

  it('returns null when aborted', async () => {
    const chain = new Blockchain()

    const tip = chain.getChainTip()
    const height = chain.getHeight() + 1
    const coinbase = createCoinbaseTransaction(walletA.address, height, 0)
    const merkleRoot = computeMerkleRoot([coinbase.id])

    // Use a very hard target so mining takes a long time
    const hardTarget = '0000000000ffffffffffffffffffffffffffffffffffffffffffffffffffffff'

    const header: BlockHeader = {
      version: 1,
      previousHash: tip.hash,
      merkleRoot,
      timestamp: Date.now(),
      target: hardTarget,
      nonce: 0,
    }

    const block: Block = {
      header,
      hash: '',
      transactions: [coinbase],
      height,
    }

    const abort = new AbortController()
    const promise = mineBlockAsync(block, abort.signal)
    setTimeout(() => abort.abort(), 100)
    const result = await promise
    expect(result).toBeNull()
  })
})
