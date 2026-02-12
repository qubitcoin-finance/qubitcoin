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
 *   --full            Auto-download snapshot if missing, then start as full node
 *   --local           Run without default seed (isolated local chain)
 *   --simulate        Enable periodic mining and transaction simulation (dev only)
 */
import { Node } from './node.js'
import { startRpcServer } from './rpc.js'
import { generateWallet, deriveAddress } from './crypto.js'
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, createWriteStream } from 'node:fs'
import { join } from 'node:path'
import { get as httpsGet } from 'node:https'
import { get as httpGet } from 'node:http'
import { createTransaction } from './transaction.js'
import { INITIAL_TARGET } from './block.js'
import { FileBlockStorage } from './storage.js'
import { P2PServer } from './p2p/server.js'
import type { BtcSnapshot } from './snapshot.js'
import { log } from './log.js'

// Parse CLI args
function parseArgs() {
  const args = process.argv.slice(2)
  const opts: Record<string, string> = {}
  const flags = new Set<string>()

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') continue
    if (arg === '--help' || arg === '-h') {
      console.log(`qtcd — QubitCoin daemon

Usage: pnpm run qtcd [-- options]

Options:
  --port <n>              RPC port (default 3001)
  --p2p-port <n>          P2P port (default 6001)
  --snapshot <path>       Path to BTC snapshot NDJSON file
  --datadir <path>        Data directory (default data/node)
  --seeds <host:port,...> Comma-separated seed peers (default: qubitcoin.finance:6001 with --full)
  --mine                  Enable mining (connects to network by default)
  --full                  Auto-download snapshot if missing, then start as full node
  --local                 Run without default seed (isolated local chain)
  --message <text>        Coinbase message included in every mined block
  --simulate              Dev mode: pinned easy difficulty, fake txs
  -h, --help              Show this help`)
      process.exit(0)
    } else if (arg === '--simulate') {
      flags.add('simulate')
    } else if (arg === '--mine') {
      flags.add('mine')
    } else if (arg === '--full') {
      flags.add('full')
    } else if (arg === '--local') {
      flags.add('local')
    } else if (arg.startsWith('--') && i + 1 < args.length) {
      opts[arg.slice(2)] = args[++i]
    }
  }

  return {
    port: parseInt(opts['port'] ?? '3001', 10),
    p2pPort: parseInt(opts['p2p-port'] ?? '6001', 10),
    snapshotPath: opts['snapshot'] ?? null,
    dataDir: opts['datadir'] ?? 'data/node',
    seeds: opts['seeds'] !== undefined ? (opts['seeds'] ? opts['seeds'].split(',') : []) : [],
    mine: flags.has('mine'),
    full: flags.has('full'),
    local: flags.has('local'),
    simulate: flags.has('simulate'),
    message: opts['message'] ?? null,
  }
}

const SNAPSHOT_URL = 'https://qubitcoin.finance/snapshot/qtc-snapshot.jsonl'

function downloadFile(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tmpPath = destPath + '.tmp'
    const get = url.startsWith('https') ? httpsGet : httpGet

    get(url, (res) => {
      // Follow redirects
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        downloadFile(res.headers.location, destPath).then(resolve, reject)
        return
      }
      if (res.statusCode !== 200) {
        reject(new Error(`Download failed: HTTP ${res.statusCode}`))
        return
      }

      const totalBytes = parseInt(res.headers['content-length'] ?? '0', 10)
      let downloadedBytes = 0
      let lastLoggedPct = 0

      const file = createWriteStream(tmpPath)
      res.on('data', (chunk: Buffer) => {
        downloadedBytes += chunk.length
        if (totalBytes > 0) {
          const pct = Math.floor((downloadedBytes / totalBytes) * 100)
          if (pct >= lastLoggedPct + 10) {
            lastLoggedPct = pct
            const mb = (downloadedBytes / 1024 / 1024).toFixed(0)
            const totalMb = (totalBytes / 1024 / 1024).toFixed(0)
            log.info({ component: 'snapshot', progress: `${pct}%`, downloaded: `${mb}MB`, total: `${totalMb}MB` }, 'Downloading snapshot')
          }
        }
      })
      res.pipe(file)
      file.on('finish', () => {
        file.close(() => {
          renameSync(tmpPath, destPath)
          resolve()
        })
      })
      file.on('error', (err) => reject(err))
    }).on('error', (err) => reject(err))
  })
}

async function main() {
  const config = parseArgs()

  log.info({
    msg: 'QubitCoin daemon starting',
    rpcPort: config.port,
    p2pPort: config.p2pPort,
    dataDir: config.dataDir,
    seeds: config.seeds,
    mining: config.mine,
    full: config.full,
    local: config.local,
    simulate: config.simulate,
  })

  // Default to public seed when mining or running as full node, unless --local
  if ((config.mine || config.full) && config.seeds.length === 0 && !config.local) {
    config.seeds = ['qubitcoin.finance:6001']
  }

  // --full: auto-download snapshot if not provided and not on disk
  if (config.full && !config.snapshotPath) {
    mkdirSync(config.dataDir, { recursive: true })
    const defaultPath = join(config.dataDir, 'qtc-snapshot.jsonl')
    if (existsSync(defaultPath)) {
      log.info({ component: 'snapshot', path: defaultPath }, 'Snapshot already exists')
    } else {
      log.info({ component: 'snapshot', url: SNAPSHOT_URL, dest: defaultPath }, 'Downloading snapshot')
      await downloadFile(SNAPSHOT_URL, defaultPath)
      log.info({ component: 'snapshot', path: defaultPath }, 'Snapshot download complete')
    }
    config.snapshotPath = defaultPath
  }

  // Load snapshot if provided
  let snapshot: BtcSnapshot | undefined
  if (config.snapshotPath) {
    log.info({ component: 'snapshot', path: config.snapshotPath }, 'Loading snapshot')
    const { loadSnapshot } = await import('./snapshot-loader.js')
    snapshot = await loadSnapshot(config.snapshotPath)
    log.info({ component: 'snapshot', addresses: snapshot.entries.length }, 'Snapshot loaded')
  }

  // Create storage
  const storage = new FileBlockStorage(config.dataDir)

  // Check if we have persisted blocks
  const existingMeta = storage.loadMetadata()
  if (existingMeta) {
    log.info({ component: 'storage', height: existingMeta.height, genesis: existingMeta.genesisHash.slice(0, 16) }, 'Restoring from disk')
  }

  // Create node
  const node = new Node('node', snapshot, storage)
  log.info({ component: 'chain', height: node.chain.getHeight(), utxos: node.chain.utxoSet.size }, 'Chain initialized')

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
      log.info({ component: 'miner', walletPath }, 'Wallet loaded')
    } else {
      minerWallet = generateWallet()
      mkdirSync(config.dataDir, { recursive: true })
      writeFileSync(walletPath, JSON.stringify({
        publicKey: Buffer.from(minerWallet.publicKey).toString('hex'),
        secretKey: Buffer.from(minerWallet.secretKey).toString('hex'),
        address: minerWallet.address,
      }, null, 2))
      log.info({ component: 'miner', walletPath }, 'New wallet generated')
    }
    log.info({ component: 'miner', address: minerWallet.address }, 'Miner address')

    // Wait for IBD before mining so we don't mine on a stale chain
    if (config.seeds.length > 0) {
      log.info({ component: 'p2p' }, 'Waiting for sync with network')
      try {
        await p2p.waitForSync(15_000)
      } catch {
        log.fatal({ component: 'p2p', seeds: config.seeds }, 'Could not sync with seed nodes — refusing to mine on a fork')
        process.exit(1)
      }
      log.info({ component: 'p2p', height: node.chain.getHeight(), peers: p2p.getPeers().length, seeds: config.seeds }, 'Connected to QubitCoin network')
    }

    node.startMining(minerWallet.address, config.message ?? undefined)
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
      log.info({ component: 'simulate' }, 'Mining initial blocks')
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
        log.info({ component: 'simulate', txid: tx.id.slice(0, 16) }, 'Simulated tx')
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

    log.info({ component: 'simulate' }, 'Simulation mode active (mining every 10s, txs every 15s)')
  }

  log.debug({ rpcUrl: `http://127.0.0.1:${config.port}` }, 'Node ready')
}

main().catch((err) => {
  log.fatal({ err }, 'Fatal error')
  process.exit(1)
})
