import { it, expect } from 'vitest'
import http from 'node:http'
import { Node } from '../node.js'
import { startRpcServer } from '../rpc.js'
import { describeLoopbackTcp, listenOnLoopback } from './rpc-test-helpers.js'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

describeLoopbackTcp('RPC rate limiting', () => {
  function startForwardingProxy(
    targetPort: number,
    forwardedFor: string | null,
    options?: { appendRemoteAddress?: boolean },
  ): Promise<Server> {
    const proxy = http.createServer((req, res) => {
      const existingForwardedFor = req.headers['x-forwarded-for']
      const forwardedChain = Array.isArray(existingForwardedFor)
        ? existingForwardedFor.join(', ')
        : existingForwardedFor
      const remoteAddress = req.socket.remoteAddress
      const nextForwardedFor = options?.appendRemoteAddress && remoteAddress
        ? [forwardedChain, remoteAddress].filter(part => part && part.length > 0).join(', ')
        : forwardedFor ?? forwardedChain
      const upstream = http.request({
        host: '127.0.0.1',
        port: targetPort,
        path: req.url,
        method: req.method,
        headers: {
          ...req.headers,
          ...(nextForwardedFor ? { 'x-forwarded-for': nextForwardedFor } : {}),
        },
      }, upstreamRes => {
        res.writeHead(upstreamRes.statusCode ?? 500, upstreamRes.headers)
        upstreamRes.pipe(res)
      })

      upstream.on('error', () => {
        res.statusCode = 502
        res.end()
      })

      req.pipe(upstream)
    })

    return new Promise(resolve => {
      proxy.listen(0, '127.0.0.1', () => resolve(proxy))
    })
  }

  it('POST /tx is rate-limited at 100 requests/min per IP', async () => {
    const node = new Node('rpc-rate-post-test')
    const app = startRpcServer(node, 0)
    const server = app.listen(0, '127.0.0.1')
    const addr = await listenOnLoopback(server)
    const baseUrl = `http://127.0.0.1:${addr.port}`

    try {
      // Send 101 POST requests concurrently from the same IP.
      // After 100 accepted requests, the 101st must be rejected with 429.
      const responses = await Promise.all(
        Array.from({ length: 101 }, () =>
          fetch(`${baseUrl}/api/v1/tx`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          })
        )
      )
      const statuses = responses.map(r => r.status)
      // Most responses will be 400 (invalid tx body), at least one must be 429
      expect(statuses.filter(s => s === 429).length).toBeGreaterThanOrEqual(1)
    } finally {
      server.close()
    }
  })

  it('public-bind RPC ignores spoofed X-Forwarded-For when rate limiting', async () => {
    const node = new Node('rpc-rate-public-bind-test')
    const app = startRpcServer(node, 0, undefined, '0.0.0.0', false)
    const server = app.listen(0, '127.0.0.1')
    const addr = await listenOnLoopback(server)
    const baseUrl = `http://127.0.0.1:${addr.port}`

    try {
      const initialResponses = await Promise.all(
        Array.from({ length: 100 }, () =>
          fetch(`${baseUrl}/api/v1/tx`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Forwarded-For': '198.51.100.10',
            },
            body: JSON.stringify({}),
          })
        )
      )
      expect(initialResponses.every(r => r.status === 400)).toBe(true)

      const spoofedIpRes = await fetch(`${baseUrl}/api/v1/tx`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': '203.0.113.77',
        },
        body: JSON.stringify({}),
      })

      expect(spoofedIpRes.status).toBe(429)
    } finally {
      server.close()
    }
  })

  it('public-bind RPC honors forwarded client IPs from trusted loopback proxies', async () => {
    const node = new Node('rpc-rate-public-bind-proxy-test')
    const app = startRpcServer(node, 0, undefined, '0.0.0.0', 'loopback')
    const server = await new Promise<Server>(resolve => {
      const listeningServer = app.listen(0, '127.0.0.1', () => resolve(listeningServer))
    })
    const addr = server.address() as AddressInfo
    const proxyA = await startForwardingProxy(addr.port, '198.51.100.10')
    const proxyB = await startForwardingProxy(addr.port, '203.0.113.77')
    const proxyAAddr = proxyA.address() as AddressInfo
    const proxyBAddr = proxyB.address() as AddressInfo
    const proxyABaseUrl = `http://127.0.0.1:${proxyAAddr.port}`
    const proxyBBaseUrl = `http://127.0.0.1:${proxyBAddr.port}`

    try {
      const initialResponses = await Promise.all(
        Array.from({ length: 100 }, () =>
          fetch(`${proxyABaseUrl}/api/v1/tx`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({}),
          })
        )
      )
      expect(initialResponses.every(r => r.status === 400)).toBe(true)

      const differentForwardedIpRes = await fetch(`${proxyBBaseUrl}/api/v1/tx`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      })

      expect(differentForwardedIpRes.status).toBe(400)
    } finally {
      proxyA.close()
      proxyB.close()
      server.close()
    }
  })

  it('one trusted proxy hop honors forwarded client IPs without trusting extra hops', async () => {
    const node = new Node('rpc-rate-public-bind-one-hop-test')
    const app = startRpcServer(node, 0, undefined, '0.0.0.0', 1)
    const server = await new Promise<Server>(resolve => {
      const listeningServer = app.listen(0, '127.0.0.1', () => resolve(listeningServer))
    })
    const addr = server.address() as AddressInfo
    const baseUrl = `http://127.0.0.1:${addr.port}`
    const trustedProxyA = await startForwardingProxy(addr.port, '198.51.100.10')
    const trustedProxyB = await startForwardingProxy(addr.port, '203.0.113.77')
    const trustedProxyAAddr = trustedProxyA.address() as AddressInfo
    const trustedProxyABaseUrl = `http://127.0.0.1:${trustedProxyAAddr.port}`
    const trustedProxyBAddr = trustedProxyB.address() as AddressInfo
    const trustedProxyBBaseUrl = `http://127.0.0.1:${trustedProxyBAddr.port}`
    try {
      const initialResponses = await Promise.all(
        Array.from({ length: 100 }, () =>
          fetch(`${trustedProxyABaseUrl}/api/v1/tx`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({}),
          })
        )
      )
      expect(initialResponses.every(r => r.status === 400)).toBe(true)

      const differentForwardedIpRes = await fetch(`${trustedProxyBBaseUrl}/api/v1/tx`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      })
      expect(differentForwardedIpRes.status).toBe(400)

      const extraHopChainRes = await fetch(`${baseUrl}/api/v1/tx`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': '198.51.100.10, 203.0.113.77',
        },
        body: JSON.stringify({}),
      })
      expect(extraHopChainRes.status).toBe(400)
    } finally {
      trustedProxyA.close()
      trustedProxyB.close()
      server.close()
    }
  })

  it('numeric trust-proxy hop counts honor the forwarded client IP', async () => {
    const node = new Node('rpc-rate-public-bind-hop-count-test')
    const app = startRpcServer(node, 0, undefined, '0.0.0.0', 2)
    const server = await new Promise<Server>(resolve => {
      const listeningServer = app.listen(0, '127.0.0.1', () => resolve(listeningServer))
    })
    const addr = server.address() as AddressInfo
    const proxyB = await startForwardingProxy(addr.port, null, { appendRemoteAddress: true })
    const proxyBAddr = proxyB.address() as AddressInfo
    const proxyA1 = await startForwardingProxy(proxyBAddr.port, '198.51.100.10')
    const proxyA2 = await startForwardingProxy(proxyBAddr.port, '203.0.113.77')
    const proxyA1Addr = proxyA1.address() as AddressInfo
    const proxyA2Addr = proxyA2.address() as AddressInfo
    const proxyA1BaseUrl = `http://127.0.0.1:${proxyA1Addr.port}`
    const proxyA2BaseUrl = `http://127.0.0.1:${proxyA2Addr.port}`

    try {
      const initialResponses = await Promise.all(
        Array.from({ length: 100 }, () =>
          fetch(`${proxyA1BaseUrl}/api/v1/tx`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({}),
          })
        )
      )
      expect(initialResponses.every(r => r.status === 400)).toBe(true)

      const differentForwardedIpRes = await fetch(`${proxyA2BaseUrl}/api/v1/tx`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      })

      expect(differentForwardedIpRes.status).toBe(400)
    } finally {
      proxyA1.close()
      proxyA2.close()
      proxyB.close()
      server.close()
    }
  })

  it('GET /status is rate-limited independently at 600 requests/min per IP', async () => {
    const node = new Node('rpc-rate-get-test')
    const app = startRpcServer(node, 0)
    const server = app.listen(0, '127.0.0.1')
    const addr = await listenOnLoopback(server)
    const baseUrl = `http://127.0.0.1:${addr.port}`

    try {
      const responses = await Promise.all(
        Array.from({ length: 601 }, () => fetch(`${baseUrl}/api/v1/status`))
      )
      const statuses = responses.map(r => r.status)
      expect(statuses.filter(s => s === 429).length).toBeGreaterThanOrEqual(1)
      expect(statuses.filter(s => s === 200).length).toBeGreaterThanOrEqual(600)
    } finally {
      server.close()
    }
  })

  it('GET traffic does not consume the stricter POST rate-limit bucket', async () => {
    const node = new Node('rpc-rate-isolation-test')
    const app = startRpcServer(node, 0, undefined, '127.0.0.1', undefined, {
      get: 3,
      post: 1,
    })
    const server = app.listen(0, '127.0.0.1')
    const addr = await listenOnLoopback(server)
    const baseUrl = `http://127.0.0.1:${addr.port}`

    try {
      const getResponses = await Promise.all(
        Array.from({ length: 3 }, () => fetch(`${baseUrl}/api/v1/status`))
      )
      expect(getResponses.every(r => r.status === 200)).toBe(true)

      const postRes = await fetch(`${baseUrl}/api/v1/tx`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })

      expect(postRes.status).toBe(400)
    } finally {
      server.close()
    }
  })
})
