/**
 * qtcd — QubitCoin daemon
 *
 * Full node: RPC server, P2P networking, optional mining.
 *
 * CLI args:
 *   --port <n>        RPC port (default 3001)
 *   --p2p-port <n>    P2P port (default 6001)
 *   --snapshot <path> Path to BTC snapshot NDJSON file
 *   --datadir <path>  Data directory (default data/node)
 *   --seeds <host:port,...>  Comma-separated seed peers
 *   --mine            Enable mining (generates a wallet and mines continuously)
 *   --simulate        Enable periodic mining and transaction simulation (dev only)
 */
import { Node } from './node.js'
import { startRpcServer } from './rpc.js'
import { generateWallet, deriveAddress } from './crypto.js'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createTransaction } from './transaction.js'
import { INITIAL_TARGET } from './block.js'
import { FileBlockStorage } from './storage.js'
import { P2PServer } from './p2p/server.js'
import type { BtcSnapshot } from './snapshot.js'

// Parse CLI args
function parseArgs() {
  const args = process.argv.slice(2)
  const opts: Record<string, string> = {}
  const flags = new Set<string>()

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--simulate') {
      flags.add('simulate')
    } else if (arg === '--mine') {
      flags.add('mine')
    } else if (arg.startsWith('--') && i + 1 < args.length) {
      opts[arg.slice(2)] = args[++i]
    }
  }

  return {
    port: parseInt(opts['port'] ?? '3001', 10),
    p2pPort: parseInt(opts['p2p-port'] ?? '6001', 10),
    snapshotPath: opts['snapshot'] ?? null,
    dataDir: opts['datadir'] ?? 'data/node',
    seeds: opts['seeds'] ? opts['seeds'].split(',') : ['qubitcoin.finance:6001'],
    mine: flags.has('mine'),
    simulate: flags.has('simulate'),
  }
}

async function main() {
  const config = parseArgs()

  console.log('QubitCoin Node')
  console.log(`  RPC port:  ${config.port}`)
  console.log(`  P2P port:  ${config.p2pPort}`)
  console.log(`  Data dir:  ${config.dataDir}`)
  console.log(`  Seeds:     ${config.seeds.length > 0 ? config.seeds.join(', ') : '(none)'}`)
  console.log(`  Mine:      ${config.mine}`)
  console.log(`  Simulate:  ${config.simulate}`)

  // Load snapshot if provided
  let snapshot: BtcSnapshot | undefined
  if (config.snapshotPath) {
    console.log(`Loading snapshot from ${config.snapshotPath}...`)
    const { loadSnapshot } = await import('./snapshot-loader.js')
    snapshot = loadSnapshot(config.snapshotPath)
    console.log(`  Loaded ${snapshot.entries.length} addresses`)
  }

  // Create storage
  const storage = new FileBlockStorage(config.dataDir)

  // Check if we have persisted blocks
  const existingMeta = storage.loadMetadata()
  if (existingMeta) {
    console.log(`Restoring from disk: height=${existingMeta.height}, genesis=${existingMeta.genesisHash.slice(0, 16)}...`)
  }

  // Create node
  const node = new Node('node', snapshot, storage)
  console.log(`Chain initialized: height=${node.chain.getHeight()}, utxos=${node.chain.utxoSet.size}`)

  // Start P2P
  const p2p = new P2PServer(node, config.p2pPort, config.dataDir)
  await p2p.start()

  // Connect to seeds
  if (config.seeds.length > 0) {
    p2p.connectToSeeds(config.seeds)
  }

  // Start RPC
  startRpcServer(node, config.port, p2p)

  // Mining mode — load or generate a wallet, then mine continuously
  if (config.mine) {
    const walletPath = join(config.dataDir, 'wallet.json')
    let minerWallet

    if (existsSync(walletPath)) {
      const raw = JSON.parse(readFileSync(walletPath, 'utf-8'))
      minerWallet = {
        publicKey: new Uint8Array(Buffer.from(raw.publicKey, 'hex')),
        secretKey: new Uint8Array(Buffer.from(raw.secretKey, 'hex')),
        address: raw.address,
      }
      console.log(`Loaded miner wallet from ${walletPath}`)
    } else {
      minerWallet = generateWallet()
      mkdirSync(config.dataDir, { recursive: true })
      writeFileSync(walletPath, JSON.stringify({
        publicKey: Buffer.from(minerWallet.publicKey).toString('hex'),
        secretKey: Buffer.from(minerWallet.secretKey).toString('hex'),
        address: minerWallet.address,
      }, null, 2))
      console.log(`Generated new miner wallet → ${walletPath}`)
    }
    console.log(`Miner address: ${minerWallet.address}`)

    // Wait for IBD before mining so we don't mine on a stale chain
    if (config.seeds.length > 0) {
      console.log('Waiting for sync with network...')
      await p2p.waitForSync(15_000)
      console.log(`Synced to height ${node.chain.getHeight()}, starting miner`)
    }

    node.startMining(minerWallet.address)
  }

  // Simulation mode (dev only)
  if (config.simulate) {
    const minerWallet = generateWallet()
    const wallet1 = generateWallet()
    const wallet2 = generateWallet()

    // Pin difficulty to easy target in simulation mode so mining
    // never blocks the event loop for more than ~100ms
    function simMine(address: string) {
      node.chain.difficulty = INITIAL_TARGET
      node.mine(address, false)
    }

    // Mine initial blocks if chain is fresh (only genesis)
    if (node.chain.getHeight() === 0) {
      console.log('Mining initial blocks...')
      for (let i = 0; i < 3; i++) {
        simMine(minerWallet.address)
      }
      simMine(wallet1.address)
    }

    function simulateTransaction() {
      try {
        const utxos = node.chain.findUTXOs(wallet1.address, 5)
        if (utxos.length === 0) return
        const tx = createTransaction(wallet1, utxos, [{ address: wallet2.address, amount: 5 }], 1)
        node.receiveTransaction(tx)
        console.log(`Simulated tx ${tx.id.slice(0, 16)}...`)
      } catch {
        simMine(wallet1.address)
      }
    }

    // Mine a new block every 10 seconds
    setInterval(() => {
      simMine(minerWallet.address)
    }, 10_000)

    // Create a random transaction every 15 seconds
    setInterval(() => {
      simulateTransaction()
    }, 15_000)

    // Kick off one transaction right away
    setTimeout(simulateTransaction, 2000)

    console.log('Simulation mode active (mining every 10s, txs every 15s)')
  }

  console.log(`Explorer backend running on http://127.0.0.1:${config.port}`)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
