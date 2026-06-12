import { describe, it } from 'vitest'
import { startRpcServer } from '../rpc.js'
import { probeLoopbackTcpListen } from './network-test-utils.js'
import type { Node } from '../node.js'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

export const TEST_TARGET = '0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
export const LOOPBACK_TCP_SUPPORTED = await probeLoopbackTcpListen()
export const describeLoopbackTcp: typeof describe.skip = LOOPBACK_TCP_SUPPORTED ? describe : describe.skip
export const itLoopbackTcp: typeof it.skip = LOOPBACK_TCP_SUPPORTED ? it : it.skip

export async function listenOnLoopback(server: Server): Promise<AddressInfo> {
  if (!server.listening) {
    await new Promise<void>((resolve) => server.once('listening', resolve))
  }
  const addr = server.address() as AddressInfo | null
  if (!addr || typeof addr === 'string') {
    throw new Error('Expected HTTP server to bind to a TCP port')
  }
  return addr
}

export async function startRpcTestServer(node: Node): Promise<{ server: Server; baseUrl: string }> {
  const app = startRpcServer(node, 0)
  const server = app.listen(0, '127.0.0.1')
  const addr = await listenOnLoopback(server)
  return {
    server,
    baseUrl: `http://127.0.0.1:${addr.port}`,
  }
}
