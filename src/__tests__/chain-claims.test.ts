import { describe, it, expect } from 'vitest'
import { Blockchain } from '../chain.js'
import { createMockSnapshot } from '../snapshot.js'
import { createClaimTransaction, createP2wshClaimTransaction, createP2shMultisigClaimTransaction } from '../claim.js'
import { walletA, walletB } from './fixtures.js'
import { mineOnChain } from './chain-test-helpers.js'

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
    const genesisHash = chain.blocks[0].hash
    const qbtcWallet = walletB

    // Create and include claim in a block
    const claimTx = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      qbtcWallet,
      snapshot.btcBlockHash,
      genesisHash
    )

    const block = mineOnChain(chain, 'f'.repeat(64), [claimTx])
    const result = chain.addBlock(block)
    expect(result.success).toBe(true)
    expect(chain.getBalance(qbtcWallet.address)).toBe(holders[0].amount)
  })

  it('rejects double-claim', () => {
    const { snapshot, holders } = createMockSnapshot()
    const chain = new Blockchain(snapshot)
    const genesisHash = chain.blocks[0].hash
    const qbtcWallet = walletB

    const claimTx = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      qbtcWallet,
      snapshot.btcBlockHash,
      genesisHash
    )

    const block1 = mineOnChain(chain, 'f'.repeat(64), [claimTx])
    chain.addBlock(block1)

    // Try to claim same UTXO again
    const claimTx2 = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      qbtcWallet,
      snapshot.btcBlockHash,
      genesisHash
    )

    const block2 = mineOnChain(chain, 'f'.repeat(64), [claimTx2])
    const result = chain.addBlock(block2)
    expect(result.success).toBe(false)
    expect(result.error).toContain('already claimed')
  })

  it('tracks claim statistics', () => {
    const { snapshot, holders } = createMockSnapshot()
    const chain = new Blockchain(snapshot)
    const genesisHash = chain.blocks[0].hash

    let stats = chain.getClaimStats()
    expect(stats.totalEntries).toBe(9) // 5 P2PKH/P2WPKH + 1 P2SH-P2WPKH + 1 P2SH multisig + 1 P2TR + 1 P2WSH
    expect(stats.claimed).toBe(0)

    const qbtcWallet = walletB
    const claimTx = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      qbtcWallet,
      snapshot.btcBlockHash,
      genesisHash
    )
    const block = mineOnChain(chain, 'f'.repeat(64), [claimTx])
    chain.addBlock(block)

    stats = chain.getClaimStats()
    expect(stats.claimed).toBe(1)
    expect(stats.claimedAmount).toBe(holders[0].amount)
    expect(stats.unclaimed).toBe(8)
  })
})

describe('Blockchain getClaimableEntries / getUnclaimedValue', () => {
  it('returns empty array and zero when no snapshot is loaded', () => {
    const chain = new Blockchain()
    expect(chain.getClaimableEntries()).toEqual([])
    expect(chain.getUnclaimedValue()).toBe(0)
  })

  it('returns all entries and total value before any claims', () => {
    const { snapshot } = createMockSnapshot()
    const chain = new Blockchain(snapshot)

    const entries = chain.getClaimableEntries()
    expect(entries.length).toBe(snapshot.entries.length)
    const total = snapshot.entries.reduce((s, e) => s + e.amount, 0)
    expect(chain.getUnclaimedValue()).toBe(total)
  })

  it('excludes claimed entries after a claim is mined', () => {
    const { snapshot, holders } = createMockSnapshot()
    const chain = new Blockchain(snapshot)
    const genesisHash = chain.blocks[0].hash

    const claimTx = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      walletB,
      snapshot.btcBlockHash,
      genesisHash
    )
    chain.addBlock(mineOnChain(chain, 'f'.repeat(64), [claimTx]))

    const entries = chain.getClaimableEntries()
    expect(entries.length).toBe(snapshot.entries.length - 1)
    expect(entries.find(e => e.btcAddress === snapshot.entries[0].btcAddress)).toBeUndefined()

    const expectedUnclaimed = snapshot.entries.reduce((s, e) => s + e.amount, 0) - holders[0].amount
    expect(chain.getUnclaimedValue()).toBe(expectedUnclaimed)
  })

  it('restores claimed entry after chain rollback', () => {
    const { snapshot, holders } = createMockSnapshot()
    const chain = new Blockchain(snapshot)
    const genesisHash = chain.blocks[0].hash

    const claimTx = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      walletB,
      snapshot.btcBlockHash,
      genesisHash
    )
    chain.addBlock(mineOnChain(chain, 'f'.repeat(64), [claimTx]))
    expect(chain.getClaimableEntries().length).toBe(snapshot.entries.length - 1)

    chain.resetToHeight(0)
    expect(chain.getClaimableEntries().length).toBe(snapshot.entries.length)
    const total = snapshot.entries.reduce((s, e) => s + e.amount, 0)
    expect(chain.getUnclaimedValue()).toBe(total)
  })

  it('excludes P2SH-P2WPKH entry after claim is mined', () => {
    const { snapshot, holders } = createMockSnapshot()
    const chain = new Blockchain(snapshot)
    const genesisHash = chain.blocks[0].hash

    const p2shHolder = holders.find(h => h.type === 'p2sh' && !h.signerKeys)!
    const p2shEntry = snapshot.entries.find(e => e.type === 'p2sh' && e.btcAddress === p2shHolder.address)!

    const claimTx = createClaimTransaction(
      p2shHolder.secretKey,
      p2shHolder.publicKey,
      p2shEntry,
      walletA,
      snapshot.btcBlockHash,
      genesisHash
    )
    chain.addBlock(mineOnChain(chain, 'f'.repeat(64), [claimTx]))

    const entries = chain.getClaimableEntries()
    expect(entries.find(e => e.btcAddress === p2shEntry.btcAddress)).toBeUndefined()
    expect(entries.length).toBe(snapshot.entries.length - 1)
    expect(chain.isClaimed(p2shEntry.btcAddress)).toBe(true)
  })

  it('excludes P2TR entry after claim is mined', () => {
    const { snapshot, holders } = createMockSnapshot()
    const chain = new Blockchain(snapshot)
    const genesisHash = chain.blocks[0].hash

    const p2trHolder = holders.find(h => h.type === 'p2tr')!
    const p2trEntry = snapshot.entries.find(e => e.type === 'p2tr')!

    const claimTx = createClaimTransaction(
      p2trHolder.secretKey,
      p2trHolder.publicKey,
      p2trEntry,
      walletA,
      snapshot.btcBlockHash,
      genesisHash
    )
    chain.addBlock(mineOnChain(chain, 'f'.repeat(64), [claimTx]))

    const entries = chain.getClaimableEntries()
    expect(entries.find(e => e.btcAddress === p2trEntry.btcAddress)).toBeUndefined()
    expect(entries.length).toBe(snapshot.entries.length - 1)
    expect(chain.isClaimed(p2trEntry.btcAddress)).toBe(true)
  })

  it('excludes P2WSH entry after claim is mined', () => {
    const { snapshot, holders } = createMockSnapshot()
    const chain = new Blockchain(snapshot)
    const genesisHash = chain.blocks[0].hash

    const p2wshHolder = holders.find(h => h.type === 'p2wsh')!
    const p2wshEntry = snapshot.entries.find(e => e.type === 'p2wsh')!

    const claimTx = createP2wshClaimTransaction(
      [p2wshHolder.signerKeys![0].secretKey, p2wshHolder.signerKeys![1].secretKey],
      p2wshHolder.witnessScript!,
      p2wshEntry,
      walletA,
      snapshot.btcBlockHash,
      genesisHash
    )
    chain.addBlock(mineOnChain(chain, 'f'.repeat(64), [claimTx]))

    const entries = chain.getClaimableEntries()
    expect(entries.find(e => e.btcAddress === p2wshEntry.btcAddress)).toBeUndefined()
    expect(entries.length).toBe(snapshot.entries.length - 1)
    expect(chain.isClaimed(p2wshEntry.btcAddress)).toBe(true)
  })

  it('excludes P2SH multisig entry after claim is mined', () => {
    const { snapshot, holders } = createMockSnapshot()
    const chain = new Blockchain(snapshot)
    const genesisHash = chain.blocks[0].hash

    const p2shMultisigHolder = holders.find(h => h.type === 'p2sh' && h.signerKeys)!
    const p2shMultisigEntry = snapshot.entries.find(e =>
      e.type === 'p2sh' && e.btcAddress === p2shMultisigHolder.address
    )!

    const claimTx = createP2shMultisigClaimTransaction(
      [p2shMultisigHolder.signerKeys![0].secretKey, p2shMultisigHolder.signerKeys![1].secretKey],
      p2shMultisigHolder.witnessScript!,
      p2shMultisigEntry,
      walletA,
      snapshot.btcBlockHash,
      genesisHash
    )
    chain.addBlock(mineOnChain(chain, 'f'.repeat(64), [claimTx]))

    const entries = chain.getClaimableEntries()
    expect(entries.find(e => e.btcAddress === p2shMultisigEntry.btcAddress)).toBeUndefined()
    expect(entries.length).toBe(snapshot.entries.length - 1)
    expect(chain.isClaimed(p2shMultisigEntry.btcAddress)).toBe(true)
  })
})
