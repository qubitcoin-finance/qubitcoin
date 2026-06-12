import { it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Node } from '../node.js'
import { startRpcServer } from '../rpc.js'
import { FileBlockStorage } from '../storage.js'
import { P2PServer } from '../p2p/server.js'
import { describeLoopbackTcp, itLoopbackTcp, listenOnLoopback } from './rpc-test-helpers.js'

describeLoopbackTcp('RPC with p2pServer', () => {
  it('GET /status includes peers count from p2pServer', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-rpc-status-'))
    try {
      const storage = new FileBlockStorage(tmpDir)
      const n = new Node('rpc-status-p2p-test', undefined, storage)
      const p2p = new P2PServer(n, 0, tmpDir)

      const app = startRpcServer(n, 0, p2p)
      const srv = app.listen(0, '127.0.0.1')
      const addr = await listenOnLoopback(srv)
      const url = `http://127.0.0.1:${addr.port}`

      try {
        const res = await fetch(`${url}/api/v1/status`)
        expect(res.status).toBe(200)
        const body = await res.json()
        // peers field must be present and numeric (0 — no connected peers yet)
        expect(typeof body.peers).toBe('number')
        expect(body.peers).toBe(0)
      } finally {
        srv.close()
        await p2p.stop()
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true })
    }
  })

  itLoopbackTcp('GET /peers filters out localhost peers when p2pServer is provided', async () => {
    const tmpDir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-rpc-peers1-'))
    const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'qbtc-rpc-peers2-'))
    try {
      const n1 = new Node('rpc-peers-test-1', undefined, new FileBlockStorage(tmpDir1))
      const p2p1 = new P2PServer(n1, 0, tmpDir1)
      p2p1.setLocalMode(true) // allow private IPs in address book for this test
      await p2p1.start()
      const p2pPort = p2p1.getPort()

      const n2 = new Node('rpc-peers-test-2', undefined, new FileBlockStorage(tmpDir2))
      const p2p2 = new P2PServer(n2, 0, tmpDir2)
      p2p2.setLocalMode(true)
      await p2p2.start()

      // Connect node2 → node1 and wait for handshake
      p2p2.connectOutbound('127.0.0.1', p2pPort)
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 5_000
        const check = () => {
          if (p2p1.getPeers().length > 0) return resolve()
          if (Date.now() > deadline) return reject(new Error('handshake timeout'))
          setTimeout(check, 20)
        }
        setTimeout(check, 20)
      })

      const app = startRpcServer(n1, 0, p2p1)
      const srv = app.listen(0, '127.0.0.1')
      const addr = await listenOnLoopback(srv)
      const url = `http://127.0.0.1:${addr.port}`

      try {
        const res = await fetch(`${url}/api/v1/peers`)
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(Array.isArray(body)).toBe(true)
        // The connected peer is on 127.0.0.1, so it must be filtered out
        expect(body.length).toBe(0)
      } finally {
        srv.close()
        await p2p1.stop()
        await p2p2.stop()
      }
    } finally {
      fs.rmSync(tmpDir1, { recursive: true })
      fs.rmSync(tmpDir2, { recursive: true })
    }
  })
})
