import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Node } from '../node.js'
import { P2PServer } from '../p2p/server.js'
import { FileBlockStorage } from '../storage.js'
import { generateWallet } from '../crypto.js'

const walletA = generateWallet()
const walletB = generateWallet()

import {
  encodeMessage,
  decodeMessages,
  type Message,
  MAX_MESSAGE_SIZE,
} from '../p2p/protocol.js'

/** Wait for a condition to become true, polling every `interval` ms */
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

describe('protocol encoding', () => {
  it('should encode and decode a message', () => {
    const msg: Message = { type: 'ping' }
    const buf = encodeMessage(msg)

    const { messages, remainder } = decodeMessages(buf)
    expect(messages).toHaveLength(1)
    expect(messages[0].type).toBe('ping')
    expect(remainder.length).toBe(0)
  })

  it('should handle partial data (incomplete frame)', () => {
    const msg: Message = { type: 'version', payload: { version: 1, height: 10, genesisHash: 'a'.repeat(64), userAgent: 'test' } }
    const buf = encodeMessage(msg)
    const partial = buf.subarray(0, buf.length - 5)

    const { messages, remainder } = decodeMessages(partial)
    expect(messages).toHaveLength(0)
    expect(remainder.length).toBe(partial.length)
  })

  it('should decode multiple concatenated messages', () => {
    const msg1 = encodeMessage({ type: 'ping' })
    const msg2 = encodeMessage({ type: 'pong' })
    const combined = Buffer.concat([msg1, msg2])

    const { messages, remainder } = decodeMessages(combined)
    expect(messages).toHaveLength(2)
    expect(messages[0].type).toBe('ping')
    expect(messages[1].type).toBe('pong')
    expect(remainder.length).toBe(0)
  })

  it('should reject oversized messages', () => {
    const buf = Buffer.alloc(4)
    buf.writeUInt32BE(MAX_MESSAGE_SIZE + 1, 0)

    expect(() => decodeMessages(buf)).toThrow('exceeds max')
  })
})

describe('P2P server integration', () => {
  let tmpDir1: string
  let tmpDir2: string
  let node1: Node
  let node2: Node
  let p2p1: P2PServer
  let p2p2: P2PServer

  const TEST_TARGET = '0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

  beforeEach(async () => {
    tmpDir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'qtc-p2p-1-'))
    tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'qtc-p2p-2-'))

    const storage1 = new FileBlockStorage(tmpDir1)
    const storage2 = new FileBlockStorage(tmpDir2)

    node1 = new Node('alice', undefined, storage1)
    node2 = new Node('bob', undefined, storage2)

    // Use easy difficulty for fast test mining
    node1.chain.difficulty = TEST_TARGET
    node2.chain.difficulty = TEST_TARGET

    p2p1 = new P2PServer(node1, 0, tmpDir1) // port 0 = random
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

  it('should complete handshake between two nodes', async () => {
    // Get the actual port p2p1 is listening on
    const addr = (p2p1 as any).server.address()
    const port = typeof addr === 'object' ? addr.port : 0

    p2p2.connectOutbound('127.0.0.1', port)

    await waitFor(() => p2p1.getPeers().length > 0 && p2p2.getPeers().length > 0)

    expect(p2p1.getPeers().length).toBeGreaterThanOrEqual(1)
    expect(p2p2.getPeers().length).toBeGreaterThanOrEqual(1)
  })

  it('should sync blocks via IBD', async () => {
    const wallet = walletA

    // Mine blocks on node1
    node1.chain.difficulty = TEST_TARGET
    for (let i = 0; i < 3; i++) {
      node1.mine(wallet.address, false)
    }
    expect(node1.chain.getHeight()).toBe(3)

    // Connect node2 to node1
    const addr = (p2p1 as any).server.address()
    const port = typeof addr === 'object' ? addr.port : 0
    p2p2.connectOutbound('127.0.0.1', port)

    // Wait for node2 to sync
    await waitFor(() => node2.chain.getHeight() >= 3, 15_000)
    expect(node2.chain.getHeight()).toBe(3)
  })

  it('should propagate new blocks between connected peers', async () => {
    const wallet = walletA

    // Connect first
    const addr = (p2p1 as any).server.address()
    const port = typeof addr === 'object' ? addr.port : 0
    p2p2.connectOutbound('127.0.0.1', port)

    await waitFor(() => p2p1.getPeers().length > 0 && p2p2.getPeers().length > 0)

    // Mine on node1 — should propagate to node2
    node1.chain.difficulty = TEST_TARGET
    node1.mine(wallet.address, false)

    await waitFor(() => node2.chain.getHeight() >= 1, 10_000)
    expect(node2.chain.getHeight()).toBe(1)
    expect(node2.chain.blocks[1].hash).toBe(node1.chain.blocks[1].hash)
  })

  it('should relay transactions between peers', async () => {
    const wallet = walletA

    // Mine a block on node1 to create a coinbase UTXO
    node1.chain.difficulty = TEST_TARGET
    node1.mine(wallet.address, false)

    // Connect
    const addr = (p2p1 as any).server.address()
    const port = typeof addr === 'object' ? addr.port : 0
    p2p2.connectOutbound('127.0.0.1', port)

    // Wait for sync
    await waitFor(() => node2.chain.getHeight() >= 1, 10_000)

    // Create a transaction on node1
    const { createTransaction } = await import('../transaction.js')
    const wallet2 = walletB
    const utxos = node1.chain.findUTXOs(wallet.address, 1)
    const tx = createTransaction(wallet, utxos, [{ address: wallet2.address, amount: 1 }], 0.125)

    node1.receiveTransaction(tx)

    // Wait for it to appear in node2's mempool
    await waitFor(() => node2.mempool.size() > 0, 10_000)
    expect(node2.mempool.getTransaction(tx.id)).toBeDefined()
  })

  it('waitForSync resolves after IBD completes', async () => {
    const wallet = walletA

    // Mine blocks on node1 first
    node1.chain.difficulty = TEST_TARGET
    for (let i = 0; i < 3; i++) {
      node1.mine(wallet.address, false)
    }
    expect(node1.chain.getHeight()).toBe(3)

    // Start waiting for sync BEFORE connecting (the promise should resolve once IBD finishes)
    const syncPromise = p2p2.waitForSync()

    // Now connect node2 to node1
    const addr = (p2p1 as any).server.address()
    const port = typeof addr === 'object' ? addr.port : 0
    p2p2.connectOutbound('127.0.0.1', port)

    // waitForSync should resolve once IBD completes
    await syncPromise

    // Verify node2 has all the blocks
    expect(node2.chain.getHeight()).toBe(3)
    expect(node2.chain.blocks[3].hash).toBe(node1.chain.blocks[3].hash)
  })

  it('waitForSync resolves immediately when peer is not ahead', async () => {
    // Both nodes are at the same height (0 — genesis only)
    // Register waitForSync BEFORE connecting so the resolver is in place
    // when handleVerack fires notifySynced()
    const syncPromise = p2p2.waitForSync(10_000)

    const addr = (p2p1 as any).server.address()
    const port = typeof addr === 'object' ? addr.port : 0
    const start = Date.now()
    p2p2.connectOutbound('127.0.0.1', port)

    // Should resolve quickly since peer is not ahead (no IBD needed)
    await syncPromise
    const elapsed = Date.now() - start

    // Should resolve well under the 10s timeout (handshake only, no block download)
    expect(elapsed).toBeLessThan(5000)
    expect(node2.chain.getHeight()).toBe(node1.chain.getHeight())
  })

  it('connectToSeeds establishes outbound connection', async () => {
    // Get the port node1 is listening on
    const addr = (p2p1 as any).server.address()
    const port = typeof addr === 'object' ? addr.port : 0

    // Use connectToSeeds instead of manual connectOutbound
    p2p2.connectToSeeds([`127.0.0.1:${port}`])

    // Verify outbound connection is established
    await waitFor(() => p2p2.getPeers().length > 0 && p2p1.getPeers().length > 0)

    expect(p2p2.getPeers().length).toBeGreaterThanOrEqual(1)
    expect(p2p1.getPeers().length).toBeGreaterThanOrEqual(1)

    // Verify seeds are stored (accessible via the private field)
    const seeds = (p2p2 as any).seeds
    expect(seeds).toHaveLength(1)
    expect(seeds[0].host).toBe('127.0.0.1')
    expect(seeds[0].port).toBe(port)
  })
})

describe('P2P fork resolution', () => {
  let tmpDir1: string
  let tmpDir2: string
  let node1: Node
  let node2: Node
  let p2p1: P2PServer
  let p2p2: P2PServer

  beforeEach(async () => {
    tmpDir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'qtc-fork-1-'))
    tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'qtc-fork-2-'))

    const storage1 = new FileBlockStorage(tmpDir1)
    const storage2 = new FileBlockStorage(tmpDir2)

    // Don't override difficulty — use STARTING_DIFFICULTY so resetToHeight works correctly
    node1 = new Node('alice', undefined, storage1)
    node2 = new Node('bob', undefined, storage2)

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

  it('should resolve fork by switching to longer chain', { timeout: 60_000 }, async () => {
    const wallet1 = walletA
    const wallet2 = walletB

    // Both nodes mine independently — creating divergent chains
    // Node1 mines 1 block (shorter fork)
    node1.mine(wallet1.address, false)
    // Node2 mines 3 blocks (longer fork)
    for (let i = 0; i < 3; i++) {
      node2.mine(wallet2.address, false)
    }

    expect(node1.chain.getHeight()).toBe(1)
    expect(node2.chain.getHeight()).toBe(3)

    // Chains are divergent (different blocks at same heights)
    expect(node1.chain.blocks[1].hash).not.toBe(node2.chain.blocks[1].hash)

    // Connect node1 to node2 — node1 should detect fork and reorg to node2's chain
    const addr = (p2p2 as any).server.address()
    const port = typeof addr === 'object' ? addr.port : 0
    p2p1.connectOutbound('127.0.0.1', port)

    // Wait for node1 to sync to node2's height
    await waitFor(() => node1.chain.getHeight() >= 3, 30_000)

    expect(node1.chain.getHeight()).toBe(3)
    // Should now have the same chain tip
    expect(node1.chain.getChainTip().hash).toBe(node2.chain.getChainTip().hash)
  })

  it('should not reorg to shorter chain', { timeout: 60_000 }, async () => {
    const wallet1 = walletA
    const wallet2 = walletB

    // Node1 mines 3 blocks (longer)
    for (let i = 0; i < 3; i++) {
      node1.mine(wallet1.address, false)
    }
    // Node2 mines 1 block (shorter)
    node2.mine(wallet2.address, false)

    const originalTip = node1.chain.getChainTip().hash

    // Connect node1 to node2 — node1 should NOT reorg since it has the longer chain
    const addr = (p2p2 as any).server.address()
    const port = typeof addr === 'object' ? addr.port : 0
    p2p1.connectOutbound('127.0.0.1', port)

    // Wait for handshake
    await waitFor(() => p2p1.getPeers().length > 0 && p2p2.getPeers().length > 0)

    // Give some time for potential (unwanted) reorg
    await new Promise((r) => setTimeout(r, 2000))

    // Node1 should keep its longer chain
    expect(node1.chain.getHeight()).toBe(3)
    expect(node1.chain.getChainTip().hash).toBe(originalTip)
  })
})

describe('P2P waitForSync', () => {
  let tmpDir: string
  let node: Node
  let p2p: P2PServer

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qtc-p2p-sync-'))
    const storage = new FileBlockStorage(tmpDir)
    node = new Node('lonely', undefined, storage)
    p2p = new P2PServer(node, 0, tmpDir) // port 0 = random
    await p2p.start()
  })

  afterEach(async () => {
    await p2p.stop()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('waitForSync rejects on timeout with no peers', async () => {
    // Node has no peers connected — waitForSync should reject after timeout
    await expect(p2p.waitForSync(1_000)).rejects.toThrow(/sync/)
  })
})
