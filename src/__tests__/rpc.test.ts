import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { Node } from '../node.js'
import { startRpcServer } from '../rpc.js'
import { walletA, walletB } from './fixtures.js'
import { createMockSnapshot } from '../snapshot.js'
import { createClaimTransaction } from '../claim.js'
import { createTransaction } from '../transaction.js'
import { sanitizeForStorage } from '../storage.js'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

const TEST_TARGET = '0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

describe('RPC endpoints', () => {
  let node: Node
  let server: Server
  let baseUrl: string

  beforeAll(() => {
    node = new Node('rpc-test')
    node.chain.difficulty = TEST_TARGET

    // Mine 3 blocks so we have data to query
    for (let i = 0; i < 3; i++) {
      node.mine(walletA.address, false)
    }

    const app = startRpcServer(node, 0)
    server = app.listen(0)
    const addr = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterAll(() => {
    server.close()
  })

  it('GET /block/:hash returns block by hash', async () => {
    const genesisHash = node.chain.blocks[0].hash
    const res = await fetch(`${baseUrl}/api/v1/block/${genesisHash}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.hash).toBe(genesisHash)
    expect(body.height).toBe(0)
  })

  it('GET /block/:hash returns 404 for unknown hash', async () => {
    const res = await fetch(`${baseUrl}/api/v1/block/${'f'.repeat(64)}`)
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toContain('not found')
  })

  it('GET /block/:hash rejects invalid hash format', async () => {
    const res = await fetch(`${baseUrl}/api/v1/block/invalidhash`)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Invalid block hash format')
  })

  it('GET /block/:hash rejects non-hex characters', async () => {
    const res = await fetch(`${baseUrl}/api/v1/block/${'g'.repeat(64)}`)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Invalid block hash format')
  })

  it('GET /block/:hash rejects too-short hash', async () => {
    const res = await fetch(`${baseUrl}/api/v1/block/${'a'.repeat(63)}`)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Invalid block hash format')
  })

  it('GET /block/:hash rejects too-long hash', async () => {
    const res = await fetch(`${baseUrl}/api/v1/block/${'a'.repeat(65)}`)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Invalid block hash format')
  })

  it('GET /block-by-height/:h returns block by height', async () => {
    const res = await fetch(`${baseUrl}/api/v1/block-by-height/1`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.height).toBe(1)
  })

  it('GET /block-by-height/:h returns 404 for out-of-range height', async () => {
    const res = await fetch(`${baseUrl}/api/v1/block-by-height/999`)
    expect(res.status).toBe(404)
  })

  it('GET /block-by-height/:h returns 400 for non-integer height', async () => {
    const res = await fetch(`${baseUrl}/api/v1/block-by-height/abc`)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('non-negative integer')
  })

  it('GET /tx/:txid returns 404 for unknown txid', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tx/${'a'.repeat(64)}`)
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toContain('not found')
  })

  it('GET /tx/:txid rejects invalid txid format', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tx/notahash`)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Invalid transaction ID format')
  })

  it('GET /tx/:txid rejects non-hex characters', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tx/${'g'.repeat(64)}`)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Invalid transaction ID format')
  })

  it('GET /tx/:txid rejects too-short txid', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tx/${'a'.repeat(63)}`)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Invalid transaction ID format')
  })

  it('GET /tx/:txid rejects too-long txid', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tx/${'a'.repeat(65)}`)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Invalid transaction ID format')
  })

  it('GET /tx/:txid returns coinbase tx from chain', async () => {
    const coinbaseTxId = node.chain.blocks[1].transactions[0].id
    const res = await fetch(`${baseUrl}/api/v1/tx/${coinbaseTxId}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.id).toBe(coinbaseTxId)
  })

  it('POST /tx rejects malformed body', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it('GET /mempool/stats returns size', async () => {
    const res = await fetch(`${baseUrl}/api/v1/mempool/stats`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(typeof body.size).toBe('number')
    expect(body.size).toBe(0)
  })

  it('GET /address/:addr/balance returns balance', async () => {
    const res = await fetch(`${baseUrl}/api/v1/address/${walletA.address}/balance`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(typeof body.balance).toBe('number')
    expect(body.balance).toBeGreaterThan(0)
  })

  it('GET /claims/stats returns object', async () => {
    const res = await fetch(`${baseUrl}/api/v1/claims/stats`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(typeof body).toBe('object')
    expect(typeof body.claimed).toBe('number')
  })

  it('GET /peers returns empty array when no p2pServer', async () => {
    const res = await fetch(`${baseUrl}/api/v1/peers`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBe(0)
  })

  it('GET /address/:addr/utxos returns UTXOs', async () => {
    const res = await fetch(`${baseUrl}/api/v1/address/${walletA.address}/utxos`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBeGreaterThan(0)
    expect(body[0]).toHaveProperty('txId')
    expect(body[0]).toHaveProperty('amount')
  })

  it('GET /address/:addr/utxos returns empty array for unknown address', async () => {
    const res = await fetch(`${baseUrl}/api/v1/address/${'f'.repeat(64)}/utxos`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBe(0)
  })

  it('GET /address/:addr/balance rejects invalid address format', async () => {
    const res = await fetch(`${baseUrl}/api/v1/address/invalidaddr/balance`)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Invalid address format')
  })

  it('GET /address/:addr/balance rejects non-hex characters', async () => {
    const res = await fetch(`${baseUrl}/api/v1/address/${'g'.repeat(64)}/balance`)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Invalid address format')
  })

  it('GET /address/:addr/balance rejects too-short address', async () => {
    const res = await fetch(`${baseUrl}/api/v1/address/${'a'.repeat(63)}/balance`)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Invalid address format')
  })

  it('GET /address/:addr/utxos rejects invalid address format', async () => {
    const res = await fetch(`${baseUrl}/api/v1/address/not-hex/utxos`)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Invalid address format')
  })

  it('GET /address/:addr/utxos rejects too-long address', async () => {
    const res = await fetch(`${baseUrl}/api/v1/address/${'a'.repeat(65)}/utxos`)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Invalid address format')
  })

  it('GET /status returns node state', async () => {
    const res = await fetch(`${baseUrl}/api/v1/status`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.height).toBe(3)
    expect(typeof body.hashrate).toBe('number')
    expect(typeof body.mempoolSize).toBe('number')
    expect(typeof body.utxoCount).toBe('number')
    expect(typeof body.cumulativeWork).toBe('string')
  })

  it('GET /blocks returns latest blocks with count cap', async () => {
    const res = await fetch(`${baseUrl}/api/v1/blocks?count=2`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBe(2)
    // Should be in reverse order (newest first)
    expect(body[0].height).toBeGreaterThan(body[1].height)
  })

  it('GET /blocks returns 400 for NaN count', async () => {
    const res = await fetch(`${baseUrl}/api/v1/blocks?count=abc`)
    expect(res.status).toBe(400)
  })

  it('GET /difficulty returns difficulty history', async () => {
    const res = await fetch(`${baseUrl}/api/v1/difficulty`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBeGreaterThan(0)
    expect(body[0]).toHaveProperty('height')
    expect(body[0]).toHaveProperty('target')
  })
})

describe('RPC transaction endpoints', () => {
  let node: Node
  let server: Server
  let baseUrl: string

  beforeAll(() => {
    const { snapshot, holders } = createMockSnapshot()
    node = new Node('rpc-tx-test', snapshot)
    node.chain.difficulty = TEST_TARGET

    // Mine blocks for data
    for (let i = 0; i < 3; i++) {
      node.mine(walletA.address, false)
    }

    const app = startRpcServer(node, 0)
    server = app.listen(0)
    const addr = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterAll(() => {
    server.close()
  })

  it('GET /tx/:txid finds transaction in mempool', async () => {
    // Add a claim tx to the mempool
    const { snapshot, holders } = createMockSnapshot()
    const genesisHash = node.chain.blocks[0].hash
    const claimTx = createClaimTransaction(
      holders[0].secretKey,
      holders[0].publicKey,
      snapshot.entries[0],
      walletB,
      snapshot.btcBlockHash,
      genesisHash
    )

    node.receiveTransaction(claimTx)

    const res = await fetch(`${baseUrl}/api/v1/tx/${claimTx.id}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.id).toBe(claimTx.id)
  })

  it('GET /mempool/txs returns transaction summaries', async () => {
    const res = await fetch(`${baseUrl}/api/v1/mempool/txs`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBeGreaterThan(0)
  })
})

describe('RPC edge cases', () => {
  let node: Node
  let server: Server
  let baseUrl: string

  beforeAll(() => {
    node = new Node('rpc-edge-test')
    node.chain.difficulty = '0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

    // Mine enough blocks to test pagination cap (>100)
    for (let i = 0; i < 3; i++) {
      node.mine(walletA.address, false)
    }

    const app = startRpcServer(node, 0)
    server = app.listen(0)
    const addr = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterAll(() => {
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
    const extraServer = extraApp.listen(0)
    const extraAddr = extraServer.address() as AddressInfo
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
    const limitServer = limitApp.listen(0)
    const limitAddr = limitServer.address() as AddressInfo
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

  it('GET /mempool/txs?limit=abc defaults to 1000 cap', async () => {
    const res = await fetch(`${baseUrl}/api/v1/mempool/txs?limit=abc`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
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
  })

  it('POST /tx with array body returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([]),
    })
    expect(res.status).toBe(400)
  })
})
