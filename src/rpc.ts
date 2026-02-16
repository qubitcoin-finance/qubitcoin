
import express from 'express';
import { Node } from './node.js';
import { bytesToHex, hexToBytes } from './crypto.js';
import cors from 'cors';
import type { P2PServer } from './p2p/server.js';
import { type Transaction, type TransactionInput, type ClaimData, isClaimTransaction, COINBASE_TXID } from './transaction.js';
import { deriveAddress } from './crypto.js';
import { DIFFICULTY_ADJUSTMENT_INTERVAL, STARTING_DIFFICULTY } from './block.js';
import { log } from './log.js';
import type { Request, Response, NextFunction } from 'express';

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

/** Recursively convert Uint8Array fields to hex strings for JSON serialization */
export function sanitize(obj: unknown): unknown {
  if (obj instanceof Uint8Array) return bytesToHex(obj);
  if (Array.isArray(obj)) return obj.map(sanitize);
  if (obj !== null && typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = sanitize(v);
    }
    return out;
  }
  return obj;
}

/** Known Uint8Array fields in transactions that need deserialization */
const TX_INPUT_BINARY_FIELDS = ['publicKey', 'signature'] as const;
const CLAIM_DATA_BINARY_FIELDS = ['ecdsaPublicKey', 'ecdsaSignature', 'schnorrPublicKey', 'schnorrSignature', 'witnessScript', 'witnessSignatures'] as const;

function deserializeTransaction(raw: Record<string, unknown>): Transaction {
  const tx = raw as unknown as Transaction;
  if (Array.isArray(raw.inputs)) {
    tx.inputs = raw.inputs.map((inp: Record<string, unknown>) => {
      const input = inp as unknown as TransactionInput;
      for (const field of TX_INPUT_BINARY_FIELDS) {
        if (typeof inp[field] === 'string') {
          (input as Record<string, unknown>)[field] = hexToBytes(inp[field] as string);
        }
      }
      return input;
    });
  }
  if (raw.claimData && typeof raw.claimData === 'object') {
    const cd = raw.claimData as Record<string, unknown>;
    for (const field of CLAIM_DATA_BINARY_FIELDS) {
      if (typeof cd[field] === 'string') {
        (cd as Record<string, unknown>)[field] = hexToBytes(cd[field] as string);
      }
    }
    tx.claimData = cd as unknown as ClaimData;
  }
  return tx;
}

export function startRpcServer(node: Node, port: number, p2pServer?: P2PServer, bindAddress: string = '127.0.0.1') {
  const app = express();
  app.use(cors());
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
    const block = node.chain.blocks.find(b => b.hash === req.params.hash);
    if (block) {
      res.json(sanitize(block));
    } else {
      res.status(404).json({ error: 'Block not found' });
    }
  });

  // Endpoint to get a block by height
  app.get('/api/v1/block-by-height/:height', (req, res) => {
    const height = parseInt(req.params.height, 10);
    if (isNaN(height) || height < 0 || height >= node.chain.blocks.length) {
      res.status(404).json({ error: 'Block not found' });
      return;
    }
    res.json(sanitize(node.chain.blocks[height]));
  });

  // Endpoint to get the latest blocks
  app.get('/api/v1/blocks', (req, res) => {
    const count = req.query.count ? parseInt(req.query.count as string, 10) : 10;
    const blocks = [...node.chain.blocks].reverse().slice(0, count);
    res.json(sanitize(blocks));
  });

  // Endpoint to get a transaction by its ID
  app.get('/api/v1/tx/:txid', (req, res) => {
    const tx = node.mempool.getTransaction(req.params.txid);
    if (tx) {
      res.json(sanitize(tx));
      return;
    }
    // Look in the chain
    for (const block of node.chain.blocks) {
      const foundTx = block.transactions.find(t => t.id === req.params.txid);
      if (foundTx) {
        res.json(sanitize(foundTx));
        return;
      }
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
      res.status(400).json({ error: 'Invalid transaction' });
    }
  });

  // Endpoint to get mempool transactions (lightweight: no signatures/publicKeys, includes sender)
  app.get('/api/v1/mempool/txs', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 1000, 1000);
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
    const balance = node.chain.getBalance(req.params.address);
    res.json({ balance });
  });

  // Endpoint to get the UTXOs of an address
  app.get('/api/v1/address/:address/utxos', (req, res) => {
    const utxos = node.chain.findUTXOs(req.params.address);
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

  // Endpoint to get connected peers
  app.get('/api/v1/peers', (req, res) => {
    if (p2pServer) {
      res.json(p2pServer.getPeers());
    } else {
      res.json([]);
    }
  });

  app.listen(port, bindAddress, () => {
    log.info({ component: 'rpc', port, bind: bindAddress, url: `http://${bindAddress}:${port}` }, 'RPC server listening');
  });

  return app;
}
