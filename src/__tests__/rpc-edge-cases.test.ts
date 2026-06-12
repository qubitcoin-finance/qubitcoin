import { it, expect, afterEach, beforeEach } from 'vitest'
import { Node } from '../node.js'
import { startRpcServer } from '../rpc.js'
import { walletA, walletB } from './fixtures.js'
import { createMockSnapshot } from '../snapshot.js'
import { createClaimTransaction } from '../claim.js'
import { createTransaction } from '../transaction.js'
import { sanitizeForStorage } from '../storage.js'
import { TEST_TARGET, describeLoopbackTcp, listenOnLoopback, startRpcTestServer } from './rpc-test-helpers.js'
import type { Server } from 'node:http'

describeLoopbackTcp('RPC edge cases', () => {
  let node: Node
  let server: Server
  let baseUrl: string

  beforeEach(async () => {
    node = new Node('rpc-edge-test')
    node.chain.difficulty = '0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

    for (let i = 0; i < 3; i++) {
      node.mine(walletA.address, false)
    }

    ({ server, baseUrl } = await startRpcTestServer(node))
  })

  afterEach(() => {
    server.close()
  })

  // GET /blocks edge cases
  it('GET /blocks?count=0 returns empty array', async () => {
    const res = await fetch(`${baseUrl}/api/v1/blocks?count=0`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBe(0)
  })

  it('GET /blocks?count=-1 returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/v1/blocks?count=-1`)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Invalid count parameter')
  })

  it('GET /blocks?count=200 caps at 100', async () => {
    // Mine additional blocks to go over 100 total (start from 4, need ~100 more)
    const extraNode = new Node('rpc-cap-test')
    // Reset difficulty before each mine to prevent the every-10-block adjustment
    // from ratcheting the target to infeasible levels when blocks have ~0ms timestamps.
    const EASY_TARGET = '0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
    for (let i = 0; i < 105; i++) {
      extraNode.chain.difficulty = EASY_TARGET
      extraNode.mine(walletA.address, false)
    }
    const extraApp = startRpcServer(extraNode, 0)
    const extraServer = extraApp.listen(0, '127.0.0.1')
    const extraAddr = await listenOnLoopback(extraServer)
    const extraUrl = `http://127.0.0.1:${extraAddr.port}`

    const res = await fetch(`${extraUrl}/api/v1/blocks?count=200`)
    extraServer.close()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBe(100)
  })

  it('GET /blocks without count defaults to 10', async () => {
    const res = await fetch(`${baseUrl}/api/v1/blocks`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
    // 3 mined + 1 genesis = 4 blocks total, all returned when default (10) > chain length
    expect(body.length).toBe(4)
  })

  // GET /block-by-height edge cases
  it('GET /block-by-height/-1 returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/v1/block-by-height/-1`)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('non-negative integer')
  })

  it('GET /block-by-height/0 returns genesis block', async () => {
    const res = await fetch(`${baseUrl}/api/v1/block-by-height/0`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.height).toBe(0)
  })

  it('GET /block-by-height/1abc returns 400 (not block 1)', async () => {
    // parseInt("1abc", 10) === 1, so without the regex guard this would
    // silently return block 1 instead of rejecting the malformed request.
    const res = await fetch(`${baseUrl}/api/v1/block-by-height/1abc`)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('non-negative integer')
  })

  it('GET /block-by-height/:height beyond chain length returns 404', async () => {
    const beyondTip = node.chain.blocks.length
    const res = await fetch(`${baseUrl}/api/v1/block-by-height/${beyondTip}`)
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toContain('not found')
  })

  it('GET /block-by-height/:height rejects values exceeding INT32 max', async () => {
    const res = await fetch(`${baseUrl}/api/v1/block-by-height/2147483648`)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('too large')
  })

  it('GET /blocks?count=100abc returns 400 (not 100 blocks)', async () => {
    // parseInt("100abc", 10) === 100, so without the regex guard this would
    // silently use 100 instead of rejecting the malformed parameter.
    const res = await fetch(`${baseUrl}/api/v1/blocks?count=100abc`)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Invalid count parameter')
  })

  // GET /mempool/txs limit edge cases
  it('GET /mempool/txs?limit=0 returns empty array', async () => {
    const { snapshot } = createMockSnapshot()
    const limitNode = new Node('rpc-limit-test', snapshot)
    limitNode.chain.difficulty = '0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
    limitNode.mine(walletA.address, false)
    // Add a claim tx to mempool
    const { holders } = createMockSnapshot()
    const genesisHash = limitNode.chain.blocks[0].hash
    const claimTx = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      walletB,
      snapshot.btcBlockHash,
      genesisHash
    )
    limitNode.receiveTransaction(claimTx)

    const limitApp = startRpcServer(limitNode, 0)
    const limitServer = limitApp.listen(0, '127.0.0.1')
    const limitAddr = await listenOnLoopback(limitServer)
    const limitUrl = `http://127.0.0.1:${limitAddr.port}`

    const res = await fetch(`${limitUrl}/api/v1/mempool/txs?limit=0`)
    limitServer.close()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBe(0)
  })

  it('GET /mempool/txs?limit=2000 caps at 1000', async () => {
    const res = await fetch(`${baseUrl}/api/v1/mempool/txs?limit=2000`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
    // mempool is empty so 0 results, but we can verify no crash
    expect(body.length).toBe(0)
  })

  it('GET /mempool/txs?limit=abc returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/v1/mempool/txs?limit=abc`)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Invalid limit parameter')
  })

  it('GET /mempool/txs?limit=-1 returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/v1/mempool/txs?limit=-1`)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Invalid limit parameter')
  })

  it('GET /mempool/txs?limit=100abc returns 400 (not 100 results)', async () => {
    // parseInt("100abc", 10) === 100 — without regex guard this would silently use 100
    const res = await fetch(`${baseUrl}/api/v1/mempool/txs?limit=100abc`)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Invalid limit parameter')
  })

  // POST /tx edge cases
  it('POST /tx with valid-structure transaction but non-existent UTXOs returns 400', async () => {
    // Build a transaction spending a UTXO that does not exist in the chain
    const fakeTx = createTransaction(
      walletA,
      [{ txId: 'dead'.repeat(16), outputIndex: 0, address: walletA.address, amount: 1_000_000 }],
      [{ address: walletB.address, amount: 900_000 }],
      100_000
    )
    const body = sanitizeForStorage(fakeTx)

    const res = await fetch(`${baseUrl}/api/v1/tx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(typeof json.error).toBe('string')
  })

  it('POST /tx with non-object body returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify('not-an-object'),
    })
    expect(res.status).toBe(400)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = await res.json()
    expect(body.error).toBe('Transaction must be an object')
  })

  it('POST /tx with null body returns 400 JSON error payload', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'null',
    })
    expect(res.status).toBe(400)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = await res.json()
    expect(body.error).toBe('Transaction must be an object')
  })

  it('POST /tx with array body returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([]),
    })
    expect(res.status).toBe(400)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = await res.json()
    expect(body.error).toBe('Transaction must be an object')
  })

  it('POST /tx with numeric body returns 400 JSON error payload', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '123',
    })
    expect(res.status).toBe(400)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = await res.json()
    expect(body.error).toBe('Transaction must be an object')
  })

  it('POST /tx with boolean body returns 400 JSON error payload', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'true',
    })
    expect(res.status).toBe(400)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = await res.json()
    expect(body.error).toBe('Transaction must be an object')
  })

  it('POST /tx with malformed JSON returns JSON error payload', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    })
    expect(res.status).toBe(400)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = await res.json()
    expect(body.error).toBe('Malformed JSON request body')
  })

  it('POST /tx with oversized JSON body returns 413 JSON error payload', async () => {
    const largeBody = `"${'a'.repeat(1_100_000)}"`
    const res = await fetch(`${baseUrl}/api/v1/tx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: largeBody,
    })
    expect(res.status).toBe(413)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = await res.json()
    expect(body.error).toBe('Request body too large')
  })

  it('GET unknown /api/v1 route returns JSON 404 payload', async () => {
    const res = await fetch(`${baseUrl}/api/v1/does-not-exist`)
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = await res.json()
    expect(body.error).toBe('RPC endpoint not found')
  })

  it('GET unknown non-API route returns JSON 404 payload', async () => {
    const res = await fetch(`${baseUrl}/does-not-exist`)
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = await res.json()
    expect(body.error).toBe('Route not found')
  })

  it('POST to GET-only RPC route returns JSON 404 payload', async () => {
    const res = await fetch(`${baseUrl}/api/v1/status`, {
      method: 'POST',
    })
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = await res.json()
    expect(body.error).toBe('RPC endpoint not found')
  })
})

describeLoopbackTcp('RPC /difficulty endpoint edge cases', () => {
  it('genesis-only chain returns exactly one entry', async () => {
    const node = new Node('rpc-diff-genesis')
    const app = startRpcServer(node, 0)
    const srv = app.listen(0, '127.0.0.1')
    const addr = await listenOnLoopback(srv)
    const url = `http://127.0.0.1:${addr.port}`
    try {
      const res = await fetch(`${url}/api/v1/difficulty`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(Array.isArray(body)).toBe(true)
      expect(body.length).toBe(1)
      expect(body[0].height).toBe(0)
    } finally {
      srv.close()
    }
  })

  it('chain at exact adjustment boundary does not duplicate the tip', async () => {
    const { DIFFICULTY_ADJUSTMENT_INTERVAL } = await import('../block.js')
    const node = new Node('rpc-diff-boundary')
    node.chain.difficulty = TEST_TARGET
    for (let i = 0; i < DIFFICULTY_ADJUSTMENT_INTERVAL; i++) {
      node.mine('f'.repeat(64), false)
    }
    expect(node.chain.getHeight()).toBe(DIFFICULTY_ADJUSTMENT_INTERVAL)

    const app = startRpcServer(node, 0)
    const srv = app.listen(0, '127.0.0.1')
    const addr = await listenOnLoopback(srv)
    const url = `http://127.0.0.1:${addr.port}`
    try {
      const res = await fetch(`${url}/api/v1/difficulty`)
      expect(res.status).toBe(200)
      const body = await res.json()
      const heights: number[] = body.map((e: { height: number }) => e.height)
      // genesis (0) + adjustment block (DIFFICULTY_ADJUSTMENT_INTERVAL); tip must not be duplicated
      expect(heights.filter(h => h === DIFFICULTY_ADJUSTMENT_INTERVAL).length).toBe(1)
    } finally {
      srv.close()
    }
  })

  it('chain past adjustment boundary includes genesis, adjustment point, and tip', async () => {
    const { DIFFICULTY_ADJUSTMENT_INTERVAL } = await import('../block.js')
    const node = new Node('rpc-diff-past-boundary')
    node.chain.difficulty = TEST_TARGET
    for (let i = 0; i <= DIFFICULTY_ADJUSTMENT_INTERVAL; i++) {
      node.chain.difficulty = TEST_TARGET
      node.mine('f'.repeat(64), false)
    }
    const tipHeight = node.chain.getHeight()
    expect(tipHeight).toBe(DIFFICULTY_ADJUSTMENT_INTERVAL + 1)

    const app = startRpcServer(node, 0)
    const srv = app.listen(0, '127.0.0.1')
    const addr = await listenOnLoopback(srv)
    const url = `http://127.0.0.1:${addr.port}`
    try {
      const res = await fetch(`${url}/api/v1/difficulty`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(Array.isArray(body)).toBe(true)
      const heights: number[] = body.map((e: { height: number }) => e.height)
      expect(heights[0]).toBe(0) // genesis
      expect(heights).toContain(DIFFICULTY_ADJUSTMENT_INTERVAL) // adjustment point
      expect(heights[heights.length - 1]).toBe(tipHeight) // current tip
    } finally {
      srv.close()
    }
  })
})
