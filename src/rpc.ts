
import express from 'express';
import { Node } from './node.js';
import cors from 'cors';
import type { P2PServer } from './p2p/server.js';
import { deserializeTransaction } from './storage.js';
import { DIFFICULTY_ADJUSTMENT_INTERVAL, STARTING_DIFFICULTY } from './block.js';
import { log } from './log.js';
import { isValidHash, sanitize } from './utils.js';
import type { Request, Response, NextFunction, Express } from 'express';
import { DEFAULT_TRUSTED_PROXIES, type RpcTrustProxy } from './rpc-trust-proxy.js';
import { createRateLimiter, GET_RATE_LIMIT, POST_RATE_LIMIT, RATE_WINDOW_MS } from './rpc-rate-limit.js';
import { summarizeMempoolTransaction } from './rpc-mempool.js';

/** Maximum JSON body size (1 MB) */
const MAX_BODY_SIZE = '1mb';

const ADDRESS_RE = /^[0-9a-f]{64}$/i;
const BTC_SNAPSHOT_ADDRESS_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

export type RpcRateLimitConfig = {
  get?: number;
  post?: number;
  windowMs?: number;
};

export { sanitize };

/** Validate that an address is a valid 64-character hex string */
function isValidAddress(address: string): boolean {
  return typeof address === 'string' && address.length === 64 && ADDRESS_RE.test(address);
}

/** Validate snapshot BTC address keys: HASH160 hex or 32-byte witness/script hash hex */
function isValidSnapshotAddress(address: string): boolean {
  return typeof address === 'string' && BTC_SNAPSHOT_ADDRESS_RE.test(address);
}

type RequestError = Error & {
  status?: number;
  statusCode?: number;
  type?: string;
};

function sendError(res: Response, status: number, error: string): void {
  res.status(status).json({ error });
}

export function startRpcServer(
  node: Node,
  port: number,
  p2pServer?: P2PServer,
  bindAddress: string = '127.0.0.1',
  trustProxy: RpcTrustProxy = [...DEFAULT_TRUSTED_PROXIES],
  rateLimitConfig: RpcRateLimitConfig = {},
): Express {
  const app = express();
  app.set('trust proxy', trustProxy);
  app.disable('x-powered-by');

  // Rate limiting
  const rateLimiter = createRateLimiter(rateLimitConfig.windowMs ?? RATE_WINDOW_MS);
  const listen = app.listen.bind(app);
  app.listen = ((...args: Parameters<typeof app.listen>) => {
    const server = listen(...args);
    server.on('error', (err) => {
      log.error({ component: 'rpc', err }, 'RPC server error');
    });
    server.once('close', rateLimiter.close);
    return server;
  }) as typeof app.listen;
  const getRateLimiter = rateLimiter('GET', rateLimitConfig.get ?? GET_RATE_LIMIT);
  const postRateLimiter = rateLimiter('POST', rateLimitConfig.post ?? POST_RATE_LIMIT);
  app.use(cors({ origin: bindAddress === '127.0.0.1' ? true : false }));
  app.use((req: Request, res: Response, next: NextFunction) => {
    const limiter = req.method === 'POST' ? postRateLimiter : getRateLimiter;
    limiter(req, res, next);
  });
  app.use(express.json({ limit: MAX_BODY_SIZE, strict: false }));

  // Endpoint to get the status of the node
  app.get('/api/v1/status', (req, res) => {
    const state = node.getState();
    const peers = p2pServer ? p2pServer.getPeers().length : 0;
    res.json(sanitize({ ...state, peers }));
  });

  // Endpoint to get a block by its hash
  app.get('/api/v1/block/:hash', (req, res) => {
    const hash = req.params.hash.toLowerCase();
    if (!isValidHash(hash)) {
      sendError(res, 400, 'Invalid block hash format: must be 64-character hex string');
      return;
    }
    const block = node.chain.blocks.find(b => b.hash === hash);
    if (block) {
      res.json(sanitize(block));
    } else {
      sendError(res, 404, 'Block not found');
    }
  });

  // Endpoint to get a block by height
  app.get('/api/v1/block-by-height/:height', (req, res) => {
    if (!/^\d+$/.test(req.params.height)) {
      sendError(res, 400, 'Invalid height: must be a non-negative integer');
      return;
    }
    const height = parseInt(req.params.height, 10);
    if (height > 2_147_483_647) {
      sendError(res, 400, 'Invalid height: value too large');
      return;
    }
    if (height >= node.chain.blocks.length) {
      sendError(res, 404, 'Block not found');
      return;
    }
    res.json(sanitize(node.chain.blocks[height]));
  });

  // Endpoint to get the latest blocks
  app.get('/api/v1/blocks', (req, res) => {
    if (req.query.count !== undefined && !/^\d+$/.test(req.query.count as string)) {
      sendError(res, 400, 'Invalid count parameter');
      return;
    }
    const parsed = req.query.count ? parseInt(req.query.count as string, 10) : 10;
    const count = Math.min(parsed, 100);
    // Slice the newest `count` blocks before reversing, so we never copy/reverse the whole chain.
    const start = Math.max(0, node.chain.blocks.length - count);
    const blocks = node.chain.blocks.slice(start).reverse();
    res.json(sanitize(blocks));
  });

  // Endpoint to get a transaction by its ID
  app.get('/api/v1/tx/:txid', (req, res) => {
    const txid = req.params.txid.toLowerCase();
    if (!isValidHash(txid)) {
      sendError(res, 400, 'Invalid transaction ID format: must be 64-character hex string');
      return;
    }
    const tx = node.mempool.getTransaction(txid);
    if (tx) {
      res.json(sanitize(tx));
      return;
    }
    // Look in the chain using O(1) transaction index
    const block = node.chain.findTransactionBlock(txid);
    if (block) {
      const foundTx = block.transactions.find(t => t.id === txid);
      if (!foundTx) {
        sendError(res, 404, 'Transaction not found');
        return;
      }
      res.json(sanitize({
        ...foundTx,
        blockHash: block.hash,
        blockHeight: block.height,
        confirmations: node.chain.blocks.length - block.height,
      }));
      return;
    }
    sendError(res, 404, 'Transaction not found');
  });

  // Submit a transaction
  app.post('/api/v1/tx', (req, res) => {
    try {
      const tx = deserializeTransaction(req.body);
      const result = node.receiveTransaction(tx);
      if (result.success) {
        res.json({ txid: tx.id });
      } else {
        sendError(res, 400, result.error ?? 'Transaction rejected');
      }
    } catch (err) {
      log.warn({ component: 'rpc', err }, 'Failed to deserialize submitted transaction');
      const message = err instanceof Error ? err.message : 'Invalid transaction';
      sendError(res, 400, message);
    }
  });

  // Endpoint to get mempool transactions (lightweight: no signatures/publicKeys, includes sender)
  app.get('/api/v1/mempool/txs', (req, res) => {
    if (req.query.limit !== undefined && !/^\d+$/.test(req.query.limit as string)) {
      sendError(res, 400, 'Invalid limit parameter');
      return;
    }
    const parsedLimit = req.query.limit ? parseInt(req.query.limit as string, 10) : 1000;
    const limit = Math.min(parsedLimit, 1000);
    const txs = node.mempool.getTransactionsForBlock(node.chain.utxoSet).slice(0, limit);
    const summaries = txs.map(summarizeMempoolTransaction);
    res.json(summaries);
  });

  // Endpoint to get mempool stats
  app.get('/api/v1/mempool/stats', (req, res) => {
    res.json({
      size: node.mempool.size(),
    });
  });

  // Endpoint to get the balance of an address
  app.get('/api/v1/address/:address/balance', (req, res) => {
    if (!isValidAddress(req.params.address)) {
      sendError(res, 400, 'Invalid address format: must be 64-character hex string');
      return;
    }
    const address = req.params.address.toLowerCase();
    const balance = node.chain.getBalance(address);
    res.json({ balance });
  });

  // Endpoint to get the UTXOs of an address
  app.get('/api/v1/address/:address/utxos', (req, res) => {
    if (!isValidAddress(req.params.address)) {
      sendError(res, 400, 'Invalid address format: must be 64-character hex string');
      return;
    }
    const address = req.params.address.toLowerCase();
    const utxos = node.chain.findUTXOs(address);
    res.json(sanitize(utxos));
  });

  // Endpoint to get claim stats
  app.get('/api/v1/claims/stats', (req, res) => {
    res.json(sanitize(node.chain.getClaimStats()));
  });

  // Endpoint to look up BTC snapshot claim eligibility by snapshot address key
  app.get('/api/v1/snapshot/address/:btcAddress', (req, res) => {
    if (!isValidSnapshotAddress(req.params.btcAddress)) {
      sendError(res, 400, 'Invalid BTC snapshot address format: must be 40- or 64-character hex string');
      return;
    }
    const btcAddress = req.params.btcAddress.toLowerCase();
    const lookup = node.chain.getSnapshotAddressLookup(btcAddress);
    if (!lookup) {
      sendError(res, 404, 'BTC address not found in snapshot');
      return;
    }
    res.json(sanitize(lookup));
  });

  // Difficulty history — one entry per adjustment interval
  app.get('/api/v1/difficulty', (req, res) => {
    const blocks = node.chain.blocks;
    const history: Array<{ height: number; target: string; timestamp: number }> = [];

    // Genesis
    history.push({ height: 0, target: STARTING_DIFFICULTY, timestamp: blocks[0].header.timestamp });

    // Each adjustment point
    for (let i = DIFFICULTY_ADJUSTMENT_INTERVAL; i < blocks.length; i += DIFFICULTY_ADJUSTMENT_INTERVAL) {
      history.push({
        height: i,
        target: blocks[i].header.target,
        timestamp: blocks[i].header.timestamp,
      });
    }

    // Current tip if not on an adjustment boundary
    const tip = blocks[blocks.length - 1];
    if (blocks.length % DIFFICULTY_ADJUSTMENT_INTERVAL !== 1) {
      history.push({ height: tip.height, target: tip.header.target, timestamp: tip.header.timestamp });
    }

    res.json(history);
  });

  // Endpoint to get connected peers (filter localhost from public API)
  app.get('/api/v1/peers', (req, res) => {
    if (p2pServer) {
      const isLocal = (addr: string) =>
        addr.includes('127.0.0.1') || addr.includes('::1') || addr.includes('localhost')
      res.json(p2pServer.getPeers().filter((p) => !isLocal(p.address)));
    } else {
      res.json([]);
    }
  });

  app.use('/api/v1', (req: Request, res: Response) => {
    sendError(res, 404, 'RPC endpoint not found');
  });

  app.use((req: Request, res: Response) => {
    sendError(res, 404, 'Route not found');
  });

  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    const requestError = err as RequestError;
    if (requestError.type === 'entity.parse.failed') {
      log.warn({ component: 'rpc', err: requestError }, 'Rejected malformed JSON request body');
      sendError(res, 400, 'Malformed JSON request body');
      return;
    }

    if (requestError.type === 'entity.too.large' || requestError.status === 413 || requestError.statusCode === 413) {
      log.warn({ component: 'rpc', err: requestError }, 'Rejected oversized JSON request body');
      sendError(res, 413, 'Request body too large');
      return;
    }

    if (res.headersSent) {
      next(err);
      return;
    }

    log.error({ component: 'rpc', err: requestError, path: req.path, method: req.method }, 'Unhandled RPC error');
    sendError(res, 500, 'Internal server error');
  });

  return app;
}
