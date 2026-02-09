import { describe, it, expect } from 'vitest'
import { Blockchain } from '../chain.js'
import { createCoinbaseTransaction, createTransaction, utxoKey } from '../transaction.js'
import { generateWallet } from '../crypto.js'
import { computeMerkleRoot, computeBlockHash, hashMeetsTarget, type Block, type BlockHeader } from '../block.js'
import { createMockSnapshot } from '../snapshot.js'
import { createClaimTransaction } from '../claim.js'

// Easy target for tests: ~16 attempts to find valid hash
const TEST_TARGET = '0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

function mineOnChain(chain: Blockchain, minerAddress: string, extraTxs: any[] = []): Block {
  chain.difficulty = TEST_TARGET
  const tip = chain.getChainTip()
  const height = chain.getHeight() + 1
  const coinbase = createCoinbaseTransaction(minerAddress, height, 0)
  const txs = [coinbase, ...extraTxs]
  const merkleRoot = computeMerkleRoot(txs.map((t) => t.id))

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

  return { header, hash, transactions: txs, height }
}

describe('Blockchain', () => {
  it('starts with genesis block', () => {
    const chain = new Blockchain()
    expect(chain.getHeight()).toBe(0)
    expect(chain.blocks.length).toBe(1)
  })

  it('starts with empty UTXO set', () => {
    const chain = new Blockchain()
    expect(chain.utxoSet.size).toBe(0) // genesis coinbase is burn
  })

  it('accepts valid mined block', () => {
    const chain = new Blockchain()
    const wallet = generateWallet()
    const block = mineOnChain(chain, wallet.address)
    const result = chain.addBlock(block)
    expect(result.success).toBe(true)
    expect(chain.getHeight()).toBe(1)
  })

  it('rejects block with wrong previous hash', () => {
    const chain = new Blockchain()
    const wallet = generateWallet()
    const block = mineOnChain(chain, wallet.address)
    block.header.previousHash = 'deadbeef'.repeat(8)
    // Recompute hash
    block.hash = computeBlockHash(block.header)
    const result = chain.addBlock(block)
    expect(result.success).toBe(false)
  })

  it('tracks balance after mining', () => {
    const chain = new Blockchain()
    const wallet = generateWallet()
    const block = mineOnChain(chain, wallet.address)
    chain.addBlock(block)
    expect(chain.getBalance(wallet.address)).toBe(50)
  })

  it('findUTXOs returns mined outputs', () => {
    const chain = new Blockchain()
    const wallet = generateWallet()
    const block = mineOnChain(chain, wallet.address)
    chain.addBlock(block)
    const utxos = chain.findUTXOs(wallet.address)
    expect(utxos.length).toBe(1)
    expect(utxos[0].amount).toBe(50)
  })

  it('validates chain detects tampering', () => {
    const chain = new Blockchain()
    const wallet = generateWallet()
    const block = mineOnChain(chain, wallet.address)
    chain.addBlock(block)

    expect(chain.validateChain().valid).toBe(true)

    // Tamper
    chain.blocks[1].hash = 'ff'.repeat(32)
    expect(chain.validateChain().valid).toBe(false)

    // Restore
    chain.blocks[1].hash = computeBlockHash(chain.blocks[1].header)
    expect(chain.validateChain().valid).toBe(true)
  })
})

describe('Blockchain with snapshot', () => {
  it('creates fork genesis when given snapshot', () => {
    const { snapshot } = createMockSnapshot()
    const chain = new Blockchain(snapshot)
    expect(chain.getHeight()).toBe(0)
    expect(chain.blocks[0].header.version).toBe(2)
    expect(chain.btcSnapshot).toBe(snapshot)
  })

  it('processes claim transactions', () => {
    const { snapshot, holders } = createMockSnapshot()
    const chain = new Blockchain(snapshot)
    const qtcWallet = generateWallet()

    // Create and include claim in a block
    const claimTx = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      qtcWallet,
      snapshot.btcBlockHash
    )

    const block = mineOnChain(chain, 'f'.repeat(64), [claimTx])
    const result = chain.addBlock(block)
    expect(result.success).toBe(true)
    expect(chain.getBalance(qtcWallet.address)).toBe(holders[0].amount)
  })

  it('rejects double-claim', () => {
    const { snapshot, holders } = createMockSnapshot()
    const chain = new Blockchain(snapshot)
    const qtcWallet = generateWallet()

    const claimTx = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      qtcWallet,
      snapshot.btcBlockHash
    )

    const block1 = mineOnChain(chain, 'f'.repeat(64), [claimTx])
    chain.addBlock(block1)

    // Try to claim same UTXO again
    const claimTx2 = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      qtcWallet,
      snapshot.btcBlockHash
    )

    const block2 = mineOnChain(chain, 'f'.repeat(64), [claimTx2])
    const result = chain.addBlock(block2)
    expect(result.success).toBe(false)
    expect(result.error).toContain('already claimed')
  })

  it('tracks claim statistics', () => {
    const { snapshot, holders } = createMockSnapshot()
    const chain = new Blockchain(snapshot)

    let stats = chain.getClaimStats()
    expect(stats.totalEntries).toBe(5)
    expect(stats.claimed).toBe(0)

    const qtcWallet = generateWallet()
    const claimTx = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      qtcWallet,
      snapshot.btcBlockHash
    )
    const block = mineOnChain(chain, 'f'.repeat(64), [claimTx])
    chain.addBlock(block)

    stats = chain.getClaimStats()
    expect(stats.claimed).toBe(1)
    expect(stats.claimedAmount).toBe(holders[0].amount)
    expect(stats.unclaimed).toBe(4)
  })
})
