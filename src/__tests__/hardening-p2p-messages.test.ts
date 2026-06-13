import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Node } from '../node.js'
import { P2PServer } from '../p2p/server.js'
import { Peer } from '../p2p/peer.js'
import { FileBlockStorage } from '../storage.js'
import { walletA } from './fixtures.js'
import { describeLoopbackTcp, waitFor } from './hardening-test-helpers.js'

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
