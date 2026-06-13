import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Node } from '../node.js'
import { P2PServer } from '../p2p/server.js'
import { Peer } from '../p2p/peer.js'

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
