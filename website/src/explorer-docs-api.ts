// ---------------------------------------------------------------------------
// QubitCoin Block Explorer - docs content: API Reference
// ---------------------------------------------------------------------------

import { methodBadge } from './explorer-format';
import { docCode, docH2, docH3, docJson, docP } from './explorer-docs-helpers';

export function renderDocsApi(): string {
  const ep = (method: string, path: string, desc: string) =>
    `<tr class="border-b border-border last:border-0">
      <td class="py-2 pr-3">${methodBadge(method)}</td>
      <td class="py-2 pr-3 font-mono text-xs text-qubit-300">${path}</td>
      <td class="py-2 text-text-muted text-xs">${desc}</td>
    </tr>`;

  return `<h1 class="text-2xl font-bold mb-6">API Reference</h1>
${docP('All endpoints are served under <span class="font-mono text-xs text-qubit-400">/api/v1</span>. The public API is available at <span class="font-mono text-xs text-qubit-400">https://qubitcoin.finance/api/v1</span>. All responses are JSON. Uint8Array fields (public keys, signatures) are serialized as hex strings.')}

${docH2('Base URL')}
${docCode(`# Local node
http://127.0.0.1:3001/api/v1

# Public seed node
https://qubitcoin.finance/api/v1`)}

${docH2('Node Status')}
<table class="w-full text-sm mb-4">
  <tbody>
    ${ep('GET', '/status', 'Full node status')}
    ${ep('GET', '/peers', 'Connected peers list')}
    ${ep('GET', '/difficulty', 'Difficulty history (one entry per adjustment + genesis + tip)')}
  </tbody>
</table>
${docH3('GET /status')}
${docP('Returns the current state of the node.')}
${docJson(`{
  "height": 1234,
  "difficulty": "0000000fff...fff",
  "mempoolSize": 3,
  "utxoCount": 5678,
  "balance": 25.0,              // mining wallet balance (if mining)
  "address": "a1b2c3...",       // mining address (if mining)
  "mining": true,
  "peers": 4,
  "hashrate": 12500,            // estimated H/s
  "avgBlockTime": 1800000,      // ms (actual average)
  "blockReward": 312500000,
  "totalTxs": 9876,
  "lastBlockTime": 1707000000000,
  "targetBlockTime": 1800000
}`)}
${docH3('GET /peers')}
${docJson(`[
  {
    "id": "peer-1",
    "address": "1.2.3.4:6001",
    "inbound": false,
    "height": 1234
  }
]`)}
${docH3('GET /difficulty')}
${docP('Returns the difficulty history — one entry per adjustment interval, plus genesis and the current tip.')}
${docJson(`[
  { "height": 0,  "target": "00000fff...", "timestamp": 1707000000000 },
  { "height": 10, "target": "00000aff...", "timestamp": 1707018000000 }
]`)}

${docH2('Blocks')}
<table class="w-full text-sm mb-4">
  <tbody>
    ${ep('GET', '/blocks?count=N', 'Latest N blocks (default 10, most recent first)')}
    ${ep('GET', '/block/:hash', 'Block by hash (full block with transactions)')}
    ${ep('GET', '/block-by-height/:h', 'Block by height')}
  </tbody>
</table>
${docH3('GET /block/:hash')}
${docJson(`{
  "hash": "0000abc...",
  "height": 1234,
  "header": {
    "version": 1,
    "previousHash": "0000def...",
    "merkleRoot": "abc123...",
    "timestamp": 1707000000000,
    "target": "0000000fff...fff",
    "nonce": 42
  },
  "transactions": [...]
}`)}

${docH2('Transactions')}
<table class="w-full text-sm mb-4">
  <tbody>
    ${ep('GET', '/tx/:txid', 'Transaction by ID (searches mempool then chain)')}
    ${ep('POST', '/tx', 'Broadcast a signed transaction')}
  </tbody>
</table>
${docH3('GET /tx/:txid')}
${docP('Returns a transaction from the mempool or chain. Confirmed transactions include server-derived <span class="font-mono text-xs text-qubit-400">blockHash</span>, <span class="font-mono text-xs text-qubit-400">blockHeight</span>, and <span class="font-mono text-xs text-qubit-400">confirmations</span>; mempool transactions omit those fields even if a submitted transaction payload included them.')}
${docJson(`{
  "id": "abc123...",
  "inputs": [...],
  "outputs": [...],
  "timestamp": 1707000000000,
  "blockHash": "0000abc...",
  "blockHeight": 1234,
  "confirmations": 42
}`)}
${docH3('POST /tx')}
${docP('Submit a signed transaction for relay and inclusion in the mempool. The request body must be a JSON transaction with hex-encoded Uint8Array fields (publicKey, signature, ecdsaPublicKey, ecdsaSignature). Malformed JSON returns a JSON 400 error payload, and request bodies larger than 1 MB return a JSON 413 error payload.')}
${docCode(`curl -X POST http://127.0.0.1:3001/api/v1/tx \\
  -H "Content-Type: application/json" \\
  -d '{"id":"...","inputs":[...],"outputs":[...],"timestamp":...}'`)}
<div class="grid grid-cols-3 gap-3 my-3">
  <div class="bg-bg rounded-lg p-3 border border-green-500/20">
    <p class="text-green-400 text-xs font-medium mb-1">200 Success</p>
    <code class="text-xs font-mono text-text-muted">{ "txid": "abc123..." }</code>
  </div>
  <div class="bg-bg rounded-lg p-3 border border-red-500/20">
    <p class="text-red-400 text-xs font-medium mb-1">400 Error</p>
    <code class="text-xs font-mono text-text-muted">{ "error": "Invalid transaction: ..." }</code>
  </div>
  <div class="bg-bg rounded-lg p-3 border border-orange-500/20">
    <p class="text-orange-400 text-xs font-medium mb-1">413 Error</p>
    <code class="text-xs font-mono text-text-muted">{ "error": "Request body too large" }</code>
  </div>
</div>
${docP('Malformed JSON is rejected before transaction validation with <span class="font-mono text-xs text-red-400">{ "error": "Malformed JSON request body" }</span>.')}

${docH2('Mempool')}
<table class="w-full text-sm mb-4">
  <tbody>
    ${ep('GET', '/mempool/txs?limit=N', 'Pending transactions (lightweight: no sigs/pubkeys, max 1000)')}
    ${ep('GET', '/mempool/stats', 'Mempool size')}
  </tbody>
</table>
${docH3('GET /mempool/txs')}
${docP('Returns a lightweight representation of pending transactions — signatures and public keys are stripped to reduce payload size.')}
${docJson(`[
  {
    "id": "abc123...",
    "timestamp": 1707000000000,
    "sender": "def456...",         // derived from first input pubkey
    "inputs": [
      { "txId": "...", "outputIndex": 0 }
    ],
    "outputs": [
      { "address": "...", "amount": 150000000 }
    ],
    "claimData": null              // or ClaimData object
  }
]`)}

${docH2('Addresses')}
<table class="w-full text-sm mb-4">
  <tbody>
    ${ep('GET', '/address/:addr/balance', 'Total balance for an address')}
    ${ep('GET', '/address/:addr/utxos', 'All unspent outputs for an address')}
  </tbody>
</table>
${docH3('GET /address/:addr/balance')}
${docJson(`{ "balance": 1562500000 }`)}
${docH3('GET /address/:addr/utxos')}
${docJson(`[
  { "txId": "abc...", "outputIndex": 0, "address": "def...", "amount": 312500000 },
  { "txId": "ghi...", "outputIndex": 1, "address": "def...", "amount": 1250000000 }
]`)}

${docH2('Claims')}
<table class="w-full text-sm mb-4">
  <tbody>
    ${ep('GET', '/claims/stats', 'Claim statistics for the BTC snapshot')}
  </tbody>
</table>
${docH3('GET /claims/stats')}
${docJson(`{
  "btcBlockHeight": 935941,
  "totalEntries": 43235452,
  "claimed": 12,
  "unclaimed": 43235440,
  "claimedAmount": 15050000000,
  "unclaimedAmount": 1273682987000000
}`)}

${docH2('Error Handling')}
${docP('All endpoints return standard HTTP status codes:')}
<ul class="text-text-secondary text-sm leading-relaxed mb-3 list-disc list-inside space-y-1">
  <li><span class="font-mono text-xs text-green-400">200</span> — success</li>
  <li><span class="font-mono text-xs text-yellow-400">400</span> — bad request (invalid transaction, malformed JSON, malformed input)</li>
  <li><span class="font-mono text-xs text-orange-400">413</span> — request body too large (JSON body exceeds 1 MB limit)</li>
  <li><span class="font-mono text-xs text-red-400">404</span> — resource not found (block or tx)</li>
  <li><span class="font-mono text-xs text-red-400">500</span> — internal server error</li>
</ul>`;
}
