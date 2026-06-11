import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import { Node } from '../node.js'
import { P2PServer } from '../p2p/server.js'
import { Peer } from '../p2p/peer.js'
import {
  getSubnet16,
  isRoutableAddress,
  parseAddressEntry,
  upsertKnownAddress,
  type KnownAddress,
} from '../p2p/address-book.js'
import { OrphanBlockPool } from '../p2p/orphan-pool.js'
import { FileBlockStorage, sanitizeForStorage } from '../storage.js'
import { walletA, walletB } from './fixtures.js'
import { probeLoopbackTcpListen } from './network-test-utils.js'

import {
  encodeMessage,
  decodeMessages,
  type Message,
  MAX_MESSAGE_SIZE,
  PROTOCOL_VERSION,
} from '../p2p/protocol.js'

const LOOPBACK_TCP_SUPPORTED = await probeLoopbackTcpListen()
const describeLoopbackTcp = LOOPBACK_TCP_SUPPORTED ? describe : describe.skip

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

  it('should reject zero-length messages', () => {
    const buf = Buffer.alloc(4)
    buf.writeUInt32BE(0, 0)

    expect(() => decodeMessages(buf)).toThrow('Empty message')
  })

  it('should reject unknown message types', () => {
    // Manually create a frame with an unknown type
    const json = JSON.stringify({ type: 'faketype', payload: {} })
    const body = Buffer.from(json, 'utf-8')
    const frame = Buffer.alloc(4 + body.length)
    frame.writeUInt32BE(body.length, 0)
    body.copy(frame, 4)

    expect(() => decodeMessages(frame)).toThrow('Invalid message type')
  })

  it('should reject messages without a type field', () => {
    const json = JSON.stringify({ payload: 'hello' })
    const body = Buffer.from(json, 'utf-8')
    const frame = Buffer.alloc(4 + body.length)
    frame.writeUInt32BE(body.length, 0)
    body.copy(frame, 4)

    expect(() => decodeMessages(frame)).toThrow('missing type')
  })

  it('should reject non-object top-level JSON frames', () => {
    const json = JSON.stringify(['not', 'a', 'message'])
    const body = Buffer.from(json, 'utf-8')
    const frame = Buffer.alloc(4 + body.length)
    frame.writeUInt32BE(body.length, 0)
    body.copy(frame, 4)

    expect(() => decodeMessages(frame)).toThrow('expected object')
  })

  it('should reject tx messages with primitive payloads', () => {
    const json = JSON.stringify({ type: 'tx', payload: 'not-an-object' })
    const body = Buffer.from(json, 'utf-8')
    const frame = Buffer.alloc(4 + body.length)
    frame.writeUInt32BE(body.length, 0)
    body.copy(frame, 4)

    expect(() => decodeMessages(frame)).toThrow('Invalid tx payload')
  })

  it('should reject tx messages without an object tx field', () => {
    const json = JSON.stringify({ type: 'tx', payload: { tx: 'not-an-object' } })
    const body = Buffer.from(json, 'utf-8')
    const frame = Buffer.alloc(4 + body.length)
    frame.writeUInt32BE(body.length, 0)
    body.copy(frame, 4)

    expect(() => decodeMessages(frame)).toThrow('expected tx object')
  })

  it('should reject headers messages with array payloads', () => {
    const json = JSON.stringify({ type: 'headers', payload: [] })
    const body = Buffer.from(json, 'utf-8')
    const frame = Buffer.alloc(4 + body.length)
    frame.writeUInt32BE(body.length, 0)
    body.copy(frame, 4)

    expect(() => decodeMessages(frame)).toThrow('Invalid headers payload')
  })

  it('should reject blocks messages without a blocks array', () => {
    const json = JSON.stringify({ type: 'blocks', payload: { blocks: {} } })
    const body = Buffer.from(json, 'utf-8')
    const frame = Buffer.alloc(4 + body.length)
    frame.writeUInt32BE(body.length, 0)
    body.copy(frame, 4)

    expect(() => decodeMessages(frame)).toThrow('expected blocks array')
  })

  it('should reject inv messages without string type/hash fields', () => {
    const json = JSON.stringify({ type: 'inv', payload: { type: 'block', hash: 123 } })
    const body = Buffer.from(json, 'utf-8')
    const frame = Buffer.alloc(4 + body.length)
    frame.writeUInt32BE(body.length, 0)
    body.copy(frame, 4)

    expect(() => decodeMessages(frame)).toThrow('expected type/hash strings')
  })

  it('should reject getheaders messages without a locatorHashes array', () => {
    const json = JSON.stringify({ type: 'getheaders', payload: { locatorHashes: 'abc' } })
    const body = Buffer.from(json, 'utf-8')
    const frame = Buffer.alloc(4 + body.length)
    frame.writeUInt32BE(body.length, 0)
    body.copy(frame, 4)

    expect(() => decodeMessages(frame)).toThrow('expected locatorHashes array')
  })

  it('should reject addr messages without an addresses array', () => {
    const json = JSON.stringify({ type: 'addr', payload: { addresses: 'not-an-array' } })
    const body = Buffer.from(json, 'utf-8')
    const frame = Buffer.alloc(4 + body.length)
    frame.writeUInt32BE(body.length, 0)
    body.copy(frame, 4)

    expect(() => decodeMessages(frame)).toThrow('expected addresses array')
  })
})

describe('P2P address book helpers', () => {
  it('parses only IP address entries with valid ports and timestamps', () => {
    expect(parseAddressEntry({ host: '203.0.113.10', port: 6001 })).toEqual({
      host: '203.0.113.10',
      port: 6001,
    })
    expect(parseAddressEntry({ host: 'example.com', port: 6001 })).toBeNull()
    expect(parseAddressEntry({ host: '203.0.113.10', port: 0 })).toBeNull()
    expect(parseAddressEntry({ host: '203.0.113.10', port: 6001, lastSeen: Infinity })).toBeNull()
  })

  it('filters routability and clamps future timestamps when upserting', () => {
    const known = new Map<string, KnownAddress>()
    const now = 1_000_000

    upsertKnownAddress(known, '10.0.0.1', 6001, now, {
      localMode: false,
      enforceRoutability: true,
      maxAddresses: 10,
      now,
    })
    expect(known.size).toBe(0)

    upsertKnownAddress(known, '10.0.0.1', 6001, now + 10 * 3600_000, {
      localMode: true,
      enforceRoutability: true,
      maxAddresses: 10,
      now,
    })
    expect(known.get('10.0.0.1:6001')?.lastSeen).toBe(now + 2 * 3600_000)
  })

  it('groups IPv4-mapped addresses by /16 subnet', () => {
    expect(getSubnet16('::ffff:198.51.100.7')).toBe('198.51')
    expect(getSubnet16('2001:db8::1')).toBe('2001:db8::1')
    expect(isRoutableAddress('127.0.0.1')).toBe(false)
  })
})

describe('P2P orphan block pool', () => {
  const TEST_TARGET = '0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

  it('validates PoW and rejects duplicate parent entries', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-orphan-pool-'))
    const node = new Node('miner', undefined, new FileBlockStorage(tmpDir))
    node.chain.difficulty = TEST_TARGET
    node.mine(walletA.address, false)
    const block = node.chain.blocks[1]

    try {
      const pool = new OrphanBlockPool(10, 10_000)
      expect(pool.add({ ...block, hash: 'f'.repeat(64) })).toBe(false)
      expect(pool.add(block, 1_000)).toBe(true)
      expect(pool.add(block, 1_001)).toBe(false)
      expect(pool.size).toBe(1)
      expect(pool.take(block.header.previousHash)?.block.hash).toBe(block.hash)
      expect(pool.size).toBe(0)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('expires stale entries before enforcing the size cap', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-orphan-pool-'))
    const node = new Node('miner', undefined, new FileBlockStorage(tmpDir))
    node.chain.difficulty = TEST_TARGET
    node.mine(walletA.address, false)
    node.mine(walletA.address, false)
    node.mine(walletA.address, false)
    const [, block1, block2, block3] = node.chain.blocks

    try {
      const pool = new OrphanBlockPool(2, 500)
      expect(pool.add(block1, 1_000)).toBe(true)
      expect(pool.add(block2, 1_010)).toBe(true)
      expect(pool.add(block3, 2_000)).toBe(true)
      expect(pool.size).toBe(1)
      expect(pool.take(block1.header.previousHash)).toBeNull()
      expect(pool.take(block2.header.previousHash)).toBeNull()
      expect(pool.take(block3.header.previousHash)?.block.hash).toBe(block3.hash)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('evicts the oldest orphan when full', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-orphan-pool-'))
    const node = new Node('miner', undefined, new FileBlockStorage(tmpDir))
    node.chain.difficulty = TEST_TARGET
    node.mine(walletA.address, false)
    node.mine(walletA.address, false)
    node.mine(walletA.address, false)
    const [, block1, block2, block3] = node.chain.blocks

    try {
      const pool = new OrphanBlockPool(2, 10_000)
      expect(pool.add(block1, 1_000)).toBe(true)
      expect(pool.add(block2, 1_010)).toBe(true)
      expect(pool.add(block3, 1_020)).toBe(true)
      expect(pool.size).toBe(2)
      expect(pool.take(block1.header.previousHash)).toBeNull()
      expect(pool.take(block2.header.previousHash)?.block.hash).toBe(block2.hash)
      expect(pool.take(block3.header.previousHash)?.block.hash).toBe(block3.hash)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describeLoopbackTcp('P2P server integration', () => {
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
    const port = p2p1.getPort()

    p2p2.connectOutbound('127.0.0.1', port)

    await waitFor(() => p2p1.getPeers().length > 0 && p2p2.getPeers().length > 0)

    expect(p2p1.getPeers().length).toBeGreaterThanOrEqual(1)
    expect(p2p2.getPeers().length).toBeGreaterThanOrEqual(1)
  })

  it('should reject peer with wrong protocol version', async () => {
    const port = p2p1.getPort()

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
      socket.on('data', (chunk: Buffer) => chunks.push(chunk))
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
    const port = p2p1.getPort()
    p2p2.connectOutbound('127.0.0.1', port)

    // Wait for node2 to sync
    await waitFor(() => node2.chain.getHeight() >= 3, 15_000)
    expect(node2.chain.getHeight()).toBe(3)
  })

  it('should propagate new blocks between connected peers', async () => {
    const wallet = walletA

    // Connect first
    const port = p2p1.getPort()
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
      const port = sp2p1.getPort()
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

  it('should strip client-supplied confirmations from relayed transactions', async () => {
    const { createMockSnapshot } = await import('../snapshot.js')
    const { createClaimTransaction } = await import('../claim.js')
    const { snapshot, holders } = createMockSnapshot()

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
      const port = sp2p1.getPort()
      sp2p2.connectOutbound('127.0.0.1', port)

      await waitFor(() => sp2p1.getPeers().length > 0 && sp2p2.getPeers().length > 0)

      const genesisHash = sNode2.chain.blocks[0].hash
      const claimTx = createClaimTransaction(
        holders[0].secretKey,
        holders[0].publicKey,
        snapshot.entries[0],
        walletA,
        snapshot.btcBlockHash,
        genesisHash
      )
      const peerOnNode2 = sp2p2.getPeerObjects()[0]
      peerOnNode2.send({
        type: 'tx',
        payload: {
          tx: {
            ...(sanitizeForStorage(claimTx) as Record<string, unknown>),
            confirmations: 123_456,
          },
        },
      })

      await waitFor(() => sNode1.mempool.getTransaction(claimTx.id) !== undefined, 10_000)

      const relayed = sNode1.mempool.getTransaction(claimTx.id) as unknown as Record<string, unknown>
      expect(relayed).toBeDefined()
      expect(relayed.confirmations).toBeUndefined()
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
    const port = p2p1.getPort()
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

    const port = p2p1.getPort()
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
    const port = p2p1.getPort()

    // Use connectToSeeds instead of manual connectOutbound
    p2p2.connectToSeeds([`127.0.0.1:${port}`])

    // Verify outbound connection is established
    await waitFor(() => p2p2.getPeers().length > 0 && p2p1.getPeers().length > 0)

    expect(p2p2.getPeers().length).toBeGreaterThanOrEqual(1)
    expect(p2p1.getPeers().length).toBeGreaterThanOrEqual(1)

    // Verify seeds are stored (accessible via the private field)
    const seeds = p2p2.getSeeds()
    expect(seeds).toHaveLength(1)
    expect(seeds[0].host).toBe('127.0.0.1')
    expect(seeds[0].port).toBe(port)
  })

  it('does not schedule seed reconnects while stopping', async () => {
    const port = p2p1.getPort()
    const connectSpy = vi.spyOn(p2p2, 'connectOutbound')

    p2p2.connectToSeeds([`127.0.0.1:${port}`])
    await waitFor(() => p2p2.getPeers().length > 0 && p2p1.getPeers().length > 0)

    p2p2.getSeedBackoff().set(`127.0.0.1:${port}`, 10)
    expect(connectSpy).toHaveBeenCalledTimes(1)

    await p2p2.stop()
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(connectSpy).toHaveBeenCalledTimes(1)
  })
})

describeLoopbackTcp('P2P fork resolution', () => {
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
    const port = p2p2.getPort()
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
    const port = p2p2.getPort()
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

describeLoopbackTcp('P2P improvements', () => {
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
      const port = sp2p1.getPort()
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
      const port = p2p1.getPort()

      // Open 4 inbound connections from same IP (limit is 3)
      const sockets: net.Socket[] = []
      for (let i = 0; i < 4; i++) {
        const sock = net.createConnection({ host: '127.0.0.1', port })
        sockets.push(sock)
        await new Promise<void>(r => sock.once('connect', r))
      }

      // Wait for all connections to be processed by the server
      await waitFor(() => p2p1.getPeerCount() >= 3, 2_000)
      // Small extra delay for the 4th to be rejected
      await new Promise(r => setTimeout(r, 50))

      // Should have at most 3 inbound peers from same IP
      const inboundCount = p2p1.getInboundCount()
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

describeLoopbackTcp('P2P waitForSync', () => {
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


describeLoopbackTcp('P2P orphan block resolution', () => {
  const TEST_TARGET = '0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

  it('should connect an orphan chain when the missing parent block arrives', async () => {
    const tmpDir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-orphan-1-'))
    const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-orphan-2-'))

    const miner = new Node('miner', undefined, new FileBlockStorage(tmpDir2))
    miner.chain.difficulty = TEST_TARGET
    miner.mine(walletA.address, false)
    miner.mine(walletA.address, false)
    miner.mine(walletA.address, false)
    const [, block1, block2, block3] = miner.chain.blocks

    const receiver = new Node('receiver', undefined, new FileBlockStorage(tmpDir1))
    receiver.chain.difficulty = TEST_TARGET
    const p2p = new P2PServer(receiver, 0, tmpDir1)
    await p2p.start()

    try {
      // Inject block2 and block3 as orphans (their parent is not yet in the chain)
      p2p.addOrphan(block2)
      p2p.addOrphan(block3)
      expect(p2p.getOrphanCount()).toBe(2)

      // Receive block1 — the missing parent
      const result = receiver.receiveBlock(block1)
      expect(result.success).toBe(true)
      expect(receiver.chain.getHeight()).toBe(1)

      // Trigger orphan resolution as handleBlocks would after accepting block1
      const connected = p2p.processOrphans(block1.hash)

      expect(connected).toBe(2)
      expect(receiver.chain.getHeight()).toBe(3)
      expect(p2p.getOrphanCount()).toBe(0)
    } finally {
      await p2p.stop()
      fs.rmSync(tmpDir1, { recursive: true, force: true })
      fs.rmSync(tmpDir2, { recursive: true, force: true })
    }
  })
})
