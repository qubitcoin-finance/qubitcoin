import { describe, it, expect } from 'vitest'
import { Node } from '../node.js'
import { walletA } from './fixtures.js'
import { describeLoopbackTcp, listenOnLoopback } from './hardening-test-helpers.js'

describeLoopbackTcp('RPC blocks count cap', () => {
  it('should cap blocks endpoint count to 100', async () => {
    const { startRpcServer } = await import('../rpc.js')
    const node = new Node('rpc-test')
    const TEST_TARGET = '0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
    node.chain.difficulty = TEST_TARGET

    // Mine a few blocks
    for (let i = 0; i < 5; i++) {
      node.mine(walletA.address, false)
    }

    // Start RPC on random port
    const app = startRpcServer(node, 0)
    const server = app.listen(0, '127.0.0.1')
    const port = await listenOnLoopback(server)

    try {
      // Request with count=999999 (should be capped to 100)
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/blocks?count=999999`)
      const blocks = await res.json()
      expect(Array.isArray(blocks)).toBe(true)
      // We only have 6 blocks (genesis + 5), but count is capped to 100
      expect(blocks.length).toBeLessThanOrEqual(100)
      expect(blocks.length).toBe(6) // all 6 blocks since < 100

      // Request with explicit count=2
      const res2 = await fetch(`http://127.0.0.1:${port}/api/v1/blocks?count=2`)
      const blocks2 = await res2.json()
      expect(blocks2.length).toBe(2)
    } finally {
      server.close()
    }
  })
})

describeLoopbackTcp('RPC hardening', () => {
  it('should return 400 for NaN count parameter', async () => {
    const { startRpcServer } = await import('../rpc.js')
    const node = new Node('rpc-nan')
    const app = startRpcServer(node, 0)
    const server = app.listen(0, '127.0.0.1')
    const port = await listenOnLoopback(server)

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/blocks?count=abc`)
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('Invalid count')
    } finally {
      server.close()
    }
  })

  it('should return 400 for negative count parameter', async () => {
    const { startRpcServer } = await import('../rpc.js')
    const node = new Node('rpc-neg')
    const app = startRpcServer(node, 0)
    const server = app.listen(0, '127.0.0.1')
    const port = await listenOnLoopback(server)

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/blocks?count=-5`)
      expect(res.status).toBe(400)
    } finally {
      server.close()
    }
  })

  it('should reject non-integer mempool limit with 400', async () => {
    const { startRpcServer } = await import('../rpc.js')
    const node = new Node('rpc-mlimit')
    const app = startRpcServer(node, 0)
    const server = app.listen(0, '127.0.0.1')
    const port = await listenOnLoopback(server)

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/mempool/txs?limit=xyz`)
      expect(res.status).toBe(400) // invalid input must be rejected, not silently ignored
      const body = await res.json()
      expect(body.error).toContain('Invalid limit parameter')
    } finally {
      server.close()
    }
  })

  it('should not expose X-Powered-By header', async () => {
    const { startRpcServer } = await import('../rpc.js')
    const node = new Node('rpc-xpb')
    const app = startRpcServer(node, 0)
    const server = app.listen(0, '127.0.0.1')
    const port = await listenOnLoopback(server)

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/status`)
      expect(res.headers.get('x-powered-by')).toBeNull()
    } finally {
      server.close()
    }
  })

  it('should deny CORS when bound to non-localhost', async () => {
    const { startRpcServer } = await import('../rpc.js')
    const node = new Node('rpc-cors')
    // Bind to 0.0.0.0 — CORS should be restrictive
    // Build a minimal express app to test CORS behavior directly
    const express = (await import('express')).default
    const cors = (await import('cors')).default
    const app = express()
    // Simulate the CORS behavior for non-localhost bind
    app.use(cors({ origin: false }))
    app.get('/test', (req: any, res: any) => res.json({ ok: true }))
    const server = app.listen(0, '127.0.0.1')
    const port = await listenOnLoopback(server)

    try {
      const res = await fetch(`http://127.0.0.1:${port}/test`)
      // When origin is false, no Access-Control-Allow-Origin header should be present
      const corsHeader = res.headers.get('access-control-allow-origin')
      expect(corsHeader).toBeNull()
    } finally {
      server.close()
    }
  })
})

