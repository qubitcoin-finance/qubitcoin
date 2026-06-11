import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import { Node } from '../node.js'
import { P2PServer } from '../p2p/server.js'
import { FileBlockStorage } from '../storage.js'
import { walletA } from './fixtures.js'
import { probeLoopbackTcpListen } from './network-test-utils.js'
import { encodeMessage, PROTOCOL_VERSION } from '../p2p/protocol.js'

const LOOPBACK_TCP_SUPPORTED = await probeLoopbackTcpListen()
const describeLoopbackTcp = LOOPBACK_TCP_SUPPORTED ? describe : describe.skip

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

describeLoopbackTcp('P2P security hardening', () => {
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
      const port = p2p1.getPort()
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
      const peerOnNode1 = p2p1.getPeerObjects()[0]
      const scoreBefore = peerOnNode1.getMisbehaviorScore()

      // Get node2's peer (sends TO node1) and send the invalid block
      const peerOnNode2 = p2p2.getPeerObjects()[0]
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
      const port = p2p1.getPort()
      p2p2.connectOutbound('127.0.0.1', port)
      await waitFor(() => p2p1.getPeers().length > 0 && p2p2.getPeers().length > 0)

      const peerOnNode1 = p2p1.getPeerObjects()[0]
      const scoreBefore = peerOnNode1.getMisbehaviorScore()

      // Send an invalid tx FROM node2 TO node1
      const invalidTx = {
        id: 'c'.repeat(64),
        inputs: [{ txId: 'd'.repeat(64), outputIndex: 0, publicKey: '', signature: '' }],
        outputs: [{ address: 'e'.repeat(64), amount: 100 }],
        timestamp: Date.now(),
      }
      const peerOnNode2 = p2p2.getPeerObjects()[0]
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

  it('should penalize oversized addr messages and cap entries', { timeout: 15_000 }, async () => {
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
      const port = p2p1.getPort()
      p2p2.connectOutbound('127.0.0.1', port)
      await waitFor(() => p2p1.getPeers().length > 0 && p2p2.getPeers().length > 0)

      const peerOnNode1 = p2p1.getPeerObjects()[0]

      // Reset rate limit state so the handshake addr exchange doesn't block our test message
      peerOnNode1.lastAddrReceived = 0

      // Send oversized addr FROM node2 TO node1 (200 entries, limit is 100)
      const addresses = Array.from({ length: 200 }, (_, i) => ({
        host: `10.0.${Math.floor(i / 256)}.${i % 256}`,
        port: 6001,
        lastSeen: Date.now(),
      }))
      const peerOnNode2 = p2p2.getPeerObjects()[0]
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
      const port = p2p1.getPort()
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

      const peerOnNode1 = p2p1.getPeerObjects()[0]
      const peerOnNode2 = p2p2.getPeerObjects()[0]

      // Send first time
      peerOnNode2.send({
        type: 'blocks',
        payload: { blocks: [invalidBlock] },
      })
      await new Promise(r => setTimeout(r, 300))
      const scoreAfterFirst = peerOnNode1.getMisbehaviorScore()
      expect(scoreAfterFirst).toBeGreaterThan(0) // should have gotten +25

      // Verify the rejected cache has the hash
      expect(p2p1.isBlockRejected('b'.repeat(64))).toBe(true)

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
      const port = p2p1.getPort()

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
      const port = p2p1.getPort()
      p2p2.connectOutbound('127.0.0.1', port)
      await waitFor(() => p2p1.getPeers().length > 0 && p2p2.getPeers().length > 0)

      // Send already-known blocks from node2 to node1 (simulating duplicate connection IBD)
      const peerOnNode2 = p2p2.getPeerObjects()[0]
      peerOnNode2.send({
        type: 'blocks',
        payload: { blocks: [node1.chain.blocks[1], node1.chain.blocks[2]] },
      })

      await new Promise(r => setTimeout(r, 300))

      // Peer should NOT be disconnected or penalized
      const peerOnNode1 = p2p1.getPeerObjects()[0]
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
    const addAddr = p2p.addKnownAddress.bind(p2p)

    // Add an address with a far-future timestamp
    const farFuture = Date.now() + 365 * 24 * 3600_000 // 1 year in the future
    addAddr('10.0.0.1', 6001, farFuture)

    const known = p2p.getKnownAddresses()
    const entry = known.get('10.0.0.1:6001')
    expect(entry).toBeDefined()
    // Should be clamped to at most ~2 hours in the future
    expect(entry!.lastSeen).toBeLessThan(Date.now() + 3 * 3600_000)
  })

  it('should skip null/non-object entries in addr messages without crashing', async () => {
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
      const port = p2p1.getPort()
      p2p2.connectOutbound('127.0.0.1', port)
      await waitFor(() => p2p1.getPeers().length > 0 && p2p2.getPeers().length > 0)

      const peerOnNode1 = p2p1.getPeerObjects()[0]
      const peerOnNode2 = p2p2.getPeerObjects()[0]

      // Reset rate limit state so the handshake addr exchange doesn't block our test message
      peerOnNode1.lastAddrReceived = 0

      // Send addr message mixing null entries with valid ones
      peerOnNode2.send({
        type: 'addr',
        payload: {
          addresses: [
            null,
            { host: '10.0.0.1', port: 6001, lastSeen: Date.now() },
            undefined,
            { host: '10.0.0.2', port: 6002, lastSeen: Date.now() },
            42,
          ] as any,
        },
      })

      await new Promise(r => setTimeout(r, 300))

      // Server must not crash — both nodes still connected
      expect(p2p1.getPeers().length).toBeGreaterThanOrEqual(1)
      expect(p2p2.getPeers().length).toBeGreaterThanOrEqual(1)

      // Valid entries (10.0.0.1:6001 and 10.0.0.2:6002) should be in the address book
      const known = p2p1.getKnownAddresses()
      expect(known.has('10.0.0.1:6001')).toBe(true)
      expect(known.has('10.0.0.2:6002')).toBe(true)

      // Peer should not have been penalized for the null entries alone
      expect(peerOnNode1.getMisbehaviorScore()).toBe(0)
    } finally {
      await p2p1.stop()
      await p2p2.stop()
    }
  })

  it('should reject non-IP hostnames in addr messages', async () => {
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
      const port = p2p1.getPort()
      p2p2.connectOutbound('127.0.0.1', port)
      await waitFor(() => p2p1.getPeers().length > 0 && p2p2.getPeers().length > 0)

      const peerOnNode1 = p2p1.getPeerObjects()[0]
      const peerOnNode2 = p2p2.getPeerObjects()[0]

      peerOnNode1.lastAddrReceived = 0

      peerOnNode2.send({
        type: 'addr',
        payload: {
          addresses: [
            { host: 'notanip', port: 6001, lastSeen: Date.now() },
            { host: '../../../etc/passwd', port: 6001, lastSeen: Date.now() },
            { host: 'example.com', port: 6001, lastSeen: Date.now() },
            { host: '999.999.999.999', port: 6001, lastSeen: Date.now() },
            { host: '10.0.0.5', port: 6001, lastSeen: Date.now() }, // valid IPv4
            { host: '::1', port: 6001, lastSeen: Date.now() },        // valid IPv6 loopback
          ] as any,
        },
      })

      await new Promise(r => setTimeout(r, 300))

      const known = p2p1.getKnownAddresses()
      // Invalid hostnames must not be stored
      expect(known.has('notanip:6001')).toBe(false)
      expect(known.has('../../../etc/passwd:6001')).toBe(false)
      expect(known.has('example.com:6001')).toBe(false)
      expect(known.has('999.999.999.999:6001')).toBe(false)
      // Valid IPs pass format check (routing check may still exclude them in localMode)
      expect(known.has('10.0.0.5:6001')).toBe(true)
      expect(peerOnNode1.getMisbehaviorScore()).toBeGreaterThanOrEqual(5)
    } finally {
      await p2p1.stop()
      await p2p2.stop()
    }
  })

  it('should penalize malformed addr sub-entries while keeping valid ones', async () => {
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
      const port = p2p1.getPort()
      p2p2.connectOutbound('127.0.0.1', port)
      await waitFor(() => p2p1.getPeers().length > 0 && p2p2.getPeers().length > 0)

      const peerOnNode1 = p2p1.getPeerObjects()[0]
      const peerOnNode2 = p2p2.getPeerObjects()[0]

      peerOnNode1.lastAddrReceived = 0

      peerOnNode2.send({
        type: 'addr',
        payload: {
          addresses: [
            { host: 'not-an-ip', port: 6001, lastSeen: Date.now() },
            { host: '10.0.0.7', port: 70000, lastSeen: Date.now() },
            { host: '10.0.0.8', port: 6008, lastSeen: 'yesterday' },
            { host: '10.0.0.9', port: 6009, lastSeen: Date.now() },
          ] as any,
        },
      })

      await new Promise(r => setTimeout(r, 300))

      const known = p2p1.getKnownAddresses()
      expect(known.has('10.0.0.9:6009')).toBe(true)
      expect(known.has('10.0.0.7:70000')).toBe(false)
      expect(known.has('10.0.0.8:6008')).toBe(false)
      expect(peerOnNode1.getMisbehaviorScore()).toBeGreaterThanOrEqual(5)
    } finally {
      await p2p1.stop()
      await p2p2.stop()
    }
  })

  it('should skip null entries in blocks messages and continue processing valid blocks', async () => {
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
      // Mine a block on node2
      node2.mine(walletA.address, false)
      expect(node2.chain.getHeight()).toBe(1)

      const port = p2p1.getPort()
      p2p2.connectOutbound('127.0.0.1', port)
      await waitFor(() => p2p1.getPeers().length > 0 && p2p2.getPeers().length > 0)

      const peerOnNode2 = p2p2.getPeerObjects()[0]

      // Send blocks message with a null entry mixed in before a valid block
      peerOnNode2.send({
        type: 'blocks',
        payload: {
          blocks: [null, node2.chain.blocks[1]] as any,
        },
      })

      await new Promise(r => setTimeout(r, 500))

      // Server should not crash — nodes still connected
      expect(p2p1.getPeers().length).toBeGreaterThanOrEqual(1)
      // The valid block should have been accepted despite the preceding null entry
      expect(node1.chain.getHeight()).toBe(1)
    } finally {
      await p2p1.stop()
      await p2p2.stop()
    }
  })

  it('should continue processing valid blocks after a malformed block in the batch', async () => {
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
      // Mine two blocks on node2
      node2.mine(walletA.address, false)
      node2.mine(walletA.address, false)
      expect(node2.chain.getHeight()).toBe(2)

      const port = p2p1.getPort()
      p2p2.connectOutbound('127.0.0.1', port)
      await waitFor(() => p2p1.getPeers().length > 0 && p2p2.getPeers().length > 0)

      const peerOnNode2 = p2p2.getPeerObjects()[0]

      // Send a batch with: valid block 1, then a malformed object (missing required fields),
      // then valid block 2. Without per-block error isolation the exception from block 2
      // deserialization would abort the loop and block 2 would never be processed.
      peerOnNode2.send({
        type: 'blocks',
        payload: {
          blocks: [
            node2.chain.blocks[1],
            { notABlock: true, garbage: 'data' },
            node2.chain.blocks[2],
          ] as any,
        },
      })

      await new Promise(r => setTimeout(r, 500))

      // Both nodes still connected
      expect(p2p1.getPeers().length).toBeGreaterThanOrEqual(1)
      // Both valid blocks should have been accepted
      expect(node1.chain.getHeight()).toBe(2)
    } finally {
      await p2p1.stop()
      await p2p2.stop()
    }
  })

  it('should penalize non-handshake message sent before handshake completes', async () => {
    const storage1 = new FileBlockStorage(tmpDir1)
    const node1 = new Node('alice', undefined, storage1)
    const p2p1 = new P2PServer(node1, 0, tmpDir1)
    await p2p1.start()

    try {
      const port = p2p1.getPort()

      // Connect a raw socket without completing the handshake
      const socket = net.createConnection({ host: '127.0.0.1', port })
      await new Promise<void>(r => socket.once('connect', r))

      // Wait for the server to register the inbound peer
      await waitFor(() => p2p1.getPeerCount() >= 1, 2_000)

      const peerOnNode1 = p2p1.getPeerObjects()[0]
      expect(peerOnNode1.handshakeComplete).toBe(false)
      const scoreBefore = peerOnNode1.getMisbehaviorScore()

      // Send a non-handshake message before completing version/verack
      const blocksMsg = encodeMessage({ type: 'getblocks', payload: { fromHeight: 0 } })
      socket.write(blocksMsg)

      await new Promise(r => setTimeout(r, 200))

      // Server should have penalized the peer for the pre-handshake message
      const scoreAfter = peerOnNode1.getMisbehaviorScore()
      expect(scoreAfter).toBeGreaterThan(scoreBefore)

      socket.destroy()
    } finally {
      await p2p1.stop()
    }
  })

  it('should penalize rapid addr messages (rate limiting)', async () => {
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
      const port = p2p1.getPort()
      p2p2.connectOutbound('127.0.0.1', port)
      await waitFor(() => p2p1.getPeers().length > 0 && p2p2.getPeers().length > 0)

      const peerOnNode1 = p2p1.getPeerObjects()[0]
      const peerOnNode2 = p2p2.getPeerObjects()[0]

      // Reset rate limit to allow first addr through
      peerOnNode1.lastAddrReceived = 0

      // First addr message — should be accepted, sets lastAddrReceived
      peerOnNode2.send({
        type: 'addr',
        payload: { addresses: [{ host: '10.0.0.1', port: 6001, lastSeen: Date.now() }] },
      })
      await new Promise(r => setTimeout(r, 100))

      const scoreAfterFirst = peerOnNode1.getMisbehaviorScore()

      // Second addr message within 30s — should trigger rate limit penalty
      peerOnNode2.send({
        type: 'addr',
        payload: { addresses: [{ host: '10.0.0.2', port: 6001, lastSeen: Date.now() }] },
      })
      await new Promise(r => setTimeout(r, 200))

      const scoreAfterSecond = peerOnNode1.getMisbehaviorScore()
      expect(scoreAfterSecond).toBeGreaterThan(scoreAfterFirst)
    } finally {
      await p2p1.stop()
      await p2p2.stop()
    }
  })

  it('should penalize rapid getheaders messages (rate limiting)', async () => {
    const storage1 = new FileBlockStorage(tmpDir1)
    const storage2 = new FileBlockStorage(tmpDir2)
    const node1 = new Node('alice', undefined, storage1)
    const node2 = new Node('bob', undefined, storage2)

    const p2p1 = new P2PServer(node1, 0, tmpDir1)
    const p2p2 = new P2PServer(node2, 0, tmpDir2)
    await p2p1.start()
    await p2p2.start()

    try {
      const port = p2p1.getPort()
      p2p2.connectOutbound('127.0.0.1', port)
      await waitFor(() => p2p1.getPeers().length > 0 && p2p2.getPeers().length > 0)

      const peerOnNode1 = p2p1.getPeerObjects()[0]
      const peerOnNode2 = p2p2.getPeerObjects()[0]

      const genesisHash = node1.chain.blocks[0].hash
      const scoreBefore = peerOnNode1.getMisbehaviorScore()

      // Send two getheaders in rapid succession (within 500ms window)
      peerOnNode2.send({ type: 'getheaders', payload: { locatorHashes: [genesisHash] } })
      peerOnNode2.send({ type: 'getheaders', payload: { locatorHashes: [genesisHash] } })

      await new Promise(r => setTimeout(r, 300))

      // Second rapid getheaders should have added misbehavior
      const scoreAfter = peerOnNode1.getMisbehaviorScore()
      expect(scoreAfter).toBeGreaterThan(scoreBefore)
    } finally {
      await p2p1.stop()
      await p2p2.stop()
    }
  })

  it('should disconnect peer that sends malformed (garbage) bytes', async () => {
    const storage1 = new FileBlockStorage(tmpDir1)
    const node1 = new Node('alice', undefined, storage1)
    const p2p1 = new P2PServer(node1, 0, tmpDir1)
    await p2p1.start()

    try {
      const port = p2p1.getPort()

      const socket = net.createConnection({ host: '127.0.0.1', port })
      await new Promise<void>(r => socket.once('connect', r))

      // Send 4 bytes whose length prefix exceeds MAX_MESSAGE_SIZE (5 MB).
      // decodeMessages throws "Message size exceeds max" and the peer disconnects.
      const garbage = Buffer.alloc(4)
      garbage.writeUInt32BE(5_242_881, 0) // MAX_MESSAGE_SIZE + 1
      socket.write(garbage)

      // Connection should close because the peer disconnects on framing error
      await new Promise<void>((resolve, reject) => {
        socket.once('close', resolve)
        setTimeout(() => reject(new Error('socket did not close within 3s')), 3_000)
      })

      // After disconnect the server should have removed the peer
      await new Promise(r => setTimeout(r, 100))
      expect(p2p1.getPeers().length).toBe(0)
    } finally {
      await p2p1.stop()
    }
  })

  it('should disconnect peer that sends a framed tx message with primitive payload', async () => {
    const storage1 = new FileBlockStorage(tmpDir1)
    const node1 = new Node('alice', undefined, storage1)
    const p2p1 = new P2PServer(node1, 0, tmpDir1)
    await p2p1.start()

    try {
      const port = p2p1.getPort()

      const socket = net.createConnection({ host: '127.0.0.1', port })
      await new Promise<void>(r => socket.once('connect', r))

      socket.write(encodeMessage({ type: 'tx', payload: 'not-an-object' }))

      await new Promise<void>((resolve, reject) => {
        socket.once('close', resolve)
        setTimeout(() => reject(new Error('socket did not close within 3s')), 3_000)
      })

      await new Promise(r => setTimeout(r, 100))
      expect(p2p1.getPeerCount()).toBe(0)
    } finally {
      await p2p1.stop()
    }
  })

  it('should penalize invalid cumulativeWork in version message', async () => {
    const storage1 = new FileBlockStorage(tmpDir1)
    const node1 = new Node('alice', undefined, storage1)
    const p2p1 = new P2PServer(node1, 0, tmpDir1)
    await p2p1.start()

    try {
      const port = p2p1.getPort()

      const socket = net.createConnection({ host: '127.0.0.1', port })
      await new Promise<void>(r => socket.once('connect', r))

      // Send version message with invalid cumulativeWork (not valid hex)
      const versionMsg = encodeMessage({
        type: 'version',
        payload: {
          version: PROTOCOL_VERSION,
          height: 0,
          genesisHash: node1.chain.blocks[0].hash,
          userAgent: 'bad-node',
          cumulativeWork: 'not-valid-hex!!!',
        },
      })
      socket.write(versionMsg)

      await new Promise(r => setTimeout(r, 300))

      // Peer should have received misbehavior for the bad cumulativeWork
      // (connection may still be open since +10 is below the disconnect threshold)
      await waitFor(() => p2p1.getPeerCount() >= 1, 2_000)
      const peerOnNode1 = p2p1.getPeerObjects()[0]
      expect(peerOnNode1.getMisbehaviorScore()).toBeGreaterThan(0)

      socket.destroy()
    } finally {
      await p2p1.stop()
    }
  })
})
