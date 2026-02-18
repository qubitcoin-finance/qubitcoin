import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import { Node } from '../node.js'
import { P2PServer } from '../p2p/server.js'
import { FileBlockStorage } from '../storage.js'
import { walletA, walletB } from './fixtures.js'

import {
  encodeMessage,
  decodeMessages,
  type Message,
  MAX_MESSAGE_SIZE,
  PROTOCOL_VERSION,
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
    const msg: Message = { type: 'version', payload: { version: PROTOCOL_VERSION, height: 10, genesisHash: 'a'.repeat(64), userAgent: 'test' } }
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
    tmpDir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-p2p-1-'))
    tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-p2p-2-'))

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

  it('should reject peer with wrong protocol version', async () => {
    const addr = (p2p1 as any).server.address()
    const port = typeof addr === 'object' ? addr.port : 0

    // Connect a raw TCP socket and send a version message with wrong protocol version
    const socket = net.createConnection({ host: '127.0.0.1', port })
    await new Promise<void>((resolve) => socket.once('connect', resolve))

    const versionMsg = encodeMessage({
      type: 'version',
      payload: {
        version: 1, // old version, current is 2
        height: 0,
        genesisHash: node1.chain.blocks[0].hash,
        userAgent: 'old-node',
      },
    })
    socket.write(versionMsg)

    // Should receive a reject message and then the connection should close
    const data = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = []
      socket.on('data', (chunk) => chunks.push(chunk))
      socket.on('close', () => resolve(Buffer.concat(chunks)))
      setTimeout(() => reject(new Error('timeout')), 5_000)
    })

    // Decode the response — should contain a reject message
    const { messages } = decodeMessages(data)
    const rejectMsg = messages.find((m) => m.type === 'reject')
    expect(rejectMsg).toBeDefined()
    expect((rejectMsg!.payload as any).reason).toContain('protocol version mismatch')

    socket.destroy()
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
    // Use snapshot-based nodes so we can relay a claim tx (no coinbase maturity needed)
    const { createMockSnapshot } = await import('../snapshot.js')
    const { createClaimTransaction } = await import('../claim.js')
    const { snapshot, holders } = createMockSnapshot()

    // Replace nodes with snapshot-aware ones
    await p2p1.stop()
    await p2p2.stop()

    const storage1b = new FileBlockStorage(tmpDir1)
    const storage2b = new FileBlockStorage(tmpDir2)
    const sNode1 = new Node('alice', snapshot, storage1b)
    const sNode2 = new Node('bob', snapshot, storage2b)
    sNode1.chain.difficulty = TEST_TARGET
    sNode2.chain.difficulty = TEST_TARGET

    const sp2p1 = new P2PServer(sNode1, 0, tmpDir1)
    const sp2p2 = new P2PServer(sNode2, 0, tmpDir2)
    await sp2p1.start()
    await sp2p2.start()

    try {
      // Connect
      const addr = (sp2p1 as any).server.address()
      const port = typeof addr === 'object' ? addr.port : 0
      sp2p2.connectOutbound('127.0.0.1', port)

      await waitFor(() => sp2p1.getPeers().length > 0 && sp2p2.getPeers().length > 0)

      // Create a claim transaction on node1 (must include genesis hash for cross-fork replay protection)
      const genesisHash = sNode1.chain.blocks[0].hash
      const claimTx = createClaimTransaction(
        holders[0].secretKey,
        holders[0].publicKey,
        snapshot.entries[0],
        walletA,
        snapshot.btcBlockHash,
        genesisHash
      )

      sNode1.receiveTransaction(claimTx)

      // Wait for it to appear in node2's mempool
      await waitFor(() => sNode2.mempool.size() > 0, 10_000)
      expect(sNode2.mempool.getTransaction(claimTx.id)).toBeDefined()
    } finally {
      await sp2p1.stop()
      await sp2p2.stop()
    }
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

  const TEST_TARGET = '0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

  beforeEach(async () => {
    tmpDir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-fork-1-'))
    tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-fork-2-'))

    const storage1 = new FileBlockStorage(tmpDir1)
    const storage2 = new FileBlockStorage(tmpDir2)

    node1 = new Node('alice', undefined, storage1)
    node2 = new Node('bob', undefined, storage2)

    // Use easy difficulty for fast test mining
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

  it('should resolve fork by switching to longer chain', { timeout: 60_000 }, async () => {
    const wallet1 = walletA
    const wallet2 = walletB

    // Mine a shared block so both nodes have a common ancestor at height 1
    // (ensures resetToHeight uses the fast path, preserving test difficulty)
    node1.mine(wallet1.address, false)
    node2.chain.addBlock(node1.chain.blocks[1])

    expect(node1.chain.getHeight()).toBe(1)
    expect(node2.chain.getHeight()).toBe(1)

    // Both nodes mine independently — creating divergent chains
    // Node1 mines 1 more block (shorter fork, height 2)
    node1.mine(wallet1.address, false)
    // Node2 mines 3 more blocks (longer fork, height 4)
    for (let i = 0; i < 3; i++) {
      node2.mine(wallet2.address, false)
    }

    expect(node1.chain.getHeight()).toBe(2)
    expect(node2.chain.getHeight()).toBe(4)

    // Chains are divergent (different blocks after the shared ancestor)
    expect(node1.chain.blocks[2].hash).not.toBe(node2.chain.blocks[2].hash)

    // Connect node1 to node2 — node1 should detect fork and reorg to node2's chain
    const addr = (p2p2 as any).server.address()
    const port = typeof addr === 'object' ? addr.port : 0
    p2p1.connectOutbound('127.0.0.1', port)

    // Wait for node1 to sync to node2's height
    await waitFor(() => node1.chain.getHeight() >= 4, 30_000)

    expect(node1.chain.getHeight()).toBe(4)
    // Should now have the same chain tip
    expect(node1.chain.getChainTip().hash).toBe(node2.chain.getChainTip().hash)
  })

  it('should not reorg to shorter chain', { timeout: 60_000 }, async () => {
    const wallet1 = walletA
    const wallet2 = walletB

    // Mine a shared block so both nodes have a common ancestor at height 1
    node1.mine(wallet1.address, false)
    node2.chain.addBlock(node1.chain.blocks[1])

    // Node1 mines 3 more blocks (longer, height 4)
    for (let i = 0; i < 3; i++) {
      node1.mine(wallet1.address, false)
    }
    // Node2 mines 1 more block (shorter, height 2)
    node2.mine(wallet2.address, false)

    const originalTip = node1.chain.getChainTip().hash

    // Connect node1 to node2 — node1 should NOT reorg since it has the longer chain
    const addr = (p2p2 as any).server.address()
    const port = typeof addr === 'object' ? addr.port : 0
    p2p1.connectOutbound('127.0.0.1', port)

    // Wait for handshake
    await waitFor(() => p2p1.getPeers().length > 0 && p2p2.getPeers().length > 0)

    // Give some time for potential (unwanted) reorg
    await new Promise((r) => setTimeout(r, 500))

    // Node1 should keep its longer chain
    expect(node1.chain.getHeight()).toBe(4)
    expect(node1.chain.getChainTip().hash).toBe(originalTip)
  })
})

describe('P2P improvements', () => {
  let tmpDir1: string
  let tmpDir2: string

  const TEST_TARGET = '0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

  beforeEach(() => {
    tmpDir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-imp-1-'))
    tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-imp-2-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir1, { recursive: true, force: true })
    fs.rmSync(tmpDir2, { recursive: true, force: true })
  })

  it('should relay P2WSH claim transactions with correct binary fields', async () => {
    const { createMockSnapshot } = await import('../snapshot.js')
    const { createP2wshClaimTransaction } = await import('../claim.js')
    const { snapshot, holders } = createMockSnapshot()

    const p2wshHolder = holders.find(h => h.type === 'p2wsh')!
    const p2wshEntry = snapshot.entries.find(e => e.type === 'p2wsh')!

    const storage1 = new FileBlockStorage(tmpDir1)
    const storage2 = new FileBlockStorage(tmpDir2)
    const sNode1 = new Node('alice', snapshot, storage1)
    const sNode2 = new Node('bob', snapshot, storage2)
    sNode1.chain.difficulty = TEST_TARGET
    sNode2.chain.difficulty = TEST_TARGET

    const sp2p1 = new P2PServer(sNode1, 0, tmpDir1)
    const sp2p2 = new P2PServer(sNode2, 0, tmpDir2)
    await sp2p1.start()
    await sp2p2.start()

    try {
      const addr = (sp2p1 as any).server.address()
      const port = typeof addr === 'object' ? addr.port : 0
      sp2p2.connectOutbound('127.0.0.1', port)

      await waitFor(() => sp2p1.getPeers().length > 0 && sp2p2.getPeers().length > 0)

      // Create a P2WSH claim tx (must include genesis hash for cross-fork replay protection)
      const genesisHash = sNode1.chain.blocks[0].hash
      const claimTx = createP2wshClaimTransaction(
        [p2wshHolder.signerKeys![0].secretKey, p2wshHolder.signerKeys![1].secretKey],
        p2wshHolder.witnessScript!,
        p2wshEntry,
        walletA,
        snapshot.btcBlockHash,
        genesisHash
      )

      sNode1.receiveTransaction(claimTx)

      // Wait for it to appear in node2's mempool
      await waitFor(() => sNode2.mempool.size() > 0, 10_000)

      const relayed = sNode2.mempool.getTransaction(claimTx.id)!
      expect(relayed).toBeDefined()
      expect(relayed.claimData!.witnessScript).toBeInstanceOf(Uint8Array)
      expect(relayed.claimData!.witnessSignatures).toBeInstanceOf(Uint8Array)
      expect(relayed.claimData!.witnessScript!.length).toBeGreaterThan(0)
      expect(relayed.claimData!.witnessSignatures!.length).toBe(128) // 2 × 64
    } finally {
      await sp2p1.stop()
      await sp2p2.stop()
    }
  })

  it('should reject inbound connections exceeding per-IP limit', async () => {
    const storage1 = new FileBlockStorage(tmpDir1)
    const node1 = new Node('alice', undefined, storage1)
    const p2p1 = new P2PServer(node1, 0, tmpDir1)
    await p2p1.start()

    try {
      const addr = (p2p1 as any).server.address()
      const port = typeof addr === 'object' ? addr.port : 0

      // Open 4 inbound connections from same IP (limit is 3)
      const sockets: net.Socket[] = []
      for (let i = 0; i < 4; i++) {
        const sock = net.createConnection({ host: '127.0.0.1', port })
        sockets.push(sock)
        await new Promise<void>(r => sock.once('connect', r))
      }

      // Wait for all connections to be processed by the server
      await waitFor(() => (p2p1 as any).peers.size >= 3, 2_000)
      // Small extra delay for the 4th to be rejected
      await new Promise(r => setTimeout(r, 50))

      // Should have at most 3 inbound peers from same IP
      const inboundCount = (p2p1 as any).inboundCount
      expect(inboundCount).toBeLessThanOrEqual(3)

      for (const sock of sockets) sock.destroy()
    } finally {
      await p2p1.stop()
    }
  })

  it('miningStats is null before mining starts', () => {
    const storage = new FileBlockStorage(tmpDir1)
    const node = new Node('alice', undefined, storage)
    expect(node.miningStats).toBeNull()
  })

  it('miningStats is populated during mining and null after stop', async () => {
    const storage = new FileBlockStorage(tmpDir1)
    const node = new Node('alice', undefined, storage)
    // Use a harder target so mining doesn't finish instantly
    node.chain.difficulty = '00000fffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

    const miningPromise = node.startMining(walletA.address)

    // Wait for miningStats to be populated
    await waitFor(() => node.miningStats !== null, 10_000)
    expect(node.miningStats).not.toBeNull()
    expect(node.miningStats!.blockHeight).toBe(node.chain.getHeight() + 1)
    expect(node.miningStats!.startedAt).toBeGreaterThan(0)

    node.stopMining()
    await Promise.race([
      miningPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5_000))
    ])

    expect(node.miningStats).toBeNull()
  })

  it('miningStats resets to null after block is mined', async () => {
    const storage = new FileBlockStorage(tmpDir1)
    const node = new Node('alice', undefined, storage)
    node.chain.difficulty = TEST_TARGET

    const miningPromise = node.startMining(walletA.address)

    // Wait for a block to be mined
    await waitFor(() => node.chain.getHeight() >= 1, 10_000)

    // After a block is found, miningStats should briefly be null before the next round starts
    // Stop mining to observe the final state
    node.stopMining()
    await Promise.race([
      miningPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5_000))
    ])

    expect(node.miningStats).toBeNull()
  })

  it('miningStats appears in getState()', async () => {
    const storage = new FileBlockStorage(tmpDir1)
    const node = new Node('alice', undefined, storage)
    node.chain.difficulty = '00000fffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

    const miningPromise = node.startMining(walletA.address)

    await waitFor(() => node.miningStats !== null, 10_000)

    const state = node.getState()
    expect(state.miningStats).not.toBeNull()
    expect(state.miningStats!.hashrate).toBeGreaterThanOrEqual(0)
    expect(state.miningStats!.nonce).toBeGreaterThanOrEqual(0)

    node.stopMining()
    await Promise.race([
      miningPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5_000))
    ])

    const stateAfter = node.getState()
    expect(stateAfter.miningStats).toBeNull()
  })

  it('stopMining should stop the mining loop', async () => {
    const storage1 = new FileBlockStorage(tmpDir1)
    const node1 = new Node('alice', undefined, storage1)
    node1.chain.difficulty = TEST_TARGET

    // Start mining in the background
    const miningPromise = node1.startMining(walletA.address)

    // Wait for at least one block to be mined
    await waitFor(() => node1.chain.getHeight() >= 1, 10_000)

    // Stop mining
    node1.stopMining()

    // The mining promise should resolve (not hang forever)
    await Promise.race([
      miningPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('stopMining did not resolve')), 5_000))
    ])

    // Record height — should not increase after stopping
    const heightAfterStop = node1.chain.getHeight()
    await new Promise(r => setTimeout(r, 500))
    expect(node1.chain.getHeight()).toBe(heightAfterStop)
  })
})

describe('P2P waitForSync', () => {
  let tmpDir: string
  let node: Node
  let p2p: P2PServer

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-p2p-sync-'))
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

describe('P2P security hardening', () => {
  let tmpDir1: string
  let tmpDir2: string

  const TEST_TARGET = '0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

  beforeEach(() => {
    tmpDir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-sec-1-'))
    tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-sec-2-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir1, { recursive: true, force: true })
    fs.rmSync(tmpDir2, { recursive: true, force: true })
  })

  it('should add misbehavior for invalid blocks sent by peer', async () => {
    const storage1 = new FileBlockStorage(tmpDir1)
    const storage2 = new FileBlockStorage(tmpDir2)
    const node1 = new Node('alice', undefined, storage1)
    const node2 = new Node('bob', undefined, storage2)
    node1.chain.difficulty = TEST_TARGET
    node2.chain.difficulty = TEST_TARGET

    const p2p1 = new P2PServer(node1, 0, tmpDir1)
    const p2p2 = new P2PServer(node2, 0, tmpDir2)
    await p2p1.start()
    await p2p2.start()

    try {
      const addr = (p2p1 as any).server.address()
      const port = typeof addr === 'object' ? addr.port : 0
      p2p2.connectOutbound('127.0.0.1', port)
      await waitFor(() => p2p1.getPeers().length > 0 && p2p2.getPeers().length > 0)

      // Send an invalid block FROM node2 TO node1
      const invalidBlock = {
        header: {
          version: 1,
          previousHash: node1.chain.blocks[0].hash,
          merkleRoot: 'a'.repeat(64),
          timestamp: Date.now(),
          target: TEST_TARGET,
          nonce: 0,
        },
        hash: 'b'.repeat(64), // fake hash
        transactions: [],
        height: 1,
      }

      // Get node1's view of the peer (to check misbehavior score)
      const peerOnNode1 = Array.from((p2p1 as any).peers.values())[0]
      const scoreBefore = peerOnNode1.getMisbehaviorScore()

      // Get node2's peer (sends TO node1) and send the invalid block
      const peerOnNode2 = Array.from((p2p2 as any).peers.values())[0]
      peerOnNode2.send({
        type: 'blocks',
        payload: { blocks: [invalidBlock] },
      })

      await new Promise(r => setTimeout(r, 300))

      // Node1's view of this peer should have misbehavior points (+25 for invalid block)
      const scoreAfter = peerOnNode1.getMisbehaviorScore()
      expect(scoreAfter).toBeGreaterThan(scoreBefore)
    } finally {
      await p2p1.stop()
      await p2p2.stop()
    }
  })

  it('should add misbehavior for invalid transactions', async () => {
    const storage1 = new FileBlockStorage(tmpDir1)
    const storage2 = new FileBlockStorage(tmpDir2)
    const node1 = new Node('alice', undefined, storage1)
    const node2 = new Node('bob', undefined, storage2)

    const p2p1 = new P2PServer(node1, 0, tmpDir1)
    const p2p2 = new P2PServer(node2, 0, tmpDir2)
    await p2p1.start()
    await p2p2.start()

    try {
      const addr = (p2p1 as any).server.address()
      const port = typeof addr === 'object' ? addr.port : 0
      p2p2.connectOutbound('127.0.0.1', port)
      await waitFor(() => p2p1.getPeers().length > 0 && p2p2.getPeers().length > 0)

      const peerOnNode1 = Array.from((p2p1 as any).peers.values())[0]
      const scoreBefore = peerOnNode1.getMisbehaviorScore()

      // Send an invalid tx FROM node2 TO node1
      const invalidTx = {
        id: 'c'.repeat(64),
        inputs: [{ txId: 'd'.repeat(64), outputIndex: 0, publicKey: '', signature: '' }],
        outputs: [{ address: 'e'.repeat(64), amount: 100 }],
        timestamp: Date.now(),
      }
      const peerOnNode2 = Array.from((p2p2 as any).peers.values())[0]
      peerOnNode2.send({
        type: 'tx',
        payload: { tx: invalidTx },
      })

      await new Promise(r => setTimeout(r, 300))

      const scoreAfter = peerOnNode1.getMisbehaviorScore()
      expect(scoreAfter).toBeGreaterThan(scoreBefore)
    } finally {
      await p2p1.stop()
      await p2p2.stop()
    }
  })

  it('should penalize oversized addr messages and cap entries', async () => {
    const storage1 = new FileBlockStorage(tmpDir1)
    const storage2 = new FileBlockStorage(tmpDir2)
    const node1 = new Node('alice', undefined, storage1)
    const node2 = new Node('bob', undefined, storage2)

    const p2p1 = new P2PServer(node1, 0, tmpDir1)
    const p2p2 = new P2PServer(node2, 0, tmpDir2)
    p2p1.setLocalMode(true)
    p2p2.setLocalMode(true)
    await p2p1.start()
    await p2p2.start()

    try {
      const addr = (p2p1 as any).server.address()
      const port = typeof addr === 'object' ? addr.port : 0
      p2p2.connectOutbound('127.0.0.1', port)
      await waitFor(() => p2p1.getPeers().length > 0 && p2p2.getPeers().length > 0)

      const peerOnNode1 = Array.from((p2p1 as any).peers.values())[0]

      // Send oversized addr FROM node2 TO node1 (200 entries, limit is 100)
      const addresses = Array.from({ length: 200 }, (_, i) => ({
        host: `10.0.${Math.floor(i / 256)}.${i % 256}`,
        port: 6001,
        lastSeen: Date.now(),
      }))
      const peerOnNode2 = Array.from((p2p2 as any).peers.values())[0]
      peerOnNode2.send({
        type: 'addr',
        payload: { addresses },
      })

      await new Promise(r => setTimeout(r, 300))

      // Node1 should have penalized the peer for oversized addr (+25)
      expect(peerOnNode1.getMisbehaviorScore()).toBeGreaterThanOrEqual(25)

      // Only up to 100 entries from this message should have been processed
      // (plus a few from handshake's own address and getaddr response)
      const knownAddrs = p2p1.getKnownAddresses()
      expect(knownAddrs.size).toBeLessThanOrEqual(105) // 100 from addr + small overhead
    } finally {
      await p2p1.stop()
      await p2p2.stop()
    }
  })

  it('should cache rejected block hashes and skip re-validation', async () => {
    const storage1 = new FileBlockStorage(tmpDir1)
    const storage2 = new FileBlockStorage(tmpDir2)
    const node1 = new Node('alice', undefined, storage1)
    const node2 = new Node('bob', undefined, storage2)
    node1.chain.difficulty = TEST_TARGET
    node2.chain.difficulty = TEST_TARGET

    const p2p1 = new P2PServer(node1, 0, tmpDir1)
    const p2p2 = new P2PServer(node2, 0, tmpDir2)
    await p2p1.start()
    await p2p2.start()

    try {
      const addr = (p2p1 as any).server.address()
      const port = typeof addr === 'object' ? addr.port : 0
      p2p2.connectOutbound('127.0.0.1', port)
      await waitFor(() => p2p1.getPeers().length > 0 && p2p2.getPeers().length > 0)

      // Send an invalid block FROM node2 TO node1
      const invalidBlock = {
        header: {
          version: 1,
          previousHash: node1.chain.blocks[0].hash,
          merkleRoot: 'a'.repeat(64),
          timestamp: Date.now(),
          target: TEST_TARGET,
          nonce: 0,
        },
        hash: 'b'.repeat(64),
        transactions: [],
        height: 1,
      }

      const peerOnNode1 = Array.from((p2p1 as any).peers.values())[0]
      const peerOnNode2 = Array.from((p2p2 as any).peers.values())[0]

      // Send first time
      peerOnNode2.send({
        type: 'blocks',
        payload: { blocks: [invalidBlock] },
      })
      await new Promise(r => setTimeout(r, 300))
      const scoreAfterFirst = peerOnNode1.getMisbehaviorScore()
      expect(scoreAfterFirst).toBeGreaterThan(0) // should have gotten +25

      // Verify the rejected cache has the hash
      expect((p2p1 as any).rejectedBlocks.has('b'.repeat(64))).toBe(true)

      // Send same block again — should be skipped via rejected cache (no extra misbehavior)
      peerOnNode2.send({
        type: 'blocks',
        payload: { blocks: [invalidBlock] },
      })
      await new Promise(r => setTimeout(r, 300))
      const scoreAfterSecond = peerOnNode1.getMisbehaviorScore()

      // Second send should NOT add more misbehavior (block was cached as rejected)
      expect(scoreAfterSecond).toBe(scoreAfterFirst)
    } finally {
      await p2p1.stop()
      await p2p2.stop()
    }
  })

  it('should add misbehavior for protocol version mismatch', async () => {
    const storage1 = new FileBlockStorage(tmpDir1)
    const storage2 = new FileBlockStorage(tmpDir2)
    const node1 = new Node('alice', undefined, storage1)
    const node2 = new Node('bob', undefined, storage2)
    node1.chain.difficulty = TEST_TARGET
    node2.chain.difficulty = TEST_TARGET

    const p2p1 = new P2PServer(node1, 0, tmpDir1)
    const p2p2 = new P2PServer(node2, 0, tmpDir2)
    await p2p1.start()
    await p2p2.start()

    try {
      const addr = (p2p1 as any).server.address()
      const port = typeof addr === 'object' ? addr.port : 0

      // Send a version message with wrong protocol version via raw socket
      const socket = net.createConnection({ host: '127.0.0.1', port })
      await new Promise<void>((resolve) => socket.once('connect', resolve))

      const versionMsg = encodeMessage({
        type: 'version',
        payload: {
          version: 999,
          height: 0,
          genesisHash: node1.chain.blocks[0].hash,
          userAgent: 'bad-node',
        },
      })
      socket.write(versionMsg)

      // Wait for disconnect
      await new Promise<void>((resolve) => {
        socket.on('close', resolve)
        setTimeout(resolve, 2_000)
      })
      socket.destroy()

      // The peer should have been disconnected — no peers remaining
      await new Promise(r => setTimeout(r, 100))
      expect(p2p1.getPeers().length).toBe(0)
    } finally {
      await p2p1.stop()
      await p2p2.stop()
    }
  })

  it('should not disconnect peer sending already-known blocks', async () => {
    const storage1 = new FileBlockStorage(tmpDir1)
    const storage2 = new FileBlockStorage(tmpDir2)
    const node1 = new Node('alice', undefined, storage1)
    const node2 = new Node('bob', undefined, storage2)
    node1.chain.difficulty = TEST_TARGET
    node2.chain.difficulty = TEST_TARGET

    const p2p1 = new P2PServer(node1, 0, tmpDir1)
    const p2p2 = new P2PServer(node2, 0, tmpDir2)
    await p2p1.start()
    await p2p2.start()

    try {
      // Mine blocks on node1 and sync to node2 manually
      node1.mine(walletA.address, false)
      node1.mine(walletA.address, false)
      node2.chain.addBlock(node1.chain.blocks[1])
      node2.chain.addBlock(node1.chain.blocks[2])

      expect(node1.chain.getHeight()).toBe(2)
      expect(node2.chain.getHeight()).toBe(2)

      // Connect
      const addr = (p2p1 as any).server.address()
      const port = typeof addr === 'object' ? addr.port : 0
      p2p2.connectOutbound('127.0.0.1', port)
      await waitFor(() => p2p1.getPeers().length > 0 && p2p2.getPeers().length > 0)

      // Send already-known blocks from node2 to node1 (simulating duplicate connection IBD)
      const peerOnNode2 = Array.from((p2p2 as any).peers.values())[0]
      peerOnNode2.send({
        type: 'blocks',
        payload: { blocks: [node1.chain.blocks[1], node1.chain.blocks[2]] },
      })

      await new Promise(r => setTimeout(r, 300))

      // Peer should NOT be disconnected or penalized
      const peerOnNode1 = Array.from((p2p1 as any).peers.values())[0]
      expect(peerOnNode1).toBeDefined()
      expect(peerOnNode1.getMisbehaviorScore()).toBe(0)
      expect(p2p1.getPeers().length).toBeGreaterThanOrEqual(1)
    } finally {
      await p2p1.stop()
      await p2p2.stop()
    }
  })

  it('should clamp addr timestamps to prevent future-lock', () => {
    const storage = new FileBlockStorage(tmpDir1)
    const node = new Node('test', undefined, storage)
    const p2p = new P2PServer(node, 0, tmpDir1)
    p2p.setLocalMode(true)

    // Directly test addKnownAddress via the private method
    const addAddr = (p2p as any).addKnownAddress.bind(p2p)

    // Add an address with a far-future timestamp
    const farFuture = Date.now() + 365 * 24 * 3600_000 // 1 year in the future
    addAddr('10.0.0.1', 6001, farFuture)

    const known = p2p.getKnownAddresses()
    const entry = known.get('10.0.0.1:6001')
    expect(entry).toBeDefined()
    // Should be clamped to at most ~2 hours in the future
    expect(entry!.lastSeen).toBeLessThan(Date.now() + 3 * 3600_000)
  })
})
