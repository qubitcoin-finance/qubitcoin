import { describe } from 'vitest'
import { utxoKey, type UTXO } from '../transaction.js'
import { probeLoopbackTcpListen } from './network-test-utils.js'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

const LOOPBACK_TCP_SUPPORTED = await probeLoopbackTcpListen()
export const describeLoopbackTcp: typeof describe.skip = LOOPBACK_TCP_SUPPORTED ? describe : describe.skip

/** Wait for a condition to become true */
export function waitFor(
  fn: () => boolean,
  timeout = 10_000,
  interval = 20,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const check = () => {
      if (fn()) return resolve()
      if (Date.now() - start > timeout) return reject(new Error('waitFor timeout'))
      setTimeout(check, interval)
    }
    check()
  })
}

export async function listenOnLoopback(server: Server): Promise<number> {
  if (!server.listening) {
    await new Promise<void>((resolve) => server.once('listening', resolve))
  }
  const addr = server.address() as AddressInfo | null
  if (!addr || typeof addr === 'string') {
    throw new Error('Expected HTTP server to bind to a TCP port')
  }
  return addr.port
}

export function makeUtxoSet(wallet: { address: string }, amount = 100): Map<string, UTXO> {
  const utxoSet = new Map<string, UTXO>()
  const txId = 'a'.repeat(64)
  utxoSet.set(utxoKey(txId, 0), {
    txId,
    outputIndex: 0,
    address: wallet.address,
    amount,
  })
  return utxoSet
}
