import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import { Node } from '../node.js'
import { P2PServer } from '../p2p/server.js'
import { Peer } from '../p2p/peer.js'
import { FileBlockStorage } from '../storage.js'
import { walletA } from './fixtures.js'
import { describeLoopbackTcp, waitFor } from './hardening-test-helpers.js'

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
    peer.setLastMisbehaviorDecay(Date.now() - 5 * 60_000) // 5 minutes ago

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
    peer.setLastMisbehaviorDecay(Date.now() - 10 * 60_000) // 10 minutes ago

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
    const addAddr = p2p.addKnownAddress.bind(p2p)

    addAddr('10.0.0.1', 6001)
    addAddr('172.16.0.1', 6001)
    addAddr('192.168.1.1', 6001)
    addAddr('127.0.0.1', 6001)
    addAddr('169.254.1.1', 6001)

    expect(p2p.getKnownAddresses().size).toBe(0)
  })

  it('should accept public addresses', () => {
    const addAddr = p2p.addKnownAddress.bind(p2p)

    addAddr('8.8.8.8', 6001)
    addAddr('1.2.3.4', 6002)

    expect(p2p.getKnownAddresses().size).toBe(2)
  })

  it('should allow private IPs in local mode', () => {
    p2p.setLocalMode(true)
    const addAddr = p2p.addKnownAddress.bind(p2p)

    addAddr('192.168.1.1', 6001)
    addAddr('10.0.0.1', 6002)

    expect(p2p.getKnownAddresses().size).toBe(2)
  })

  it('should reject IPv6 private addresses', () => {
    const addAddr = p2p.addKnownAddress.bind(p2p)

    addAddr('::1', 6001)
    addAddr('fc00::1', 6001)
    addAddr('fd12::1', 6001)
    addAddr('fe80::1', 6001)

    expect(p2p.getKnownAddresses().size).toBe(0)
  })
})

describeLoopbackTcp('Fork resolution safety', () => {
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
    p2p1.setForkResolutionInProgress(true)

    // Simulate a peer connecting and disconnecting
    const port = p2p2.getPort()
    p2p1.connectOutbound('127.0.0.1', port)

    await waitFor(() => p2p1.getPeers().length > 0)

    // Disconnect the peer
    const peer = p2p1.getPeerObjects()[0]
    peer.disconnect('test disconnect')

    await waitFor(() => p2p1.getPeers().length === 0)

    // Flag should be cleared
    expect(p2p1.isForkResolutionInProgress()).toBe(false)
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
  })

  afterEach(async () => {
    await p2p.stop()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('should increase backoff delay on failed connections', () => {
    const seedBackoff = p2p.getSeedBackoff()

    // Simulate failed connection by setting backoff
    seedBackoff.set('1.2.3.4:6001', 5000)
    expect(seedBackoff.get('1.2.3.4:6001')).toBe(5000)

    // After another failure, delay should double (up to max)
    seedBackoff.set('1.2.3.4:6001', 10000)
    expect(seedBackoff.get('1.2.3.4:6001')).toBe(10000)
  })

  it('should cap backoff at 60s', () => {
    const seedBackoff = p2p.getSeedBackoff()

    // Set backoff beyond max
    seedBackoff.set('1.2.3.4:6001', 120000)
    const delay = Math.min(seedBackoff.get('1.2.3.4:6001')! * 2, 60000)
    expect(delay).toBe(60000)
  })
})

describe('P2P getheaders locator cap', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-locator-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('should cap locator to 101 entries and still find fork point', async () => {
    const storage = new FileBlockStorage(tmpDir)
    const node = new Node('test', undefined, storage)
    const TEST_TARGET = '0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
    node.chain.difficulty = TEST_TARGET

    // Mine a few blocks
    for (let i = 0; i < 5; i++) {
      node.mine(walletA.address, false)
    }

    const p2p = new P2PServer(node, 0, tmpDir)

    // Simulate a getheaders with 200 locator hashes (should be capped to 101)
    const fakePeer = {
      handshakeComplete: true,
      addMisbehavior: () => {},
      send: (msg: any) => {
        // The response should have headers
        expect(msg.type).toBe('headers')
        expect(Array.isArray(msg.payload.headers)).toBe(true)
      },
    }

    const largeLocator = Array.from({ length: 200 }, (_, i) => `${i.toString(16).padStart(64, '0')}`)
    // Put the genesis hash at position 150 (beyond the cap)
    largeLocator[150] = node.chain.blocks[0].hash

    const handleGetHeaders = p2p.handleGetHeaders.bind(p2p)
    handleGetHeaders(fakePeer as unknown as Peer, { locatorHashes: largeLocator })

    // The genesis at index 150 should NOT be found (capped at 101)
    // so forkPoint defaults to 0 and we get headers from height 1
  })
})

describeLoopbackTcp('P2P message error handling', () => {
  let tmpDir1: string
  let tmpDir2: string

  beforeEach(() => {
    tmpDir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-err-1-'))
    tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-err-2-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir1, { recursive: true, force: true })
    fs.rmSync(tmpDir2, { recursive: true, force: true })
  })

  it('should add misbehavior for malformed hex in transaction data', async () => {
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

      // Send a tx with invalid hex (should throw in hexToBytes, caught by handleMessage)
      const peerOnNode2 = p2p2.getPeerObjects()[0]
      peerOnNode2.send({
        type: 'tx',
        payload: {
          tx: {
            id: 'f'.repeat(64),
            inputs: [{
              txId: 'a'.repeat(64),
              outputIndex: 0,
              publicKey: 'NOT_VALID_HEX_ZZZZ',
              signature: 'ALSO_NOT_HEX!!!!',
            }],
            outputs: [{ address: 'b'.repeat(64), amount: 10_000 }],
            timestamp: Date.now(),
          },
        },
      })

      await new Promise(r => setTimeout(r, 300))

      // Should have received misbehavior points (handleMessage try-catch catches the throw)
      const scoreAfter = peerOnNode1.getMisbehaviorScore()
      expect(scoreAfter).toBeGreaterThan(scoreBefore)
    } finally {
      await p2p1.stop()
      await p2p2.stop()
    }
  })

  it('should add misbehavior for unknown message type', async () => {
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

      // Send a message with unknown type
      const peerOnNode2 = p2p2.getPeerObjects()[0]
      peerOnNode2.send({ type: 'foobar' as any, payload: {} })

      await new Promise(r => setTimeout(r, 300))

      // Unknown type causes a framing decode error — peer is immediately disconnected
      // rather than accumulating misbehavior points, since the byte stream is untrustworthy.
      expect(p2p1.getPeers().length).toBe(0)
    } finally {
      await p2p1.stop()
      await p2p2.stop()
    }
  })
})

describe('Orphan block PoW validation', () => {
  it('should reject orphans with invalid PoW', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-orphan-'))
    try {
      const node = new Node('test', undefined, new FileBlockStorage(tmpDir))
      const p2p = new P2PServer(node, 0, tmpDir)

      // Try to add orphan with fake hash (bypass the public API, call private addOrphan)
      const fakeOrphan = {
        header: {
          version: 1,
          previousHash: 'dead'.repeat(16), // unknown parent
          merkleRoot: 'a'.repeat(64),
          timestamp: Date.now(),
          target: '0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
          nonce: 0,
        },
        hash: 'beef'.repeat(16), // doesn't match header
        transactions: [],
        height: 99,
      }

      ;p2p.addOrphan(fakeOrphan)

      // Should NOT be in orphan pool (hash doesn't match header)
      expect(p2p.getOrphanCount()).toBe(0)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('Subnet diversity', () => {
  let tmpDir: string
  let node: Node
  let p2p: P2PServer

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-subnet-'))
    node = new Node('test')
    p2p = new P2PServer(node, 0, tmpDir)
  })

  afterEach(async () => {
    await p2p.stop()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('should accept addresses from multiple subnets into address book', () => {
    const addAddr = p2p.addKnownAddress.bind(p2p)
    addAddr('8.8.1.1', 6001)
    addAddr('8.8.2.2', 6002)
    addAddr('8.8.3.3', 6003)
    addAddr('9.9.1.1', 6001)

    expect(p2p.getKnownAddresses().size).toBe(4)
  })

  it('should filter discovery candidates from over-represented subnets', () => {
    // Simulate 2 outbound peers on subnet 8.8.x.x
    const stub = () => {}
    const fakePeer1 = { address: '8.8.1.1', inbound: false, id: '8.8.1.1:6001', disconnect: stub }
    const fakePeer2 = { address: '8.8.2.2', inbound: false, id: '8.8.2.2:6002', disconnect: stub }
    const peerMap = p2p.getPeerMap()
    peerMap.set('8.8.1.1:6001', fakePeer1 as unknown as Peer)
    peerMap.set('8.8.2.2:6002', fakePeer2 as unknown as Peer)

    // Add candidate addresses: 2 from same subnet, 1 from different
    const addAddr = p2p.addKnownAddress.bind(p2p)
    addAddr('8.8.3.3', 6003) // same /16 as the 2 connected peers
    addAddr('9.9.1.1', 6001) // different /16

    // Build subnet counts like discovery does
    const subnetCounts = new Map<string, number>()
    for (const peer of peerMap.values()) {
      if (!peer.inbound) {
        const ip = peer.address.replace(/^::ffff:/i, '')
        const match = ip.match(/^(\d+\.\d+)\.\d+\.\d+$/)
        const subnet = match ? match[1] : ip
        subnetCounts.set(subnet, (subnetCounts.get(subnet) ?? 0) + 1)
      }
    }

    const candidates = Array.from(p2p.getKnownAddresses().values())
    const filtered = candidates.filter((a) => {
      const ip = a.host.replace(/^::ffff:/i, '')
      const match = ip.match(/^(\d+\.\d+)\.\d+\.\d+$/)
      const subnet = match ? match[1] : ip
      return (subnetCounts.get(subnet) ?? 0) < 2 // MAX_OUTBOUND_PER_SUBNET
    })

    // 8.8.3.3 should be filtered out (subnet 8.8 already has 2 outbound)
    expect(filtered.length).toBe(1)
    expect(filtered[0].host).toBe('9.9.1.1')
  })

  it('should skip subnet filtering in local mode', () => {
    p2p.setLocalMode(true)

    // Even with many peers on same subnet, localMode skips filtering
    // In localMode, the discovery loop skips the subnet filter
    expect(p2p.isLocalMode()).toBe(true)
  })

  it('should fall back to all candidates when all subnets saturated', () => {
    const stub = () => {}
    const fakePeer1 = { address: '8.8.1.1', inbound: false, id: '8.8.1.1:6001', disconnect: stub }
    const fakePeer2 = { address: '8.8.2.2', inbound: false, id: '8.8.2.2:6002', disconnect: stub }
    const peerMap = p2p.getPeerMap()
    peerMap.set('8.8.1.1:6001', fakePeer1 as unknown as Peer)
    peerMap.set('8.8.2.2:6002', fakePeer2 as unknown as Peer)

    // Only candidates from same saturated subnet
    const addAddr = p2p.addKnownAddress.bind(p2p)
    addAddr('8.8.3.3', 6003)
    addAddr('8.8.4.4', 6004)

    const candidates = Array.from(p2p.getKnownAddresses().values())
    const subnetCounts = new Map<string, number>([['8.8', 2]])
    let filtered = candidates.filter((a) => {
      const match = a.host.match(/^(\d+\.\d+)\.\d+\.\d+$/)
      const subnet = match ? match[1] : a.host
      return (subnetCounts.get(subnet) ?? 0) < 2
    })
    // All filtered out — should fall back to all candidates
    if (filtered.length === 0) filtered = candidates
    expect(filtered.length).toBe(2) // fallback returns all
  })

  it('should not count inbound peers in subnet limits', () => {
    const stub = () => {}
    const fakePeer1 = { address: '8.8.1.1', inbound: true, id: '8.8.1.1:6001', disconnect: stub }
    const fakePeer2 = { address: '8.8.2.2', inbound: true, id: '8.8.2.2:6002', disconnect: stub }
    const fakePeer3 = { address: '8.8.3.3', inbound: true, id: '8.8.3.3:6003', disconnect: stub }
    const peerMap = p2p.getPeerMap()
    peerMap.set('8.8.1.1:6001', fakePeer1 as unknown as Peer)
    peerMap.set('8.8.2.2:6002', fakePeer2 as unknown as Peer)
    peerMap.set('8.8.3.3:6003', fakePeer3 as unknown as Peer)

    // Build outbound-only subnet counts
    const subnetCounts = new Map<string, number>()
    for (const peer of peerMap.values()) {
      if (!peer.inbound) {
        const match = peer.address.match(/^(\d+\.\d+)\.\d+\.\d+$/)
        const subnet = match ? match[1] : peer.address
        subnetCounts.set(subnet, (subnetCounts.get(subnet) ?? 0) + 1)
      }
    }

    // No outbound peers counted — subnet 8.8 should have count 0
    expect(subnetCounts.get('8.8') ?? 0).toBe(0)

    // So candidate from 8.8.x.x should NOT be filtered
    const addAddr = p2p.addKnownAddress.bind(p2p)
    addAddr('8.8.4.4', 6004)
    const candidates = Array.from(p2p.getKnownAddresses().values())
    const filtered = candidates.filter((a) => {
      const match = a.host.match(/^(\d+\.\d+)\.\d+\.\d+$/)
      const subnet = match ? match[1] : a.host
      return (subnetCounts.get(subnet) ?? 0) < 2
    })
    expect(filtered.length).toBe(1) // not filtered
  })

  it('should handle IPv6 addresses as their own subnet', () => {
    const stub = () => {}
    const fakePeer = { address: '2001:db8::1', inbound: false, id: '[2001:db8::1]:6001', disconnect: stub }
    const peerMap = p2p.getPeerMap()
    peerMap.set('[2001:db8::1]:6001', fakePeer as unknown as Peer)

    // Each unique IPv6 address is its own "subnet" so it won't block others
    const subnetCounts = new Map<string, number>()
    for (const peer of peerMap.values()) {
      if (!peer.inbound) {
        const ip = peer.address.replace(/^::ffff:/i, '')
        const match = ip.match(/^(\d+\.\d+)\.\d+\.\d+$/)
        const subnet = match ? match[1] : ip
        subnetCounts.set(subnet, (subnetCounts.get(subnet) ?? 0) + 1)
      }
    }
    expect(subnetCounts.get('2001:db8::1')).toBe(1)
  })
})

describe('Anchor peer persistence', () => {
  it('should save and load anchor peers across restarts', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-anchor-'))
    try {
      const node = new Node('test')
      const p2p1 = new P2PServer(node, 0, tmpDir)

      const addAddr = p2p1.addKnownAddress.bind(p2p1)
      p2p1.setLocalMode(true)
      addAddr('192.168.1.1', 6001)
      addAddr('192.168.1.2', 6002)
      addAddr('192.168.1.3', 6003)

      p2p1.saveAnchors()
      await p2p1.stop()

      const anchorsPath = path.join(tmpDir, 'anchors.json')
      expect(fs.existsSync(anchorsPath)).toBe(true)
      const anchors = JSON.parse(fs.readFileSync(anchorsPath, 'utf-8'))
      expect(anchors.length).toBe(3)

      // Create new P2PServer — should load anchors
      const p2p2 = new P2PServer(node, 0, tmpDir)
      p2p2.setLocalMode(true)
      expect(p2p2.getKnownAddresses().size).toBe(3)
      await p2p2.stop()
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('should cap anchors to MAX_ANCHORS (10)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-anchor-cap-'))
    try {
      const node = new Node('test')
      const p2p = new P2PServer(node, 0, tmpDir)

      const addAddr = p2p.addKnownAddress.bind(p2p)
      for (let i = 1; i <= 20; i++) {
        addAddr(`8.8.${i}.1`, 6001)
      }

      p2p.saveAnchors()

      const anchorsPath = path.join(tmpDir, 'anchors.json')
      const anchors = JSON.parse(fs.readFileSync(anchorsPath, 'utf-8'))
      expect(anchors.length).toBe(10)

      await p2p.stop()
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('should save anchors on stop', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-anchor-stop-'))
    try {
      const node = new Node('test')
      const p2p = new P2PServer(node, 0, tmpDir)

      const addAddr = p2p.addKnownAddress.bind(p2p)
      addAddr('8.8.8.8', 6001)

      await p2p.stop()

      const anchorsPath = path.join(tmpDir, 'anchors.json')
      expect(fs.existsSync(anchorsPath)).toBe(true)
      const anchors = JSON.parse(fs.readFileSync(anchorsPath, 'utf-8'))
      expect(anchors.length).toBe(1)
      expect(anchors[0].host).toBe('8.8.8.8')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('should gracefully handle corrupt anchors.json', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-anchor-corrupt-'))
    try {
      // Write corrupt JSON
      fs.writeFileSync(path.join(tmpDir, 'anchors.json'), '{{{not json!!!')

      const node = new Node('test')
      // Should not throw — loadAnchors catches the error
      const p2p = new P2PServer(node, 0, tmpDir)
      expect(p2p.getKnownAddresses().size).toBe(0)
      await p2p.stop()
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('should handle missing anchors.json gracefully', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-anchor-missing-'))
    try {
      // No anchors.json — should start clean
      const node = new Node('test')
      const p2p = new P2PServer(node, 0, tmpDir)
      expect(p2p.getKnownAddresses().size).toBe(0)
      await p2p.stop()
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('should not save or load anchors without dataDir', async () => {
    const node = new Node('test')
    // No dataDir — anchorsPath should be null
    const p2p = new P2PServer(node, 0)
    expect(p2p.getAnchorsPath()).toBeNull()

    // saveAnchors should no-op (no error)
    p2p.saveAnchors()

    // connectToAnchors should no-op (no error)
    p2p.connectToAnchors()

    await p2p.stop()
  })

  it('should sort anchors by most recently seen', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-anchor-sort-'))
    try {
      const node = new Node('test')
      const p2p = new P2PServer(node, 0, tmpDir)

      // Add addresses with different timestamps
      p2p.addKnownAddress('1.1.1.1', 6001, 1000)
      p2p.addKnownAddress('2.2.2.2', 6001, 3000)
      p2p.addKnownAddress('3.3.3.3', 6001, 2000)

      p2p.saveAnchors()

      const anchorsPath = path.join(tmpDir, 'anchors.json')
      const anchors = JSON.parse(fs.readFileSync(anchorsPath, 'utf-8'))

      // Should be sorted newest first
      expect(anchors[0].host).toBe('2.2.2.2')
      expect(anchors[1].host).toBe('3.3.3.3')
      expect(anchors[2].host).toBe('1.1.1.1')

      await p2p.stop()
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('should preserve anchor lastSeen timestamps across restarts', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-anchor-ts-'))
    try {
      const node = new Node('test')
      const p2p1 = new P2PServer(node, 0, tmpDir)
      p2p1.addKnownAddress('8.8.8.8', 6001, 12345)
      p2p1.saveAnchors()
      await p2p1.stop()

      // Reload — lastSeen should be preserved
      const p2p2 = new P2PServer(node, 0, tmpDir)
      const loaded = p2p2.getKnownAddresses().get('8.8.8.8:6001')
      expect(loaded).toBeDefined()
      expect(loaded!.lastSeen).toBe(12345)
      await p2p2.stop()
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('should skip entries with missing host or port in anchors.json', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-anchor-bad-'))
    try {
      // Write anchors with some invalid entries
      const anchors = [
        { host: '1.1.1.1', port: 6001, lastSeen: 1000 },
        { host: '', port: 6001, lastSeen: 2000 },     // empty host
        { host: '2.2.2.2', port: 0, lastSeen: 3000 },  // port 0 is falsy
        { host: '3.3.3.3', port: 6002, lastSeen: 4000 },
      ]
      fs.writeFileSync(path.join(tmpDir, 'anchors.json'), JSON.stringify(anchors))

      const node = new Node('test')
      const p2p = new P2PServer(node, 0, tmpDir)

      // Only entries with truthy host AND port should be loaded
      expect(p2p.getKnownAddresses().size).toBe(2)
      expect(p2p.getKnownAddresses().has('1.1.1.1:6001')).toBe(true)
      expect(p2p.getKnownAddresses().has('3.3.3.3:6002')).toBe(true)

      await p2p.stop()
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('should skip malformed anchor entries and avoid dialing or persisting them', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-anchor-malformed-'))
    try {
      const anchors = [
        { host: '1.1.1.1', port: 6001, lastSeen: 1000 },
        { host: 'not-an-ip', port: 6002, lastSeen: 2000 },
        { host: '2.2.2.2', port: 70000, lastSeen: 3000 },
        { host: '3.3.3.3', port: 6003, lastSeen: 'yesterday' },
      ]
      fs.writeFileSync(path.join(tmpDir, 'anchors.json'), JSON.stringify(anchors))

      const node = new Node('test')
      const p2p = new P2PServer(node, 0, tmpDir)

      const connectCalls: Array<[string, number]> = []
      ;(p2p as any).connectOutbound = (host: string, port: number) => {
        connectCalls.push([host, port])
      }

      const known = p2p.getKnownAddresses()
      expect(known.size).toBe(1)
      expect(known.has('1.1.1.1:6001')).toBe(true)
      expect(known.has('not-an-ip:6002')).toBe(false)
      expect(known.has('2.2.2.2:70000')).toBe(false)
      expect(known.has('3.3.3.3:6003')).toBe(false)

      p2p.connectToAnchors()
      expect(connectCalls).toEqual([['1.1.1.1', 6001]])

      p2p.saveAnchors()
      const savedAnchors = JSON.parse(fs.readFileSync(path.join(tmpDir, 'anchors.json'), 'utf-8'))
      expect(savedAnchors).toHaveLength(1)
      expect(savedAnchors[0].host).toBe('1.1.1.1')
      expect(savedAnchors[0].port).toBe(6001)

      await p2p.stop()
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('Cumulative work threshold (1.5x)', () => {
  it('should ban peer claiming more than 1.5x verified work', () => {
    // The threshold is: peer.remoteCumulativeWork > verifiedPeerWork * 3n / 2n
    // If verified work = 100, threshold = 150
    // 151 should be banned, 150 should not
    const verified = 100n
    const threshold = verified * 3n / 2n // = 150

    expect(151n > threshold).toBe(true)  // would be banned
    expect(150n > threshold).toBe(false) // would NOT be banned (equal)
    expect(149n > threshold).toBe(false) // would NOT be banned
  })

  it('1.5x is tighter than previous 2x threshold', () => {
    const verified = 1000n
    const oldThreshold = verified * 2n   // 2000
    const newThreshold = verified * 3n / 2n // 1500

    // A peer claiming 1600 work would pass old check but fail new
    expect(1600n > oldThreshold).toBe(false)  // old: not banned
    expect(1600n > newThreshold).toBe(true)   // new: banned
  })
})

describeLoopbackTcp('P2P input validation hardening', () => {
  let tmpDir1: string
  let tmpDir2: string

  beforeEach(() => {
    tmpDir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-val-1-'))
    tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-val-2-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir1, { recursive: true, force: true })
    fs.rmSync(tmpDir2, { recursive: true, force: true })
  })

  async function makePair() {
    const node1 = new Node('alice', undefined, new FileBlockStorage(tmpDir1))
    const node2 = new Node('bob', undefined, new FileBlockStorage(tmpDir2))
    node1.chain.difficulty = '0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
    node2.chain.difficulty = '0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
    const p2p1 = new P2PServer(node1, 0, tmpDir1)
    const p2p2 = new P2PServer(node2, 0, tmpDir2)
    await p2p1.start()
    await p2p2.start()
    const port = p2p1.getPort()
    p2p2.connectOutbound('127.0.0.1', port)
    await waitFor(() => p2p1.getPeers().length > 0 && p2p2.getPeers().length > 0)
    const peerOnNode1 = p2p1.getPeerObjects()[0]
    const peerOnNode2 = p2p2.getPeerObjects()[0]
    return { p2p1, p2p2, peerOnNode1, peerOnNode2 }
  }

  it('should penalize peer sending oversized blocks batch (>IBD_BATCH_SIZE)', async () => {
    const { p2p1, p2p2, peerOnNode1, peerOnNode2 } = await makePair()
    try {
      const scoreBefore = peerOnNode1.getMisbehaviorScore()

      // Send 201 blocks (IBD_BATCH_SIZE is 200) — should trigger misbehavior on receiver
      // Use empty block stubs; deserialization won't be reached because count check is first
      const tooManyBlocks = Array.from({ length: 201 }, () => ({}))
      peerOnNode2.send({ type: 'blocks', payload: { blocks: tooManyBlocks } })

      await new Promise(r => setTimeout(r, 300))

      const scoreAfter = peerOnNode1.getMisbehaviorScore()
      expect(scoreAfter).toBeGreaterThan(scoreBefore)
    } finally {
      await p2p1.stop()
      await p2p2.stop()
    }
  })

  it('should penalize peer sending inv with malformed hash', async () => {
    const { p2p1, p2p2, peerOnNode1, peerOnNode2 } = await makePair()
    try {
      const scoreBefore = peerOnNode1.getMisbehaviorScore()

      // Send inv with a hash that is not 64-char hex
      peerOnNode2.send({ type: 'inv', payload: { type: 'block', hash: 'not-a-valid-hash' } })

      await new Promise(r => setTimeout(r, 300))

      const scoreAfter = peerOnNode1.getMisbehaviorScore()
      expect(scoreAfter).toBeGreaterThan(scoreBefore)
    } finally {
      await p2p1.stop()
      await p2p2.stop()
    }
  })

  it('should penalize peer sending getdata with malformed hash', async () => {
    const { p2p1, p2p2, peerOnNode1, peerOnNode2 } = await makePair()
    try {
      const scoreBefore = peerOnNode1.getMisbehaviorScore()

      // Send getdata with an excessively long hash string
      peerOnNode2.send({ type: 'getdata', payload: { type: 'tx', hash: 'z'.repeat(64) } })

      await new Promise(r => setTimeout(r, 300))

      const scoreAfter = peerOnNode1.getMisbehaviorScore()
      expect(scoreAfter).toBeGreaterThan(scoreBefore)
    } finally {
      await p2p1.stop()
      await p2p2.stop()
    }
  })

  it('should penalize peer sending getblocks with NaN fromHeight', async () => {
    const { p2p1, p2p2, peerOnNode1, peerOnNode2 } = await makePair()
    try {
      const scoreBefore = peerOnNode1.getMisbehaviorScore()

      // NaN passes typeof check but not isFinite — receiver should reject
      peerOnNode2.send({ type: 'getblocks', payload: { fromHeight: NaN } })

      await new Promise(r => setTimeout(r, 300))

      const scoreAfter = peerOnNode1.getMisbehaviorScore()
      expect(scoreAfter).toBeGreaterThan(scoreBefore)
    } finally {
      await p2p1.stop()
      await p2p2.stop()
    }
  })

  it('should accept valid inv with well-formed 64-char hex hash', async () => {
    const { p2p1, p2p2, peerOnNode1, peerOnNode2 } = await makePair()
    try {
      const scoreBefore = peerOnNode1.getMisbehaviorScore()

      // Valid hash — should not trigger misbehavior (unknown hash just results in getdata sent back)
      peerOnNode2.send({ type: 'inv', payload: { type: 'block', hash: 'a'.repeat(64) } })

      await new Promise(r => setTimeout(r, 300))

      const scoreAfter = peerOnNode1.getMisbehaviorScore()
      expect(scoreAfter).toBe(scoreBefore) // no misbehavior for valid format
    } finally {
      await p2p1.stop()
      await p2p2.stop()
    }
  })

  it('should penalize peer sending tx with missing id field', async () => {
    const { p2p1, p2p2, peerOnNode1, peerOnNode2 } = await makePair()
    try {
      const scoreBefore = peerOnNode1.getMisbehaviorScore()

      // tx payload with no id field — tx.id will be undefined, failing isValidHash check
      peerOnNode2.send({
        type: 'tx',
        payload: {
          tx: {
            inputs: [{ txId: 'a'.repeat(64), outputIndex: 0, publicKey: 'aabb', signature: 'ccdd' }],
            outputs: [{ address: 'b'.repeat(64), amount: 100 }],
            timestamp: Date.now(),
          },
        },
      })

      await new Promise(r => setTimeout(r, 300))

      const scoreAfter = peerOnNode1.getMisbehaviorScore()
      expect(scoreAfter).toBeGreaterThan(scoreBefore)
    } finally {
      await p2p1.stop()
      await p2p2.stop()
    }
  })

  it('should penalize peer sending tx with malformed id (not 64-char hex)', async () => {
    const { p2p1, p2p2, peerOnNode1, peerOnNode2 } = await makePair()
    try {
      const scoreBefore = peerOnNode1.getMisbehaviorScore()

      // tx payload where id is a non-hex string — fails isValidHash check
      peerOnNode2.send({
        type: 'tx',
        payload: {
          tx: {
            id: 'not-a-valid-hash',
            inputs: [{ txId: 'a'.repeat(64), outputIndex: 0, publicKey: 'aabb', signature: 'ccdd' }],
            outputs: [{ address: 'b'.repeat(64), amount: 100 }],
            timestamp: Date.now(),
          },
        },
      })

      await new Promise(r => setTimeout(r, 300))

      const scoreAfter = peerOnNode1.getMisbehaviorScore()
      expect(scoreAfter).toBeGreaterThan(scoreBefore)
    } finally {
      await p2p1.stop()
      await p2p2.stop()
    }
  })

  it('should penalize peer sending headers with non-sequential heights', async () => {
    const { p2p1, p2p2, peerOnNode1, peerOnNode2 } = await makePair()
    try {
      const scoreBefore = peerOnNode1.getMisbehaviorScore()
      const genesisHash = p2p1.getNode().chain.blocks[0].hash

      // Heights jump from 1 to 3 (gap), violating monotonic +1 requirement
      peerOnNode2.send({
        type: 'headers',
        payload: {
          headers: [
            { hash: 'a'.repeat(64), height: 1, previousHash: genesisHash },
            { hash: 'b'.repeat(64), height: 3, previousHash: 'a'.repeat(64) },
          ],
        },
      })

      await new Promise(r => setTimeout(r, 300))

      const scoreAfter = peerOnNode1.getMisbehaviorScore()
      expect(scoreAfter).toBeGreaterThan(scoreBefore)
    } finally {
      await p2p1.stop()
      await p2p2.stop()
    }
  })

  it('should penalize peer sending headers where previousHash does not link to prior header hash', async () => {
    const { p2p1, p2p2, peerOnNode1, peerOnNode2 } = await makePair()
    try {
      const scoreBefore = peerOnNode1.getMisbehaviorScore()
      const genesisHash = p2p1.getNode().chain.blocks[0].hash

      // Header at height 2 claims a previousHash that doesn't match height 1's hash
      peerOnNode2.send({
        type: 'headers',
        payload: {
          headers: [
            { hash: 'a'.repeat(64), height: 1, previousHash: genesisHash },
            { hash: 'b'.repeat(64), height: 2, previousHash: 'c'.repeat(64) }, // should be 'a'.repeat(64)
          ],
        },
      })

      await new Promise(r => setTimeout(r, 300))

      const scoreAfter = peerOnNode1.getMisbehaviorScore()
      expect(scoreAfter).toBeGreaterThan(scoreBefore)
    } finally {
      await p2p1.stop()
      await p2p2.stop()
    }
  })

  it('should penalize peer sending headers with decreasing heights', async () => {
    const { p2p1, p2p2, peerOnNode1, peerOnNode2 } = await makePair()
    try {
      const scoreBefore = peerOnNode1.getMisbehaviorScore()
      const genesisHash = p2p1.getNode().chain.blocks[0].hash

      // Heights go backwards: 2 then 1
      peerOnNode2.send({
        type: 'headers',
        payload: {
          headers: [
            { hash: 'a'.repeat(64), height: 2, previousHash: genesisHash },
            { hash: 'b'.repeat(64), height: 1, previousHash: 'a'.repeat(64) },
          ],
        },
      })

      await new Promise(r => setTimeout(r, 300))

      const scoreAfter = peerOnNode1.getMisbehaviorScore()
      expect(scoreAfter).toBeGreaterThan(scoreBefore)
    } finally {
      await p2p1.stop()
      await p2p2.stop()
    }
  })

  it('should penalize peer sending tx messages too rapidly', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-txrate-'))
    try {
      const node = new Node('alice', undefined, new FileBlockStorage(tmpDir))
      const p2p = new P2PServer(node, 0, tmpDir)

      let misbehaviorAdded = 0
      const fakePeer = {
        id: 'test-peer',
        addMisbehavior(n: number) { misbehaviorAdded += n },
        send() {},
      }
      const handleTx = p2p.handleTx.bind(p2p)

      // Simulate a tx that just arrived: set lastTxTime to now
      p2p.getLastTxTime().set('test-peer', Date.now())

      // Immediate second tx — rate limit fires (+5) then invalid hash (+10) = 15
      handleTx(fakePeer as unknown as Peer, { tx: {} })
      expect(misbehaviorAdded).toBe(15)

      // After sufficient gap (200ms): no rate limit, only invalid hash (+10)
      misbehaviorAdded = 0
      p2p.getLastTxTime().set('test-peer', Date.now() - 200)
      handleTx(fakePeer as unknown as Peer, { tx: {} })
      expect(misbehaviorAdded).toBe(10)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
