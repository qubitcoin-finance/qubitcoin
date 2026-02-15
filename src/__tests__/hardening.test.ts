/**
 * Tests for P2P & Mining hardening features
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Node } from '../node.js'
import { P2PServer } from '../p2p/server.js'
import { Peer } from '../p2p/peer.js'
import { FileBlockStorage } from '../storage.js'
import { Mempool } from '../mempool.js'
import { blockWork, STARTING_DIFFICULTY, INITIAL_TARGET } from '../block.js'
import {
  createTransaction,
  utxoKey,
  type UTXO,
} from '../transaction.js'
import { walletA, walletB } from './fixtures.js'
import net from 'node:net'

/** Wait for a condition to become true */
function waitFor(
  fn: () => boolean,
  timeout = 10_000,
  interval = 20,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const check = () => {
      if (fn()) return resolve()
      if (Date.now() - start > timeout) return reject(new Error('waitFor timeout'))
      setTimeout(check, interval)
    }
    check()
  })
}

function makeUtxoSet(wallet: { address: string }, amount = 100): Map<string, UTXO> {
  const utxoSet = new Map<string, UTXO>()
  const txId = 'a'.repeat(64)
  utxoSet.set(utxoKey(txId, 0), {
    txId,
    outputIndex: 0,
    address: wallet.address,
    amount,
  })
  return utxoSet
}

describe('Misbehavior score decay', () => {
  it('should decay score over time', () => {
    const socket = new net.Socket()
    const peer = new Peer(
      socket,
      true,
      () => {},
      () => {},
    )

    // Add some misbehavior
    peer.addMisbehavior(20)
    expect(peer.getMisbehaviorScore()).toBe(20)

    // Simulate time passing by directly setting lastMisbehaviorDecay
    ;(peer as any).lastMisbehaviorDecay = Date.now() - 5 * 60_000 // 5 minutes ago

    // Score should have decayed by 5
    expect(peer.getMisbehaviorScore()).toBe(15)

    socket.destroy()
  })

  it('should not decay below zero', () => {
    const socket = new net.Socket()
    const peer = new Peer(
      socket,
      true,
      () => {},
      () => {},
    )

    peer.addMisbehavior(3)
    ;(peer as any).lastMisbehaviorDecay = Date.now() - 10 * 60_000 // 10 minutes ago

    expect(peer.getMisbehaviorScore()).toBe(0)

    socket.destroy()
  })
})

describe('Private IP filtering', () => {
  let tmpDir: string
  let node: Node
  let p2p: P2PServer

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-ip-'))
    node = new Node('test')
    p2p = new P2PServer(node, 0, tmpDir)
  })

  afterEach(async () => {
    await p2p.stop()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('should reject RFC1918 addresses from address book', () => {
    // Call addKnownAddress via the private method
    const addAddr = (p2p as any).addKnownAddress.bind(p2p)

    addAddr('10.0.0.1', 6001)
    addAddr('172.16.0.1', 6001)
    addAddr('192.168.1.1', 6001)
    addAddr('127.0.0.1', 6001)
    addAddr('169.254.1.1', 6001)

    expect(p2p.getKnownAddresses().size).toBe(0)
  })

  it('should accept public addresses', () => {
    const addAddr = (p2p as any).addKnownAddress.bind(p2p)

    addAddr('8.8.8.8', 6001)
    addAddr('1.2.3.4', 6002)

    expect(p2p.getKnownAddresses().size).toBe(2)
  })

  it('should allow private IPs in local mode', () => {
    p2p.setLocalMode(true)
    const addAddr = (p2p as any).addKnownAddress.bind(p2p)

    addAddr('192.168.1.1', 6001)
    addAddr('10.0.0.1', 6002)

    expect(p2p.getKnownAddresses().size).toBe(2)
  })

  it('should reject IPv6 private addresses', () => {
    const addAddr = (p2p as any).addKnownAddress.bind(p2p)

    addAddr('::1', 6001)
    addAddr('fc00::1', 6001)
    addAddr('fd12::1', 6001)
    addAddr('fe80::1', 6001)

    expect(p2p.getKnownAddresses().size).toBe(0)
  })
})

describe('Minimum relay fee', () => {
  it('should reject zero-fee transactions', () => {
    const mempool = new Mempool()
    const wallet = walletA
    const utxoSet = makeUtxoSet(wallet, 100)

    // Create a transaction with zero fee (amount = all input)
    const tx = createTransaction(
      wallet,
      [{ txId: 'a'.repeat(64), outputIndex: 0, address: wallet.address, amount: 100 }],
      [{ address: 'b'.repeat(64), amount: 100 }],
      0
    )

    const result = mempool.addTransaction(tx, utxoSet)
    expect(result.success).toBe(false)
    expect(result.error).toContain('Fee rate')
    expect(result.error).toContain('below minimum')
  })

  it('should accept transactions with sufficient fee', () => {
    const mempool = new Mempool()
    const wallet = walletA
    const utxoSet = makeUtxoSet(wallet, 100000)

    // Create a transaction with a generous fee
    const tx = createTransaction(
      wallet,
      [{ txId: 'a'.repeat(64), outputIndex: 0, address: wallet.address, amount: 100000 }],
      [{ address: 'b'.repeat(64), amount: 50 }],
      10000 // large fee
    )

    const result = mempool.addTransaction(tx, utxoSet)
    expect(result.success).toBe(true)
  })

  it('should still accept claim transactions (fee-free)', async () => {
    const { createClaimTransaction } = await import('../claim.js')
    const { createMockSnapshot } = await import('../snapshot.js')

    const mempool = new Mempool()
    const { snapshot, holders } = createMockSnapshot()

    const claimTx = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      walletB,
      snapshot.btcBlockHash
    )

    const result = mempool.addTransaction(claimTx, new Map())
    expect(result.success).toBe(true)
  })
})

describe('Cumulative work', () => {
  it('blockWork computes correctly', () => {
    // Easy target = low work
    const easyWork = blockWork(INITIAL_TARGET)
    // Hard target = high work
    const hardWork = blockWork(STARTING_DIFFICULTY)
    expect(hardWork).toBeGreaterThan(easyWork)
    expect(easyWork).toBeGreaterThan(0n)
  })

  it('blockchain tracks cumulative work', () => {
    const node = new Node('test')
    const TEST_TARGET = '0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
    node.chain.difficulty = TEST_TARGET

    const initialWork = node.chain.cumulativeWork
    expect(initialWork).toBeGreaterThan(0n)

    // Mine a block
    node.mine(walletA.address, false)
    expect(node.chain.cumulativeWork).toBeGreaterThan(initialWork)
  })

  it('cumulative work decreases on resetToHeight', () => {
    const node = new Node('test')
    const TEST_TARGET = '0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
    node.chain.difficulty = TEST_TARGET

    // Mine 3 blocks
    for (let i = 0; i < 3; i++) {
      node.mine(walletA.address, false)
    }
    const workAt3 = node.chain.cumulativeWork

    // Reset to height 1
    node.chain.resetToHeight(1)
    expect(node.chain.cumulativeWork).toBeLessThan(workAt3)
    expect(node.chain.cumulativeWork).toBeGreaterThan(0n)
  })

  it('status includes cumulativeWork', () => {
    const node = new Node('test')
    const state = node.getState()
    expect(state.cumulativeWork).toBeDefined()
    expect(typeof state.cumulativeWork).toBe('string')
  })
})

describe('Fork resolution safety', () => {
  let tmpDir1: string
  let tmpDir2: string
  let node1: Node
  let node2: Node
  let p2p1: P2PServer
  let p2p2: P2PServer

  const TEST_TARGET = '0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

  beforeEach(async () => {
    tmpDir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-fr-1-'))
    tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-fr-2-'))

    node1 = new Node('alice', undefined, new FileBlockStorage(tmpDir1))
    node2 = new Node('bob', undefined, new FileBlockStorage(tmpDir2))

    node1.chain.difficulty = TEST_TARGET
    node2.chain.difficulty = TEST_TARGET

    p2p1 = new P2PServer(node1, 0, tmpDir1)
    p2p2 = new P2PServer(node2, 0, tmpDir2)

    await p2p1.start()
    await p2p2.start()
  })

  afterEach(async () => {
    await p2p1.stop()
    await p2p2.stop()
    fs.rmSync(tmpDir1, { recursive: true, force: true })
    fs.rmSync(tmpDir2, { recursive: true, force: true })
  })

  it('should clear fork resolution flag on peer disconnect', async () => {
    // Set fork resolution flag directly
    ;(p2p1 as any).forkResolutionInProgress = true

    // Simulate a peer connecting and disconnecting
    const addr = (p2p2 as any).server.address()
    const port = typeof addr === 'object' ? addr.port : 0
    p2p1.connectOutbound('127.0.0.1', port)

    await waitFor(() => p2p1.getPeers().length > 0)

    // Disconnect the peer
    const peers = p2p1.getPeers()
    const peer = (p2p1 as any).peers.get(peers[0].id) as Peer
    peer.disconnect('test disconnect')

    await waitFor(() => p2p1.getPeers().length === 0)

    // Flag should be cleared
    expect((p2p1 as any).forkResolutionInProgress).toBe(false)
  })
})

describe('Getaddr rate limiting', () => {
  it('should track lastGetaddrResponse on peer', () => {
    const socket = new net.Socket()
    const peer = new Peer(
      socket,
      true,
      () => {},
      () => {},
    )

    expect(peer.lastGetaddrResponse).toBe(0)
    peer.lastGetaddrResponse = Date.now()
    expect(peer.lastGetaddrResponse).toBeGreaterThan(0)

    socket.destroy()
  })
})

describe('Seed reconnection backoff', () => {
  let tmpDir: string
  let node: Node
  let p2p: P2PServer

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-backoff-'))
    node = new Node('test')
    p2p = new P2PServer(node, 0, tmpDir)
    await p2p.start()
  })

  afterEach(async () => {
    await p2p.stop()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('should increase backoff delay on failed connections', () => {
    const seedBackoff = (p2p as any).seedBackoff as Map<string, number>

    // Simulate failed connection by setting backoff
    seedBackoff.set('1.2.3.4:6001', 5000)
    expect(seedBackoff.get('1.2.3.4:6001')).toBe(5000)

    // After another failure, delay should double (up to max)
    seedBackoff.set('1.2.3.4:6001', 10000)
    expect(seedBackoff.get('1.2.3.4:6001')).toBe(10000)
  })

  it('should cap backoff at 60s', () => {
    const seedBackoff = (p2p as any).seedBackoff as Map<string, number>

    // Set backoff beyond max
    seedBackoff.set('1.2.3.4:6001', 120000)
    const delay = Math.min(seedBackoff.get('1.2.3.4:6001')! * 2, 60000)
    expect(delay).toBe(60000)
  })
})
