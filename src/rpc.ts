
import express from 'express';
import { Node } from './node.js';
import { deriveAddress } from './crypto.js';
import cors from 'cors';
import type { P2PServer } from './p2p/server.js';
import { type Transaction, isClaimTransaction, COINBASE_TXID } from './transaction.js';
import { deserializeTransaction } from './storage.js';
import { DIFFICULTY_ADJUSTMENT_INTERVAL, STARTING_DIFFICULTY } from './block.js';
import { log } from './log.js';
import { isValidHash, sanitize } from './utils.js';
import type { Request, Response, NextFunction, Express } from 'express';

/** Maximum JSON body size (1 MB) */
const MAX_BODY_SIZE = '1mb';

/** Rate limit windows */
const GET_RATE_LIMIT = 600;   // requests per minute
const POST_RATE_LIMIT = 100;  // requests per minute
const RATE_WINDOW_MS = 60_000;

/** Simple in-memory per-IP rate limiter (sliding window) */
function createRateLimiter() {
  const hits = new Map<string, { timestamps: number[] }>();

  // Cleanup stale entries every 5 minutes
  setInterval(() => {
    const cutoff = Date.now() - RATE_WINDOW_MS;
    for (const [ip, data] of hits) {
      data.timestamps = data.timestamps.filter(t => t > cutoff);
      if (data.timestamps.length === 0) hits.delete(ip);
    }
  }, 5 * 60_000).unref();

  return (limit: number) => (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    const cutoff = now - RATE_WINDOW_MS;

    let data = hits.get(ip);
    if (!data) {
      data = { timestamps: [] };
      hits.set(ip, data);
    }

    // Remove old timestamps
    data.timestamps = data.timestamps.filter(t => t > cutoff);

    if (data.timestamps.length >= limit) {
      res.status(429).json({ error: 'Too many requests' });
      return;
    }

    data.timestamps.push(now);
    next();
  };
}

export { sanitize };

/** Validate that an address is a valid 64-character hex string */
function isValidAddress(address: string): boolean {
  return typeof address === 'string' && address.length === 64 && /^[0-9a-f]{64}$/i.test(address);
}

type RequestError = Error & {
  status?: number;
  statusCode?: number;
  type?: string;
};

export function startRpcServer(node: Node, port: number, p2pServer?: P2PServer, bindAddress: string = '127.0.0.1'): Express {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(cors({ origin: bindAddress === '127.0.0.1' ? true : false }));
  app.use(express.json({ limit: MAX_BODY_SIZE }));

  // Rate limiting
  const rateLimiter = createRateLimiter();
  app.use((req: Request, res: Response, next: NextFunction) => {
    const limit = req.method === 'POST' ? POST_RATE_LIMIT : GET_RATE_LIMIT;
    rateLimiter(limit)(req, res, next);
  });

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
      res.status(400).json({ error: 'Invalid block hash format: must be 64-character hex string' });
      return;
    }
    const block = node.chain.blocks.find(b => b.hash === hash);
    if (block) {
      res.json(sanitize(block));
    } else {
      res.status(404).json({ error: 'Block not found' });
    }
  });

  // Endpoint to get a block by height
  app.get('/api/v1/block-by-height/:height', (req, res) => {
    if (!/^\d+$/.test(req.params.height)) {
      res.status(400).json({ error: 'Invalid height: must be a non-negative integer' });
      return;
    }
    const height = parseInt(req.params.height, 10);
    if (height > 2_147_483_647) {
      res.status(400).json({ error: 'Invalid height: value too large' });
      return;
    }
    if (height >= node.chain.blocks.length) {
      res.status(404).json({ error: 'Block not found' });
      return;
    }
    res.json(sanitize(node.chain.blocks[height]));
  });

  // Endpoint to get the latest blocks
  app.get('/api/v1/blocks', (req, res) => {
    if (req.query.count !== undefined && !/^\d+$/.test(req.query.count as string)) {
      res.status(400).json({ error: 'Invalid count parameter' });
      return;
    }
    const parsed = req.query.count ? parseInt(req.query.count as string, 10) : 10;
    const count = Math.min(parsed, 100);
    const blocks = [...node.chain.blocks].reverse().slice(0, count);
    res.json(sanitize(blocks));
  });

  // Endpoint to get a transaction by its ID
  app.get('/api/v1/tx/:txid', (req, res) => {
    const txid = req.params.txid.toLowerCase();
    if (!isValidHash(txid)) {
      res.status(400).json({ error: 'Invalid transaction ID format: must be 64-character hex string' });
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
        res.status(404).json({ error: 'Transaction not found' });
        return;
      }
      res.json(sanitize(foundTx));
      return;
    }
    res.status(404).json({ error: 'Transaction not found' });
  });

  // Submit a transaction
  app.post('/api/v1/tx', (req, res) => {
    try {
      const tx = deserializeTransaction(req.body);
      const result = node.receiveTransaction(tx);
      if (result.success) {
        res.json({ txid: tx.id });
      } else {
        res.status(400).json({ error: result.error });
      }
    } catch (err) {
      log.warn({ component: 'rpc', err }, 'Failed to deserialize submitted transaction');
      const message = err instanceof Error ? err.message : 'Invalid transaction';
      res.status(400).json({ error: message });
    }
  });

  // Endpoint to get mempool transactions (lightweight: no signatures/publicKeys, includes sender)
  app.get('/api/v1/mempool/txs', (req, res) => {
    if (req.query.limit !== undefined && !/^\d+$/.test(req.query.limit as string)) {
      res.status(400).json({ error: 'Invalid limit parameter' });
      return;
    }
    const parsedLimit = req.query.limit ? parseInt(req.query.limit as string, 10) : 1000;
    const limit = Math.min(parsedLimit, 1000);
    const txs = node.mempool.getTransactionsForBlock().slice(0, limit);
    const summaries = txs.map(tx => {
      const isCoinbase = tx.inputs.length === 1 && tx.inputs[0].txId === COINBASE_TXID;
      const isClaim = isClaimTransaction(tx);
      let sender: string | null = null;
      if (!isCoinbase && !isClaim && tx.inputs[0]?.publicKey) {
        sender = deriveAddress(tx.inputs[0].publicKey);
      }
      return {
        id: tx.id,
        timestamp: tx.timestamp,
        sender,
        inputs: tx.inputs.map(i => ({ txId: i.txId, outputIndex: i.outputIndex })),
        outputs: tx.outputs,
        claimData: tx.claimData ? sanitize(tx.claimData) : undefined,
      };
    });
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
      res.status(400).json({ error: 'Invalid address format: must be 64-character hex string' });
      return;
    }
    const address = req.params.address.toLowerCase();
    const balance = node.chain.getBalance(address);
    res.json({ balance });
  });

  // Endpoint to get the UTXOs of an address
  app.get('/api/v1/address/:address/utxos', (req, res) => {
    if (!isValidAddress(req.params.address)) {
      res.status(400).json({ error: 'Invalid address format: must be 64-character hex string' });
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

  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    const requestError = err as RequestError;
    if (requestError.type === 'entity.parse.failed') {
      log.warn({ component: 'rpc', err: requestError }, 'Rejected malformed JSON request body');
      res.status(400).json({ error: 'Malformed JSON request body' });
      return;
    }

    if (requestError.type === 'entity.too.large' || requestError.status === 413 || requestError.statusCode === 413) {
      log.warn({ component: 'rpc', err: requestError }, 'Rejected oversized JSON request body');
      res.status(413).json({ error: 'Request body too large' });
      return;
    }

    next(err);
  });

  return app;
}
