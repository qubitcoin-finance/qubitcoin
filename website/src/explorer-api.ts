const API = '/api/v1';

// --- Types -----------------------------------------------------------------

export interface Status {
  name: string;
  height: number;
  mempoolSize: number;
  utxoCount: number;
  difficulty: string;
  lastBlockTime: number;
  targetBlockTime: number;
  peers: number;
  avgBlockTime: number;
  blockReward: number;
  totalTxs: number;
  hashrate: number;
}

export interface TxInput {
  txId: string;
  outputIndex: number;
  publicKey: string;
  signature: string;
}

export interface TxOutput {
  address: string;
  amount: number;
}

export interface ClaimData {
  btcAddress: string;
  ecdsaPublicKey: string;
  ecdsaSignature: string;
  qbtcAddress: string;
  schnorrPublicKey?: string;
  schnorrSignature?: string;
  witnessScript?: string;
  witnessSignatures?: string;
}

export interface Transaction {
  id: string;
  inputs: TxInput[];
  outputs: TxOutput[];
  timestamp: number;
  blockHash?: string;
  blockHeight?: number;
  confirmations?: number;
  claimData?: ClaimData;
}

export interface BlockHeader {
  version: number;
  previousHash: string;
  merkleRoot: string;
  timestamp: number;
  target: string;
  nonce: number;
}

export interface Block {
  hash: string;
  height: number;
  header: BlockHeader;
  transactions: Transaction[];
}

export interface MempoolTx {
  id: string;
  timestamp: number;
  sender: string | null;
  inputs: { txId: string; outputIndex: number }[];
  outputs: TxOutput[];
  claimData?: ClaimData;
}

export interface ClaimStats {
  btcBlockHeight: number;
  btcBlockHash: string;
  genesisHash: string;
  totalEntries: number;
  claimed: number;
  unclaimed: number;
  claimedAmount: number;
  unclaimedAmount: number;
}

export interface SnapshotAddressLookup {
  btcAddress: string;
  amount: number;
  type: 'p2pkh' | 'p2sh' | 'p2tr' | 'p2wsh' | 'multisig';
  claimed: boolean;
  claimedBy: string | null;
}

export interface UTXO {
  txId: string;
  outputIndex: number;
  address: string;
  amount: number;
}

// --- API layer -------------------------------------------------------------

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; networkError: false }
  | { ok: false; status: 0; networkError: true };

/** Log errors with context for debugging */
function logApiError(path: string, error: Error | string, statusCode?: number): void {
  const timestamp = new Date().toISOString();
  const msg = typeof error === 'string' ? error : error.message;
  const details = statusCode ? ` (HTTP ${statusCode})` : '';
  console.error(`[${timestamp}] API Error: ${path}${details} — ${msg}`);
}

export async function apiFull<T>(path: string): Promise<ApiResult<T>> {
  try {
    const res = await fetch(`${API}${path}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      logApiError(path, `HTTP ${res.status}: ${res.statusText}`, res.status);
      return { ok: false, status: res.status, networkError: false };
    }
    return { ok: true, data: (await res.json()) as T };
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    logApiError(path, error);
    return { ok: false, status: 0, networkError: true };
  }
}

async function api<T>(path: string): Promise<T | null> {
  const result = await apiFull<T>(path);
  return result.ok ? result.data : null;
}

export const fetchStatus = () => api<Status>('/status');
export const fetchBlocks = (count = 10) => api<Block[]>(`/blocks?count=${count}`);
export const fetchBlock = (hash: string) => api<Block>(`/block/${hash}`);
export const fetchTx = (txid: string) => api<Transaction>(`/tx/${txid}`);
export const fetchMempoolTxs = (limit?: number) => api<MempoolTx[]>(limit ? `/mempool/txs?limit=${limit}` : '/mempool/txs');
export const fetchMempoolStats = () => api<{ size: number }>('/mempool/stats');
export const fetchBalance = (addr: string) => api<{ balance: number }>(`/address/${addr}/balance`);
export const fetchUtxos = (addr: string) => api<UTXO[]>(`/address/${addr}/utxos`);
export const fetchClaimStats = () => api<ClaimStats>('/claims/stats');
export const fetchSnapshotAddress = (btcAddress: string) =>
  apiFull<SnapshotAddressLookup>(`/snapshot/address/${encodeURIComponent(btcAddress)}`);

export async function broadcastTransaction(tx: unknown): Promise<ApiResult<{ txid: string }>> {
  try {
    const res = await fetch(`${API}/tx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tx),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      logApiError('/tx', `HTTP ${res.status}: ${res.statusText}`, res.status);
      return { ok: false, status: res.status, networkError: false };
    }
    return { ok: true, data: (await res.json()) as { txid: string } };
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    logApiError('/tx', error);
    return { ok: false, status: 0, networkError: true };
  }
}
