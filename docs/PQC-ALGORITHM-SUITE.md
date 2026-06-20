# PQC Algorithm Suite

This doc explains the standalone post-quantum cryptography demo and benchmark suite (`src/index.ts`, `src/ml-kem-demo.ts`, `src/ml-dsa-demo.ts`, `src/slh-dsa-demo.ts`, `src/hybrid-demo.ts`, `src/benchmark.ts`) and why QubitCoin picked **ML-DSA-65** for consensus signatures over the other NIST FIPS 203/204/205 candidates it can also run. Read it when working on the `start`/`kem`/`sign`/`hash-sign`/`hybrid`/`bench` package scripts, when comparing algorithm key/signature sizes and speeds, or when explaining the ML-DSA-65 consensus choice to a newcomer.

This suite is **educational and exploratory** — it is not on any consensus path. The production signature scheme lives in `src/crypto.ts` (see [CRYPTO-PRIMITIVES](./CRYPTO-PRIMITIVES.md)). These demos exist so the tradeoff that fixed that choice can be re-run and re-measured, not just asserted.

## Why it exists

QubitCoin's whole premise is that Bitcoin's ECDSA signatures are breakable by a sufficiently large quantum computer (Shor's algorithm), so the fork replaces them with a NIST-standardized post-quantum scheme. But "post-quantum" is not one algorithm — NIST standardized three in 2024:

- **FIPS 203 / ML-KEM** (CRYSTALS-Kyber) — key encapsulation, not signatures.
- **FIPS 204 / ML-DSA** (CRYSTALS-Dilithium) — lattice-based signatures.
- **FIPS 205 / SLH-DSA** (SPHINCS+) — hash-based signatures.

A blockchain needs *signatures* (every transaction input is signed), so ML-KEM is out of scope for consensus by construction — it is a key-exchange primitive. That leaves ML-DSA vs SLH-DSA, and within ML-DSA the 44/65/87 security tiers. The demo suite makes the size/speed cost of each visible so the choice is grounded in measured numbers rather than folklore. The classical reference rows in the benchmark (RSA-2048, ECDSA-P256, Ed25519, X25519) anchor just how much bigger post-quantum keys and signatures are — the price of quantum resistance.

## Key files

| Path | Symbol | Role |
|------|--------|------|
| `src/index.ts` | top-level script | Runs all four demos then the benchmark, in order |
| `src/ml-kem-demo.ts:20` | `runMlKemDemo()` | ML-KEM-512/768/1024 keygen→encapsulate→decapsulate round trip |
| `src/ml-dsa-demo.ts:26` | `runMlDsaDemo()` | ML-DSA-44/65/87 sign/verify, incl. empty + 10k-char + tampered messages |
| `src/slh-dsa-demo.ts:29` | `runSlhDsaDemo()` | SLH-DSA-SHA2 128f/128s/256f sign/verify + tamper check |
| `src/hybrid-demo.ts:14` | `runHybridDemo()` | X25519 + ML-KEM-768 combined KEM, with overhead-vs-classical size print |
| `src/benchmark.ts:153` | `runBenchmark()` | Times all KEM + signature variants, prints speed + size tables |
| `src/benchmark.ts:51` | `benchKem()` | Warmup + N-iteration timing loop for a KEM algorithm |
| `src/benchmark.ts:98` | `benchSig()` | Warmup + N-iteration timing loop for a signature algorithm |
| `src/benchmark.ts:34` | `KemAlgorithm` / `SigAlgorithm` | Structural interfaces the noble algorithms satisfy |
| `src/utils.ts:19` | `banner()` | Section header printer used by every demo |
| `src/utils.ts:32` | `timeIt()` | `{ result, ms }` micro-timer wrapping a thunk |
| `src/utils.ts:14` | `truncHex()` | Truncated hex preview of a `Uint8Array` |
| `src/utils.ts:26` | `sizeLabel()` | Byte/KB size label for a `Uint8Array` |

All algorithm implementations come from `@noble/post-quantum` (`ml-kem.js`, `ml-dsa.js`, `slh-dsa.js`, `hybrid.js`). The demos call them directly; this is the one place in the repo where calling `@noble/post-quantum` outside `src/crypto.ts` is acceptable, because none of this code runs on a consensus path.

## How to run it

Each demo is a directly-executable module (each file ends with a self-invoking call), and `package.json` wires the same files to short script names:

```text
pnpm start        # src/index.ts — all four demos + benchmark
pnpm kem          # src/ml-kem-demo.ts
pnpm sign         # src/ml-dsa-demo.ts
pnpm hash-sign    # src/slh-dsa-demo.ts
pnpm hybrid       # src/hybrid-demo.ts
pnpm bench        # src/benchmark.ts
```

These run through `node --loader ts-node/esm` with `transpileOnly`, so they do not typecheck — run `pnpm build` after editing them if you touch imports or shared types. They print to `console.log`, which is allowed here under the project's CLI/demo exception (these are not long-running node, RPC, mempool, chain, or P2P paths).

## How it works

Every demo follows the same shape so the output reads as an apples-to-apples comparison:

1. `banner()` prints the FIPS section header.
2. For each variant, `timeIt()` wraps `keygen()`, then the primitive operation, then verification.
3. Sizes are reported with `sizeLabel()` and key/secret previews with `truncHex()`.
4. A correctness assertion closes each variant — shared-secret equality for KEMs, `verify === true` plus a tampered-input `verify === false` for signatures.

### KEM demos (ML-KEM, hybrid)

`runMlKemDemo()` walks ML-KEM-512/768/1024 (AES-128/192/256-equivalent tiers). Alice runs `algo.keygen()`; Bob runs `algo.encapsulate(publicKey)` producing `{ cipherText, sharedSecret }`; Alice runs `algo.decapsulate(cipherText, secretKey)` and the demo asserts both sides derived byte-identical shared secrets.

`runHybridDemo()` does the same with `ml_kem768_x25519`, which concatenates a classical X25519 exchange with ML-KEM-768. The point is defense-in-depth: an attacker must break *both* X25519 and ML-KEM to recover the shared secret, so a future flaw in either primitive alone is survivable. The demo ends by printing the public-key overhead versus a bare 32-byte X25519 key — the concrete cost of running both. This is the same construction Chrome and Cloudflare ship in TLS 1.3.

### Signature demos (ML-DSA, SLH-DSA)

`runMlDsaDemo()` walks ML-DSA-44/65/87 (~128/192/256-bit) and signs three messages per variant: a normal string, the empty string (edge case), and a 10,000-character string (large input). For each it signs, verifies the valid signature, then re-verifies against a tampered message and asserts rejection.

`runSlhDsaDemo()` walks SLH-DSA-SHA2 128f/128s/256f. The `f`/`s` suffix is the SPHINCS+ fast-vs-small tradeoff: `f` ("fast") signs quicker but produces larger signatures; `s` ("small") produces smaller signatures but signs much slower. Both rest only on hash-function security — no lattice hardness assumption — which is the conservative appeal of SLH-DSA.

### The benchmark

`runBenchmark()` is the synthesis view. It runs `benchKem()` over the three ML-KEM variants plus the X25519 hybrid, and `benchSig()` over ML-DSA-44/65/87 plus SLH-DSA-SHA2-128f/128s. Each helper does a warmup round (to avoid first-call JIT skew) then averages keygen + two operations over `iterations` (default 10). It prints two tables — average milliseconds per operation, and public-key/secret-key/output sizes — followed by classical RSA/ECDSA/Ed25519/X25519 reference sizes, each flagged as quantum-broken.

```text
KEM:        keygen → encapsulate → decapsulate     output = ciphertext
Signature:  keygen → sign        → verify          output = signature
```

## The consensus choice: why ML-DSA-65

The benchmark exists to justify one decision: consensus signatures are **ML-DSA-65** (`ml_dsa65`, the FIPS 204 ~192-bit tier). The reasoning the suite makes visible:

- **Signatures, not KEM.** Transactions are signed, so ML-KEM/hybrid are irrelevant to consensus — they live in the suite only to round out the FIPS 203/204/205 picture.
- **ML-DSA over SLH-DSA on size.** SLH-DSA signatures are an order of magnitude larger (tens of KB vs a few KB for ML-DSA). Every transaction input carries a signature and every block carries many inputs, so signature bytes directly drive block size and bandwidth. The hash-based conservatism of SLH-DSA is not worth a ~10× per-input blowup for a high-throughput ledger. SLH-DSA suits rare, high-value signing (firmware, root CAs), not per-transaction use.
- **ML-DSA-65 over 44/87.** ML-DSA-44 trims size/speed at lower security margin; ML-DSA-87 maximizes margin at larger size and slower verify. ML-DSA-65 is the middle tier — ~192-bit security with moderate sizes — matching the long-lived, adversarial setting of a chain meant to outlast cryptographically-relevant quantum computers.

The production path consumes only ML-DSA-65; the secp256k1 ECDSA/Schnorr code in `src/crypto.ts` exists separately for verifying *Bitcoin* ownership proofs during BTC→QBTC claims (see [CLAIM-FLOW](./CLAIM-FLOW.md)), not for native QubitCoin signing.

## Invariants and edge cases

- **Not consensus code.** Nothing here is imported by `node.ts`, `chain.ts`, `transaction.ts`, or `crypto.ts`. Changing a demo cannot change consensus behavior; changing consensus signatures means editing `src/crypto.ts`, not these files.
- **Self-invoking modules.** Each demo file ends by calling its own `runXxx()` so `pnpm <script>` works. Importing `runMlDsaDemo` from elsewhere will *also* trigger that bottom-of-file call as a side effect — these modules are not side-effect-free.
- **`@noble/post-quantum` direct calls are confined here.** Outside this suite and `src/crypto.ts`, business logic must go through `src/crypto.ts` (project crypto convention). Do not copy the direct `ml_dsa65.sign(...)` style from a demo into chain/mempool/RPC code.
- **`transpileOnly` means no typecheck.** The `ts-node` loader skips type errors. After editing imports or the shared `KemAlgorithm`/`SigAlgorithm` interfaces, run `pnpm build` to typecheck.
- **`console.log` is intentional.** These are terminal-UX demos under the CLAUDE.md CLI/demo exception. The pino `log` rule (`src/log.ts`) applies to long-running services, not here.
- **Benchmark numbers are machine-relative.** `iterations` defaults to 10 with a single warmup; absolute milliseconds vary by host and Node version. Treat the *ratios* between algorithms as the signal, not the raw times.

## Cross-references

- [CRYPTO-PRIMITIVES](./CRYPTO-PRIMITIVES.md) — the production `src/crypto.ts`: ML-DSA-65 consensus signing/verification, plus secp256k1 ECDSA/Schnorr for BTC claims.
- [TRANSACTION-ANATOMY](./TRANSACTION-ANATOMY.md) — where ML-DSA-65 signatures attach to transaction inputs and how signature size affects fee/size math.
- [CLAIM-FLOW](./CLAIM-FLOW.md) — the secp256k1 side: proving ownership of Bitcoin outputs during BTC→QBTC claims.
- [TEST-HARNESS](./TEST-HARNESS.md) — why real ML-DSA keys (never mocked) are generated in fixtures, and why that makes the backend tests slow.
