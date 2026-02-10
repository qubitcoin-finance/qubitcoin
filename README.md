QubitCoin integration/staging tree
===================================
https://qubitcoin.finance

For a live block explorer and network status, see https://qubitcoin.finance.

What is QubitCoin?
------------------

QubitCoin (QTC) is a post-quantum Bitcoin fork using ML-DSA-65 (Dilithium, FIPS 204) instead of ECDSA secp256k1 for all transaction signatures. SHA-256 proof-of-work is retained — it is already quantum-resistant due to Grover's quadratic limit (256-bit security → 128-bit effective).

BTC holders can claim QTC by proving ECDSA ownership of their Bitcoin address. The fork genesis block commits to a BTC UTXO set snapshot; no coins are minted at genesis. All ongoing transactions use quantum-safe ML-DSA-65 signatures.

QubitCoin connects to the QubitCoin peer-to-peer network to download and fully validate blocks and transactions. It includes a built-in miner and a block explorer web interface.

Key properties:

- **UTXO model** — Bitcoin-style unspent transaction outputs
- **ML-DSA-65 signatures** — NIST FIPS 204 post-quantum standard (Dilithium)
- **SHA-256 PoW** — Bitcoin-compatible mining
- **ECDSA claims** — One-time BTC ownership proofs for claiming QTC
- **3.125 QTC block reward** — Matching BTC's current subsidy, halving every 210,000 blocks
- **P2P networking** — Length-prefixed JSON over TCP with initial block download

License
-------

QubitCoin is released under the terms of the MIT license. See [LICENSE](LICENSE) for more information or see https://opensource.org/license/MIT.

Building
--------

QubitCoin requires Node.js (v20+) and pnpm.

```bash
pnpm install
```

Running
-------

```bash
# Start a full node with mining enabled
pnpm run qtcd

# Start with a BTC snapshot for claim support
pnpm run qtcd -- --snapshot /path/to/qtc-snapshot.jsonl

# Join the network (qubitcoin.finance is the default seed)
pnpm run qtcd
```

### qtcd CLI options

```
--port <n>              RPC port (default 3001)
--p2p-port <n>          P2P port (default 6001)
--snapshot <path>       Path to BTC snapshot NDJSON file
--datadir <path>        Data directory (default data/node)
--seeds <host:port,...> Comma-separated seed peers (default qubitcoin.finance:6001)
--mine                  Enable mining
--simulate              Dev mode: easy difficulty, fake transactions
```

### Multi-node local network

```bash
pnpm run node:alice     # Port 3001, P2P 6001, mining
pnpm run node:bob       # Port 3002, P2P 6002, seeds alice
pnpm run node:charlie   # Port 3003, P2P 6003, seeds alice+bob
```

### Block explorer

The block explorer is a static website served alongside the node's RPC API.

```bash
pnpm run website        # Start Vite dev server
pnpm run website:build  # Production build
```

Visit `http://localhost:5173` (dev) or the deployed site at https://qubitcoin.finance.

Development Process
-------------------

The `main` branch contains the latest development code. It is regularly tested but is not guaranteed to be completely stable.

Testing
-------

Testing and code review are critical. QubitCoin is a security-critical project where any mistake might cost people money.

### Automated Testing

The test suite uses [vitest](https://vitest.dev/) with 218 tests covering cryptography, transactions, blocks, chain state, mempool, storage, P2P networking, and snapshot loading.

```bash
pnpm test               # Run full test suite
pnpm run test:watch     # Watch mode
```

### Manual QA Testing

Changes should be tested by somebody other than the developer who wrote the code. For transaction testing, a dev utility is included:

```bash
# Start a node with mining
pnpm run qtcd

# In another terminal, generate random transactions
pnpm run dev:tx
```

Tech Stack
----------

- **TypeScript** — Node.js (ESM), ts-node
- **[@noble/post-quantum](https://github.com/paulmillr/noble-post-quantum)** — ML-DSA-65 (FIPS 204)
- **[@noble/curves](https://github.com/paulmillr/noble-curves)** — ECDSA secp256k1 (for BTC claims)
- **[@noble/hashes](https://github.com/paulmillr/noble-hashes)** — SHA-256, RIPEMD-160
- **Express v5** — RPC API server
- **Vite + TailwindCSS v4** — Block explorer frontend
- **vitest** — Test framework

BTC Snapshot Pipeline
---------------------

QubitCoin forks from a Bitcoin UTXO set snapshot. To generate one:

1. Run Bitcoin Core (pruned mode is fine — only the UTXO set is needed)
2. Dump the UTXO set: `bitcoin-cli dumptxoutset /path/to/utxos.dat latest`
3. Convert to QTC format:

```bash
pnpm run convert-snapshot -- --input ~/utxos.dat --output ~/qtc-snapshot.jsonl
```

The converter parses Bitcoin Core's `dumptxoutset` v2 binary format, filters to claimable output types (P2PKH, P2WPKH), aggregates by address, and produces an NDJSON file.
