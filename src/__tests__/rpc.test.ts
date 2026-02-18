import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { Node } from '../node.js'
import { startRpcServer } from '../rpc.js'
import { walletA } from './fixtures.js'
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

  it('GET /block-by-height/:h returns 404 for NaN height', async () => {
    const res = await fetch(`${baseUrl}/api/v1/block-by-height/abc`)
    expect(res.status).toBe(404)
  })

  it('GET /tx/:txid returns 404 for unknown txid', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tx/${'a'.repeat(64)}`)
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toContain('not found')
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
})
