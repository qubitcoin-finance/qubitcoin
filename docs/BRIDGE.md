# QBTC-Base ZK Bridge Architecture

**Author:** Q. Nakamori (a.k.a. The Q)
**Status:** Design Document
**Date:** 2026-02-26

## Problem

QBTC uses ML-DSA-65 (Dilithium) post-quantum signatures: 1,952-byte public keys, 3,309-byte signatures. These cannot be verified natively in the EVM — there are no precompiles for lattice-based cryptography, and implementing ML-DSA-65 in Solidity would cost tens of millions of gas.

To bridge QBTC tokens to Base L2 (and back), we use a ZK bridge: prove ML-DSA-65 signature validity off-chain in SP1 zkVM, compress to a Groth16 SNARK, and verify on Base for ~270K gas (~$0.05-0.10).

## Key Insight

**SP1 already has a working ML-DSA-65/Dilithium ZK circuit** — ~22 second proofs, ~260-byte output. ML-DSA-65 verification compiles to RISC-V and runs inside SP1's STARK prover. The STARK is then recursively compressed to Groth16 for on-chain verification. This makes the bridge feasible today.

---

## 1. Bridge Overview

```
QBTC Chain                          Base L2
┌──────────────┐                    ┌──────────────────┐
│              │    Lock QBTC       │                  │
│  Bridge Vault│◄───────────────    │   wQBTC (ERC20)  │
│  (unspendable│                    │                  │
│   address)   │    SP1 Proof       │   QBTCBridge.sol │
│              │───────────────►    │   (verify proof, │
│              │                    │    mint wQBTC)    │
│              │    Burn wQBTC      │                  │
│              │◄───────────────    │   (burn wQBTC,   │
│              │    SP1 Proof       │    emit event)   │
│              │───────────────►    │                  │
│  Unlock QBTC │                    │                  │
│              │────────────────►   │                  │
└──────────────┘                    └──────────────────┘
        ▲                                   ▲
        │           Relayer                 │
        │     ┌───────────────┐             │
        └─────│ Polls QBTC    │─────────────┘
              │ Monitors Base  │
              │ Generates SP1  │
              │ proofs         │
              └───────────────┘
```

### Lock/Mint (QBTC → Base)

1. User sends QBTC to the bridge vault address with `BridgeLockData` (destination Base address, amount)
2. Transaction is mined and finalized (6 blocks, ~60 min)
3. Relayer detects the lock transaction via QBTC RPC
4. Relayer generates an SP1 proof (ML-DSA-65 sig validity + tx inclusion + finality)
5. SP1 STARK is compressed to Groth16 SNARK (~260 bytes)
6. Relayer submits Groth16 proof to `QBTCBridge.sol` on Base
7. Bridge contract verifies proof via `ecPairing` precompile, mints wQBTC to the destination address

### Burn/Unlock (Base → QBTC)

1. User calls `QBTCBridge.burn(amount, qbtcAddress)` on Base, burning wQBTC
2. `BurnInitiated` event is emitted with burn ID, amount, and QBTC destination
3. Relayer detects the event, waits for L1 finality (~12 min)
4. Relayer generates SP1 proof (burn event receipt in Base block + L1 finality)
5. Relayer submits unlock transaction to QBTC chain with `BridgeUnlockData` + Groth16 proof
6. QBTC node verifies the Groth16 proof using `@noble/curves` bn254 pairing
7. QBTC chain releases funds from vault to the destination address

---

## 2. SP1 ZK Circuits

Two Rust programs compiled to RISC-V, executed inside SP1 zkVM. Each proves a specific bridge direction.

### 2.1 Lock Circuit (QBTC → Base)

Proves three things:

**a) ML-DSA-65 signature validity (~22s, the expensive part)**
- Public inputs: QBTC address (SHA-256 of ML-DSA-65 pubkey), transaction sighash
- Private witness: ML-DSA-65 public key (1,952 bytes), signature (3,309 bytes)
- Verifies: `ml_dsa_65::verify(publicKey, sighash, signature) == true`
- Verifies: `SHA256(publicKey) == address` (binds key to address)

**b) Transaction validity**
- Proves the lock transaction structure is correct:
  - Input UTXOs exist and are owned by the signer
  - Output sends to `BRIDGE_VAULT_ADDRESS` with correct amount
  - `BridgeLockData` contains valid Base destination address and lock nonce
  - Amounts balance: `sum(inputs) == sum(outputs) + fee`

**c) Finality (merkle proof + 6-block PoW chain)**
- Proves the lock transaction is included in a finalized QBTC block:
  - Transaction ID is in the block's merkle tree (merkle proof against `merkleRoot`)
  - Block hash meets its target (`hashMeetsTarget(hash, target)`)
  - 6 subsequent blocks exist, each with valid PoW and sequential heights
  - Cumulative work exceeds minimum threshold

**Public outputs** (committed in the proof, verified on Base):
```
lockTxId:        bytes32   — QBTC transaction ID
vaultAddress:    bytes32   — BRIDGE_VAULT_ADDRESS (constant, sanity check)
recipient:       address   — Base destination (20 bytes)
amount:          uint256   — Locked amount in satoshis
lockNonce:       uint256   — Monotonic nonce for ordering
qbtcBlockHash:   bytes32   — Block containing the lock tx
qbtcBlockHeight: uint256   — Height of that block
```

### 2.2 Burn Circuit (Base → QBTC)

Proves:

**a) Burn event inclusion**
- `BurnInitiated` event receipt is in a Base block (Merkle-Patricia trie proof)
- Event was emitted by the canonical `QBTCBridge` contract address
- Event contains: `burnId`, `amount`, `qbtcAddress`

**b) Base block anchored to L1**
- Base block's state root was posted to Ethereum L1 via the L2OutputOracle (or equivalent)
- L1 block containing the state root is finalized (~12 min, 2 epochs)

**Public outputs** (committed in the proof, verified on QBTC chain):
```
burnId:          uint256   — Unique burn identifier
amount:          uint256   — Burned amount in satoshis
qbtcAddress:     bytes32   — QBTC destination address (64-char hex)
baseBlockHash:   bytes32   — Base block containing the burn event
l1BlockNumber:   uint256   — L1 block anchoring the Base state
```

### 2.3 Proof Compression Pipeline

```
SP1 Execution (RISC-V)
    │
    ▼
SP1 STARK proof (~large)
    │
    ▼
Recursive STARK compression (SP1 built-in)
    │
    ▼
Groth16 wrapping (SP1 → Groth16)
    │
    ▼
~260 bytes: (π_a, π_b, π_c) + public inputs
    │
    ▼
On-chain verification via ecPairing precompile (0x08)
```

Both circuits use the same pipeline. SP1's `ProverClient` handles the full compression:

```rust
// Pseudocode — SP1 proof generation
let client = ProverClient::new();
let (pk, vk) = client.setup(LOCK_ELF);
let stdin = SP1Stdin::new();
stdin.write(&lock_tx);
stdin.write(&merkle_proof);
stdin.write(&block_headers);

// Generate compressed Groth16 proof
let proof = client.prove(&pk, &stdin)
    .groth16()  // Compress to Groth16
    .run()?;

// ~260 bytes, verifiable on-chain
let proof_bytes = proof.bytes();
let public_values = proof.public_values;
```

---

## 3. Smart Contracts (Base)

### 3.1 SP1Groth16Verifier.sol

Auto-generated by SP1 toolchain. Uses the `ecPairing` precompile (address `0x08`) defined in EIP-197. Verifies a single Groth16 proof against a verification key baked into the contract.

- **Gas cost:** ~270K (dominated by the bn254 pairing check)
- **Deployment:** One-time, immutable after deploy
- **Verification key:** Derived from the SP1 circuit, embedded at deploy time

```solidity
// Auto-generated — simplified interface
contract SP1Groth16Verifier {
    // Verification key components (set at deployment)
    uint256[2] public vk_alpha;
    uint256[2][2] public vk_beta;
    uint256[2][2] public vk_gamma;
    uint256[2][2] public vk_delta;
    uint256[2][] public vk_ic;

    function verifyProof(
        uint256[2] memory a,
        uint256[2][2] memory b,
        uint256[2] memory c,
        uint256[] memory publicInputs
    ) public view returns (bool);
}
```

### 3.2 QBTCBridge.sol

Core bridge contract. Manages lock verification, wQBTC minting, and burn initiation.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {WrappedQBTC} from "./WrappedQBTC.sol";
import {SP1Groth16Verifier} from "./SP1Groth16Verifier.sol";

contract QBTCBridge {
    WrappedQBTC public immutable wqbtc;
    SP1Groth16Verifier public immutable verifier;

    // Replay protection — each QBTC lock tx can only be processed once
    mapping(bytes32 => bool) public processedLocks;

    // Burn tracking
    uint256 public nextBurnId;

    // Events
    event LockProcessed(
        bytes32 indexed lockTxId,
        address indexed recipient,
        uint256 amount,
        uint256 qbtcBlockHeight
    );
    event BurnInitiated(
        uint256 indexed burnId,
        address indexed burner,
        uint256 amount,
        bytes32 qbtcAddress
    );

    constructor(address _wqbtc, address _verifier) {
        wqbtc = WrappedQBTC(_wqbtc);
        verifier = SP1Groth16Verifier(_verifier);
    }

    /// @notice Process a QBTC lock — verify proof and mint wQBTC
    /// @param proof Groth16 proof bytes (a, b, c components)
    /// @param publicInputs Public values from the SP1 proof
    function processLock(
        bytes calldata proof,
        uint256[] calldata publicInputs
    ) external {
        // Decode public inputs
        bytes32 lockTxId = bytes32(publicInputs[0]);
        address recipient = address(uint160(publicInputs[2]));
        uint256 amount = publicInputs[3];

        // Replay protection
        require(!processedLocks[lockTxId], "Lock already processed");
        processedLocks[lockTxId] = true;

        // Verify Groth16 proof
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c)
            = abi.decode(proof, (uint256[2], uint256[2][2], uint256[2]));
        require(verifier.verifyProof(a, b, c, publicInputs), "Invalid proof");

        // Mint wQBTC to recipient
        wqbtc.mint(recipient, amount);

        emit LockProcessed(lockTxId, recipient, amount, publicInputs[5]);
    }

    /// @notice Burn wQBTC to unlock on QBTC chain
    /// @param amount Amount to burn (in satoshis)
    /// @param qbtcAddress Destination QBTC address (32 bytes, SHA-256 of ML-DSA-65 pubkey)
    function burn(uint256 amount, bytes32 qbtcAddress) external {
        require(amount > 0, "Zero amount");
        require(qbtcAddress != bytes32(0), "Invalid address");

        uint256 burnId = nextBurnId++;
        wqbtc.burn(msg.sender, amount);

        emit BurnInitiated(burnId, msg.sender, amount, qbtcAddress);
    }
}
```

### 3.3 WrappedQBTC.sol

ERC20 token representing bridged QBTC on Base. Uses 8 decimals to match QBTC's satoshi precision (1 QBTC = 100,000,000 satoshis).

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract WrappedQBTC is ERC20 {
    address public bridge;

    modifier onlyBridge() {
        require(msg.sender == bridge, "Only bridge");
        _;
    }

    constructor(address _bridge) ERC20("Wrapped QBTC", "wQBTC") {
        bridge = _bridge;
    }

    function decimals() public pure override returns (uint8) {
        return 8; // Match QBTC satoshi precision
    }

    function mint(address to, uint256 amount) external onlyBridge {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external onlyBridge {
        _burn(from, amount);
    }
}
```

---

## 4. QBTC Chain Changes

All changes are **consensus-critical** — changing any of these after deployment requires a coordinated chain wipe on all nodes (same as difficulty or claim maturity changes).

### 4.1 Transaction Types (`src/transaction.ts`)

New interfaces alongside existing `ClaimData`:

```typescript
// Bridge vault — SHA-256 of "QBTC_BRIDGE_VAULT_V1", provably unspendable
// No private key exists for this address; funds can only be released
// by a valid BridgeUnlockData transaction with a verified Groth16 proof.
export const BRIDGE_VAULT_ADDRESS = doubleSha256Hex(
  new TextEncoder().encode('QBTC_BRIDGE_VAULT_V1')
)

// Sentinel txid for bridge unlock inputs (same pattern as CLAIM_TXID = 'c'.repeat(64))
export const BRIDGE_UNLOCK_TXID = 'b'.repeat(64)

export interface BridgeLockData {
  baseRecipient: string    // 20-byte Ethereum address (40-char hex, no 0x prefix)
  lockNonce: number        // Monotonic nonce assigned by chain (prevents replay)
}

export interface BridgeUnlockData {
  burnId: number           // Burn ID from Base BurnInitiated event
  baseBlockHash: string    // Base block containing the burn event (64-char hex)
  l1BlockNumber: number    // L1 block anchoring the Base state
  groth16Proof: Uint8Array // Compressed proof (~260 bytes)
  publicInputs: Uint8Array // Encoded public values from SP1 proof
}

export interface Transaction {
  id: string
  inputs: TransactionInput[]
  outputs: TransactionOutput[]
  timestamp: number
  claimData?: ClaimData
  bridgeLockData?: BridgeLockData     // NEW — present for lock txs
  bridgeUnlockData?: BridgeUnlockData // NEW — present for unlock txs
}
```

**Sighash extension** — `serializeForSigning()` includes bridge data when present:

```typescript
// For lock transactions, the sighash commits to the bridge destination:
//   ...existing fields...
//   + "QBTC_BRIDGE_LOCK"
//   + baseRecipient (20 bytes)
//   + lockNonce (uint64 LE)
//
// This prevents front-running: the recipient is inside the signed message,
// so a relayer cannot redirect minted wQBTC to a different address.
```

**Transaction validation** — `validateTransaction()` adds bridge-specific checks:

- Lock tx: exactly one output to `BRIDGE_VAULT_ADDRESS`, amount >= `DUST_THRESHOLD`, amount <= `MAX_MONEY`
- Lock tx: `bridgeLockData.baseRecipient` is exactly 40 hex chars
- Lock tx: `bridgeLockData.lockNonce` matches chain's `bridgeLockNonce`
- Unlock tx: single input with `txId = BRIDGE_UNLOCK_TXID`, no ML-DSA-65 signature required
- Unlock tx: `bridgeUnlockData.groth16Proof` verifies via `bridge-verifier.ts`
- Unlock tx: output amount matches proof's committed amount
- Mutual exclusion: a transaction cannot have both `claimData` and `bridgeLockData`/`bridgeUnlockData`

### 4.2 Chain State (`src/chain.ts`)

New state fields in the `Blockchain` class, following the same pattern as `claimedBtcAddresses`:

```typescript
export class Blockchain {
  // ...existing fields...

  // Bridge state (consensus-critical)
  bridgeVaultBalance: number = 0           // Total satoshis locked in vault
  processedBurnIds: Set<number> = new Set() // Replay protection for unlocks
  bridgeLockNonce: number = 0              // Monotonic counter for lock ordering
}
```

**BlockUndo extension:**

```typescript
export interface BlockUndo {
  // ...existing fields...
  bridgeLockNonces: number[]   // Lock nonces created in this block (undo: decrement)
  bridgeUnlockBurnIds: number[] // Burn IDs processed in this block (undo: remove from set)
  bridgeVaultDelta: number     // Net vault balance change (undo: subtract)
}
```

**`applyBlock()` additions:**

For each transaction in the block:
- If `bridgeLockData` present:
  - Verify `lockNonce === this.bridgeLockNonce`
  - Increment `this.bridgeLockNonce`
  - Add output amount to `bridgeVaultBalance`
  - Record in undo data
- If `bridgeUnlockData` present:
  - Verify `burnId` not in `processedBurnIds` (replay protection)
  - Verify Groth16 proof via `verifyBridgeProof()` (from `bridge-verifier.ts`)
  - Verify output amount matches proof's committed amount
  - Verify output amount <= `bridgeVaultBalance`
  - Subtract from `bridgeVaultBalance`
  - Add `burnId` to `processedBurnIds`
  - Record in undo data

**`disconnectBlock()` additions** (undo on reorg):
- Reverse vault balance changes
- Remove processed burn IDs
- Decrement lock nonce

### 4.3 Block Validation (`src/block.ts`)

`validateBlock()` adds structural checks for bridge transactions:

- At most one bridge unlock transaction per block (rate limiting, prevents proof spam)
- Bridge lock transactions have exactly one vault output
- Bridge unlock transactions use `BRIDGE_UNLOCK_TXID` sentinel
- No duplicate lock nonces or burn IDs within a single block
- Bridge unlock outputs satisfy dust threshold

### 4.4 Groth16 Verification (`src/bridge-verifier.ts` — NEW)

On-chain (QBTC node) verification of Groth16 proofs using `@noble/curves` bn254 pairing. Same architectural pattern as `src/claim.ts` (pure verification, no state mutation).

```typescript
import { bn254 } from '@noble/curves/bn254'

// Verification key — derived from SP1 circuit compilation.
// Embedded as constants (same values as the Solidity verifier contract).
const VK = {
  alpha: { x: 0n, y: 0n },       // G1 point
  beta:  { x: [0n, 0n], y: [0n, 0n] }, // G2 point
  gamma: { x: [0n, 0n], y: [0n, 0n] }, // G2 point
  delta: { x: [0n, 0n], y: [0n, 0n] }, // G2 point
  ic: [/* G1 points, one per public input + 1 */]
}

export interface Groth16Proof {
  a: { x: bigint; y: bigint }           // G1
  b: { x: [bigint, bigint]; y: [bigint, bigint] } // G2
  c: { x: bigint; y: bigint }           // G1
}

export interface BridgeLockPublicInputs {
  lockTxId: string       // 64-char hex
  vaultAddress: string   // Must match BRIDGE_VAULT_ADDRESS
  recipient: string      // 40-char hex Ethereum address
  amount: number         // Satoshis
  lockNonce: number
  qbtcBlockHash: string  // 64-char hex
  qbtcBlockHeight: number
}

export interface BridgeUnlockPublicInputs {
  burnId: number
  amount: number         // Satoshis
  qbtcAddress: string    // 64-char hex QBTC address
  baseBlockHash: string  // 64-char hex
  l1BlockNumber: number
}

/**
 * Verify a Groth16 proof using bn254 pairing.
 *
 * The pairing equation:
 *   e(A, B) == e(alpha, beta) * e(vk_x, gamma) * e(C, delta)
 *
 * where vk_x = IC[0] + sum(publicInputs[i] * IC[i+1])
 *
 * Uses @noble/curves bn254 which is EIP-196/EIP-197 compatible.
 * ~50-100ms per verification on modern hardware.
 */
export function verifyGroth16Proof(
  proof: Groth16Proof,
  publicInputs: bigint[]
): boolean

/**
 * Verify a bridge lock proof and extract public inputs.
 * Returns { valid, inputs?, error? }.
 */
export function verifyBridgeLockProof(
  proofBytes: Uint8Array,
  publicInputBytes: Uint8Array
): { valid: boolean; inputs?: BridgeLockPublicInputs; error?: string }

/**
 * Verify a bridge unlock proof and extract public inputs.
 * Returns { valid, inputs?, error? }.
 */
export function verifyBridgeUnlockProof(
  proofBytes: Uint8Array,
  publicInputBytes: Uint8Array
): { valid: boolean; inputs?: BridgeUnlockPublicInputs; error?: string }
```

**Performance:** bn254 pairing on `@noble/curves` runs in ~50-100ms on modern hardware. This is acceptable for block validation (one unlock per block max).

**Dependency:** `@noble/curves` v2.0.1 already includes `bn254` with EIP-196/197 compatible pairing. No new dependencies needed for the QBTC node — `@noble/curves` is already used for secp256k1 ECDSA and Schnorr.

### 4.5 RPC Endpoints (`src/rpc.ts`)

New bridge endpoints following the existing Express pattern:

```
GET  /api/v1/bridge/status
  → { vaultBalance, lockNonce, processedBurns, pendingLocks }

GET  /api/v1/bridge/locks?from=<height>&limit=<n>
  → [{ txId, blockHeight, amount, baseRecipient, lockNonce, status }]

GET  /api/v1/bridge/unlocks?from=<height>&limit=<n>
  → [{ txId, blockHeight, amount, qbtcAddress, burnId, status }]

GET  /api/v1/bridge/lock/:txid
  → { txId, blockHeight, amount, baseRecipient, lockNonce, confirmations, status }

POST /api/v1/bridge/lock
  → Submit a bridge lock transaction (same as POST /api/v1/tx but validates bridge data)
```

`status` field: `"pending"` (in mempool), `"confirming"` (mined, < 6 blocks), `"finalized"` (>= 6 blocks), `"processed"` (proof submitted to Base).

### 4.6 Storage (`src/storage.ts`)

`sanitizeForStorage()` adds serialization for new binary fields:

```typescript
// New binary fields to serialize as hex:
// - bridgeUnlockData.groth16Proof  (Uint8Array → hex)
// - bridgeUnlockData.publicInputs  (Uint8Array → hex)
```

`deserializeTransaction()` in `rpc.ts` reverses this, same pattern as existing `ecdsaPublicKey`/`ecdsaSignature` handling.

### 4.7 P2P Relay (`src/p2p/server.ts`)

Bridge transactions relay through existing `tx` and `inv` message types — no protocol changes needed. The transaction format already supports arbitrary fields via JSON serialization; `bridgeLockData` and `bridgeUnlockData` serialize as JSON naturally (hex strings for binary fields).

Validation additions:
- Bridge lock txs validated in mempool before relay (same as claim txs)
- Bridge unlock txs only accepted if Groth16 proof is valid (prevents invalid proof propagation)
- Misbehavior penalty (+10) for invalid bridge proofs (same as invalid txs)

---

## 5. Relayer Service

### 5.1 Architecture

The relayer is a standalone service (not part of `qbtcd`). It bridges the gap between QBTC and Base by generating and submitting ZK proofs.

```
┌─────────────────────────────────────────────────┐
│                   Relayer                        │
│                                                  │
│  ┌──────────┐  ┌──────────┐  ┌───────────────┐  │
│  │ QBTC     │  │ Base     │  │ SP1 Prover    │  │
│  │ Watcher  │  │ Watcher  │  │               │  │
│  │          │  │          │  │ Local or       │  │
│  │ Polls    │  │ Monitors │  │ SP1 Prover    │  │
│  │ RPC for  │  │ events   │  │ Network       │  │
│  │ lock txs │  │          │  │               │  │
│  └────┬─────┘  └────┬─────┘  └───────┬───────┘  │
│       │              │                │          │
│       ▼              ▼                ▼          │
│  ┌─────────────────────────────────────────┐     │
│  │           Proof Queue                   │     │
│  │  Batches 1-10 operations per proof      │     │
│  │  10-minute collection window            │     │
│  └─────────────────────────────────────────┘     │
└─────────────────────────────────────────────────┘
```

### 5.2 QBTC → Base Flow (Lock/Mint)

1. **Watch:** Poll `GET /api/v1/bridge/locks?from=<lastHeight>` every block (~10 min)
2. **Wait for finality:** 6 confirmations (~60 min)
3. **Collect proof inputs:**
   - Lock transaction (full tx with ML-DSA-65 signature)
   - Merkle proof (tx inclusion in block)
   - Block headers (lock block + 6 subsequent blocks)
4. **Generate SP1 proof:**
   - Execute lock circuit in SP1 zkVM
   - Compress STARK → Groth16 (~22s for ML-DSA-65 + overhead)
5. **Submit to Base:** Call `QBTCBridge.processLock(proof, publicInputs)`
6. **Record:** Mark lock as processed

### 5.3 Base → QBTC Flow (Burn/Unlock)

1. **Watch:** Monitor `BurnInitiated` events on `QBTCBridge` contract
2. **Wait for L1 finality:** ~12 minutes (2 epochs)
3. **Collect proof inputs:**
   - Burn event receipt + receipt trie proof
   - Base block header + state root
   - L1 block containing the posted state root
4. **Generate SP1 proof:**
   - Execute burn circuit in SP1 zkVM
   - Compress STARK → Groth16
5. **Submit to QBTC:** Create bridge unlock transaction with proof
   - `POST /api/v1/bridge/lock` (or `POST /api/v1/tx`)
6. **Record:** Mark burn as processed

### 5.4 Batching

To amortize proof generation cost:
- Collect lock/unlock operations over a 10-minute window
- Batch 1-10 operations per proof (SP1 supports multi-statement proofs)
- Single Groth16 verification covers the entire batch
- Individual lock/unlock operations are encoded as separate public inputs

### 5.5 Permissionless Design

- **Anyone can run a relayer** — proofs are deterministic, same inputs produce same proof
- **No trust required** — ZK soundness prevents proof forgery
- **Economic incentive** — relayers collect a small fee (embedded in lock/unlock amounts)
- **Self-relay fallback** — users can generate proofs locally using SP1 SDK if no relayer is online
- **Liveness guarantee** — even if all relayers go offline, funds are safe (locked in vault or burned); users can self-relay when ready

### 5.6 Relayer Tech Stack

```
Language:  Rust (SP1 circuits) + TypeScript (watcher/submitter)
SP1:       sp1-sdk for proof generation
Base:      ethers.js or viem for contract interaction
QBTC:     HTTP client for RPC polling
Storage:   SQLite for processed lock/burn tracking
```

---

## 6. Security Model

### 6.1 Trust Assumptions

| Component | Trust Assumption | Risk Level |
|-----------|-----------------|------------|
| SP1 zkVM | STARK soundness — invalid proofs cannot be generated | Low (well-audited) |
| Groth16 | Trusted setup (Aztec Ignition ceremony, 176 participants) | Low (widely used) |
| QBTC PoW | 6-block finality depth prevents reorgs | Medium (hash rate dependent) |
| Base/L1 | L1 finality (~12 min) prevents Base reorgs | Low (Ethereum security) |
| Relayer | Liveness only — cannot forge proofs or steal funds | None (permissionless) |
| Bridge contracts | Correctness of Solidity implementation | Medium (auditable) |
| bn254 pairing | `@noble/curves` implementation correctness | Low (well-tested, EIP-197 compatible) |

### 6.2 Attack Vectors & Mitigations

**Double-spend (QBTC → Base)**
- Attack: Lock QBTC, get wQBTC minted, then reorg QBTC chain to reverse the lock
- Mitigation: 6-block finality depth (~60 min). The ZK proof commits to the block hash and 6 subsequent blocks. A successful attack requires >50% of QBTC hash rate.

**Double-spend (Base → QBTC)**
- Attack: Burn wQBTC, get QBTC unlocked, then reorg Base to reverse the burn
- Mitigation: Wait for L1 finality (~12 min). The ZK proof commits to the L1 block number. Reverting an L1-finalized block requires attacking Ethereum consensus.

**Replay attack (same lock processed twice)**
- Attack: Submit the same lock proof to Base multiple times
- Mitigation: `processedLocks[lockTxId]` mapping in `QBTCBridge.sol`. Each lock tx ID can only be processed once.

**Replay attack (same burn processed twice)**
- Attack: Submit the same unlock proof to QBTC multiple times
- Mitigation: `processedBurnIds` set in `Blockchain`. Each burn ID can only be processed once.

**Front-running (relayer redirects minted wQBTC)**
- Attack: Relayer sees a lock tx, generates proof with different recipient
- Mitigation: The Base recipient is committed inside the ZK proof (public input). Changing it would require generating a new valid proof, which is impossible without the original ML-DSA-65 signature (private witness).

**Vault insolvency**
- Attack: More wQBTC minted than QBTC locked
- Mitigation: Each mint requires a verified proof of an actual lock transaction. The vault balance is tracked on-chain and unlock amounts are verified against it.

**Proof forgery**
- Attack: Generate a valid Groth16 proof without a real lock/burn
- Mitigation: ZK soundness. Under the knowledge-of-exponent assumption (bn254), forging a proof is computationally infeasible (~2^100 security).

**Relayer censorship**
- Attack: Relayer refuses to process certain locks/burns
- Mitigation: Permissionless design — anyone can run a relayer. Self-relay fallback allows users to generate proofs locally.

### 6.3 Failure Modes

| Failure | Impact | Recovery |
|---------|--------|----------|
| All relayers offline | Bridge paused, no new mints/unlocks | Self-relay or wait for relayer |
| QBTC chain reorg (< 6 blocks) | No impact, proof requires 6 confirmations | Automatic |
| QBTC chain reorg (>= 6 blocks) | Potential double-spend | Extremely unlikely (>50% attack) |
| Base downtime | Burns delayed | Wait for Base recovery |
| SP1 Prover Network outage | Proof generation delayed | Local SP1 proving fallback |
| Bug in bridge contract | Potential fund loss | Pause + upgrade (proxy pattern) |

---

## 7. Timing & Costs

### 7.1 End-to-End Latency

| Direction | Step | Time |
|-----------|------|------|
| **QBTC → Base** | Lock tx mined | ~10 min (1 block) |
| | Finality (6 blocks) | ~60 min |
| | SP1 proof generation | ~1-3 min |
| | Base tx confirmation | ~2 sec |
| | **Total** | **~60-70 min** |
| **Base → QBTC** | Burn tx on Base | ~2 sec |
| | L1 finality | ~12 min |
| | SP1 proof generation | ~1-3 min |
| | Unlock tx mined on QBTC | ~10 min |
| | **Total** | **~25-35 min** |

### 7.2 Gas Costs

| Operation | Gas (Base L2) | Cost (est.) |
|-----------|--------------|-------------|
| `processLock` (Groth16 verify + mint) | ~270K | ~$0.05-0.10 |
| `burn` (ERC20 burn + event) | ~80K | ~$0.01 |
| Bridge unlock tx (QBTC chain) | Free (QBTC fee) | ~1 sat/KB |

### 7.3 Proof Generation Costs

| Prover | Cost per Proof | Notes |
|--------|---------------|-------|
| Local (16-core machine) | Electricity only | ~22s for ML-DSA-65 circuit |
| SP1 Prover Network | ~$0.01-0.10 | Delegated proving, pay per proof |

---

## 8. Dependencies

### QBTC Node (existing + new)

| Package | Version | Usage | Status |
|---------|---------|-------|--------|
| `@noble/curves` | 2.0.1 | bn254 pairing for Groth16 verification | Already installed (used for secp256k1) |
| `@noble/post-quantum` | — | ML-DSA-65 signatures | Already installed |
| `@noble/hashes` | — | SHA-256, RIPEMD-160 | Already installed |

No new npm dependencies needed for the QBTC node — `@noble/curves/bn254` is already available.

### Relayer (new service)

| Package | Usage |
|---------|-------|
| `sp1-sdk` (Rust) | SP1 proof generation |
| `ethers` or `viem` | Base L2 interaction |
| `node-fetch` or built-in | QBTC RPC polling |

### Smart Contracts (new)

| Package | Usage |
|---------|-------|
| `@openzeppelin/contracts` | ERC20 base for wQBTC |
| `forge` (Foundry) | Contract development + testing |

### SP1 Circuits (new)

| Crate | Usage |
|-------|-------|
| `sp1-zkvm` | SP1 program runtime |
| `pqcrypto-dilithium` or `ml-dsa` | ML-DSA-65 verification in circuit |
| `tiny-keccak` | Keccak256 for Ethereum receipt proofs |
| `rlp` | RLP encoding for Ethereum data structures |

---

## 9. Implementation Phases

### Phase 1: QBTC Chain Changes

**Files to modify:**
- `src/transaction.ts` — `BridgeLockData`, `BridgeUnlockData`, `BRIDGE_VAULT_ADDRESS`, `BRIDGE_UNLOCK_TXID`, sighash extension, validation
- `src/chain.ts` — Bridge state (`bridgeVaultBalance`, `processedBurnIds`, `bridgeLockNonce`), `applyBlock()`/`disconnectBlock()` bridge logic, undo data
- `src/block.ts` — Bridge structural validation in `validateBlock()`
- `src/rpc.ts` — Bridge endpoints (`/api/v1/bridge/*`)
- `src/storage.ts` — Binary field serialization for bridge data
- `src/p2p/server.ts` — Bridge tx validation in relay path

**New files:**
- `src/bridge-verifier.ts` — Groth16 proof verification using `@noble/curves` bn254

**Testing:**
- Unit tests for bridge transaction creation/validation
- Unit tests for Groth16 verification (test vectors from SP1)
- Integration tests for lock/unlock cycle
- Reorg tests for bridge undo data

**Consensus impact:** All nodes must upgrade simultaneously. Requires chain wipe (new genesis with bridge-aware validation).

### Phase 2: SP1 Circuits

**New directory:** `circuits/`
- `circuits/lock/src/main.rs` — Lock circuit (ML-DSA-65 + tx + finality)
- `circuits/burn/src/main.rs` — Burn circuit (receipt + L1 finality)
- `circuits/common/` — Shared types and utilities

**Deliverables:**
- Working lock circuit with ML-DSA-65 verification
- Working burn circuit with Merkle-Patricia proof verification
- Groth16 compression pipeline
- Test vectors and benchmarks

### Phase 3: Solidity Contracts

**New directory:** `contracts/`
- `contracts/src/QBTCBridge.sol` — Bridge logic
- `contracts/src/WrappedQBTC.sol` — ERC20 token
- `contracts/src/SP1Groth16Verifier.sol` — Auto-generated verifier
- `contracts/test/` — Foundry tests
- `contracts/script/` — Deployment scripts

**Deployment:**
1. Deploy `SP1Groth16Verifier` (immutable)
2. Deploy `WrappedQBTC` with bridge address
3. Deploy `QBTCBridge` with token and verifier addresses
4. Verify all contracts on Basescan

### Phase 4: Relayer Service

**New directory:** `relayer/`
- `relayer/src/watcher.ts` — QBTC + Base event monitoring
- `relayer/src/prover.ts` — SP1 proof generation (local or network)
- `relayer/src/submitter.ts` — Proof submission to Base + QBTC
- `relayer/src/db.ts` — SQLite state tracking

**Deployment:** Docker container, same pattern as `qbtcd` Docker deployment.

### Phase 5: Tooling & UI

- `src/tools/bridge-lock.ts` — CLI tool for locking QBTC (similar to `src/tools/claim-btc.ts`)
- `website/src/bridge.html` — Bridge UI in the explorer
- Relayer status dashboard

---

## 10. Open Questions

1. **Finality depth:** 6 blocks (~60 min) mirrors Bitcoin's convention. Should we use fewer blocks for faster bridging at the cost of reduced security? A 3-block depth (~30 min) may be acceptable given QBTC's current hash rate.

2. **Batching granularity:** Batching 1-10 operations per proof amortizes costs. Should we support larger batches? Tradeoff: larger batches = more latency for individual operations.

3. **Upgrade path:** If the SP1 circuit changes (bug fix, optimization), the Groth16 verification key changes. Both the Solidity verifier and the QBTC node's embedded VK must be updated atomically. Consider a VK registry pattern.

4. **Bridge limits:** Should we enforce per-transaction or per-day limits on the bridge? This limits damage from potential bugs but reduces utility. A graduated rollout (low limits → high limits) may be prudent.

5. **Fee model:** How should relayer fees be structured? Options:
   - Fixed fee per operation (e.g., 1000 sat)
   - Percentage fee (e.g., 0.1%)
   - Tip-based (user specifies, relayers prioritize higher tips)

6. **Proxy upgradeability:** Should `QBTCBridge.sol` use a transparent proxy for upgradeability? This adds trust assumptions (proxy admin) but allows bug fixes without redeployment.
