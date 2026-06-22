# Browser Claim Workflow

How the explorer's `/#/claim` page builds, exports, imports, and broadcasts single-key BTC-to-QBTC claim transactions entirely in the browser. Read this when working on `website/src/claim-browser.ts`, the claim route in `website/src/explorer-main.ts`, browser-side WIF/hex/BIP39 derivation, generated ML-DSA-65 destination wallets, `/api/v1/snapshot/address/:btcAddress`, `/api/v1/claims/stats`, or the Playwright privacy test that ensures BTC private keys are not sent to the node.

This page is about the browser workflow, not the consensus rules for accepting a claim. The chain still verifies the submitted transaction with `verifyClaimProof`, snapshot lookup, double-claim state, and the usual block/mempool gates. The browser page only helps a holder create the same JSON transaction shape that the node already accepts over `POST /api/v1/tx`.

Search terms that should land here: `/#/claim`, `createBrowserClaimTransaction`, `deriveClaimCandidates`, `selectMatchingCandidate`, `generateQbtcWallet`, `makeAddressOnlyWallet`, `qbtc-claim-*.json`, "Build Signed Claim", "Broadcast Imported JSON", "BTC private key is never included in API requests", and "The provided BTC credential does not derive the snapshot address being claimed."

## Why It Exists

QubitCoin has a CLI claim path for users who run the repo locally, but the explorer also exposes a browser-only path for compressed single-key claims. That matters for holders who only need to prove ownership of a snapshotted compressed P2PKH, P2WPKH, P2SH-P2WPKH, or P2TR address and do not want to install Node.js just to construct one transaction.

The workflow has three boundaries that are easy to confuse:

- The browser handles secret material: BTC WIF/hex/seed input, secp256k1 or Schnorr signing, optional ML-DSA-65 wallet generation, and JSON export.
- The node handles network state: snapshot eligibility, claim metadata (`btcBlockHash` and `genesisHash`), mempool admission, and final consensus validation.
- The claim-capable website shell loads no third-party scripts or fonts. Analytics and externally hosted assets must stay out of this page because any script in the document could read the BTC credential fields.

That split is intentional. The BTC private key or seed phrase is read by `claim-browser.ts` and cleared from the form after a signed transaction is built. API calls carry only snapshot keys, claim metadata requests, and the finished transaction JSON. The Playwright claim test asserts that the private key string is absent from the `POST /api/v1/tx` body.

The page is narrower than the CLI. It derives and signs compressed single-key key-hash, wrapped-SegWit key-hash, and Taproot key-path claims. Uncompressed WIF, P2WSH, P2SH multisig, and bare multisig remain covered by the CLI and consensus validator, but they are not constructed by the browser builder.

## Key Files

| Anchor | Role |
|---|---|
| `website/src/explorer-main.ts:54` | `Route` includes the `claim` view used by `/#/claim`. |
| `website/src/explorer-main.ts:66` | `parseRoute` maps `#/claim` to the claim view. |
| `website/src/explorer-main.ts:931` | Claim route dispatches to `renderClaim`. |
| `website/src/explorer-main.ts:898` | Claim route hides the normal search bar and uses the wide explorer container. |
| `website/src/explorer-claim.ts:16` | `ClaimUiState` holds snapshot, candidate, generated wallet, transaction, status, and txid state. |
| `website/src/explorer-claim.ts:118` | `renderClaim` builds the eligibility, signing, preview, export, import, and broadcast UI. |
| `website/src/explorer-claim.ts:206` | `bindClaimHandlers` wires the browser workflow events. |
| `website/src/explorer-claim.ts:226` | Eligibility lookup fetches snapshot address state and claim metadata in parallel. |
| `website/src/explorer-claim.ts:277` | Build step derives candidates from the BTC credential. |
| `website/src/explorer-claim.ts:278` | Build step selects the candidate matching the snapshot entry. |
| `website/src/explorer-claim.ts:279` | Build step optionally generates a new in-browser QBTC wallet. |
| `website/src/explorer-claim.ts:281` | Build step creates the signed claim transaction JSON. |
| `website/src/explorer-claim.ts:295` | Build step clears the private-key textarea after signing. |
| `website/src/explorer-claim.ts:304` | Broadcast button posts the signed transaction to the node. |
| `website/src/explorer-claim.ts:321` | Import form accepts either exported wrapper JSON or a raw transaction object. |
| `website/src/explorer-claim.ts:349` | Download button writes a `qbtc-claim-<prefix>.json` file. |
| `website/src/explorer-claim.ts:369` | `extractImportedTransaction` unwraps `{ transaction, qbtcWallet }` exports before broadcast. |
| `website/src/claim-browser.ts:54` | `detectCredentialFormat` classifies hex private keys, WIF keys, and BIP39 seed phrases. |
| `website/src/claim-browser.ts:62` | `generateQbtcWallet` creates an ML-DSA-65 destination wallet in the browser. |
| `website/src/claim-browser.ts:79` | `makeAddressOnlyWallet` validates an existing 64-character QBTC destination address. |
| `website/src/claim-browser.ts:90` | `deriveClaimCandidates` expands the BTC credential into possible snapshot address keys. |
| `website/src/claim-browser.ts:97` | `selectMatchingCandidate` rejects credentials that do not derive the looked-up snapshot key. |
| `website/src/claim-browser.ts:105` | `createBrowserClaimTransaction` builds the claim transaction sent to `/api/v1/tx`. |
| `website/src/claim-browser.ts:160` | `deriveSeedCandidates` checks BIP39 and derives fixed BIP44/BIP49/BIP84/BIP86 paths. |
| `website/src/claim-browser.ts:197` | Raw hex/WIF keys produce P2PKH/P2WPKH, P2SH-P2WPKH, and P2TR candidates. |
| `website/src/claim-browser.ts:239` | `decodeWIF` verifies Base58Check, version byte, and rejects uncompressed WIF payloads. |
| `website/src/explorer-api.ts:79` | `ClaimStats` includes `btcBlockHash` and `genesisHash` used in the signed message. |
| `website/src/explorer-api.ts:90` | `SnapshotAddressLookup` is the browser view of a snapshot entry and claim status. |
| `website/src/explorer-api.ts:148` | `fetchClaimStats` calls `/claims/stats`. |
| `website/src/explorer-api.ts:149` | `fetchSnapshotAddress` calls `/snapshot/address/:btcAddress`. |
| `website/src/explorer-api.ts:152` | `broadcastTransaction` posts the signed transaction to `/tx`. |
| `src/rpc.ts:226` | RPC handler returns sanitized claim stats. |
| `src/rpc.ts:231` | RPC handler validates and serves snapshot address eligibility. |
| `src/chain.ts:30` | `SnapshotAddressLookup` backend shape includes `claimedBy`. |
| `src/chain.ts:558` | `getSnapshotAddressLookup` reads snapshot amount/type and current claimed state. |
| `website/e2e/claim.spec.ts:48` | Browser test builds and broadcasts a claim without posting the BTC private key. |

## How It Works

### Route and UI State

The explorer uses hash routing. `parseRoute` treats `#/claim` as `{ view: 'claim' }`, and the main render switch calls `renderClaim` without showing the normal loading skeleton. The same router branch also hides the explorer search bar and widens the content container so the signing, preview, export, and import panels can sit side by side on large screens.

`ClaimUiState` is module-local state in `explorer-claim.ts`. It records the BTC snapshot key entered by the user, whether the user wants a generated or existing QBTC destination, the current `SnapshotAddressLookup`, the current `ClaimStats`, all derived BTC candidates, the selected candidate, any generated wallet export, the signed claim transaction, status/error text, and the txid returned by broadcast.

There is no browser storage layer. A rerender reconstructs the DOM from `ClaimUiState`; leaving the page loses generated secret-key material unless the user downloaded or copied the export.

### Eligibility Lookup

The first user action is "Check Eligibility". The handler lowercases the entered BTC snapshot key and requires either 40 or 64 hex characters before making network calls. A 40-character key is used for HASH160-style entries; a 64-character key is used for SHA256-style script or Taproot entries.

If the key is well-formed, the browser fetches two RPC resources in parallel:

```text
GET /api/v1/snapshot/address/:btcAddress
GET /api/v1/claims/stats
```

`/snapshot/address/:btcAddress` returns amount, type, whether the entry is already claimed, and the claiming QBTC address when known. `/claims/stats` carries chain-level metadata, including `btcBlockHash` and `genesisHash`; those values are required to create the replay-protected claim message.

The browser does not decide snapshot membership locally. A missing address, invalid address, network error, and already-claimed address all become UI status/error states, but the source of truth remains `Blockchain.getSnapshotAddressLookup`.

### Credential Derivation

The builder accepts three credential formats:

- A 64-character hex private key.
- A compressed mainnet WIF private key starting with `K` or `L`.
- A BIP39 seed phrase with at least 12 words.

`detectCredentialFormat` performs the first classification. WIF credentials are decoded with Base58Check verification, Bitcoin mainnet version-byte checking, and compressed-key payload checking. Uncompressed WIF keys starting with `5` are rejected in the browser because the browser builder only derives compressed single-key claim candidates; use the CLI claim tool for claim paths outside that browser subset. Seed phrases are normalized to lowercase single-space words and validated against the English BIP39 wordlist before deriving child keys.

For a raw hex or WIF key, `candidatesFromSecretKey` derives three possible snapshot keys:

- P2PKH/P2WPKH key-hash candidate: `HASH160(compressedPublicKey)`, typed as `p2pkh` in the browser model.
- P2SH-P2WPKH candidate: `HASH160(0x0014 || HASH160(compressedPublicKey))`, typed as `p2sh`.
- P2TR candidate: Taproot output key from a BIP340 x-only internal key, typed as `p2tr`.

For a seed phrase, `deriveSeedCandidates` tries fixed index `0`, `1`, and `2` receive paths for BIP44 P2PKH, BIP84 P2WPKH, BIP49 P2SH-P2WPKH, and BIP86 P2TR. Each derived private key is converted into the corresponding snapshot-key candidate and remembers its path for the preview.

The candidate list is not shown as a manual chooser. `selectMatchingCandidate` filters it against the already looked-up snapshot address key. It prefers an exact type match and otherwise accepts the first same-address match. If no candidate derives the snapshot key, the build fails before any transaction is created.

### Destination Wallet Selection

The claim form has two destination modes:

- Generate a new QBTC wallet in-browser.
- Use an existing 64-character QBTC address.

In generated mode, `generateQbtcWallet` calls ML-DSA-65 key generation from `@noble/post-quantum/ml-dsa`, derives the QBTC address as `SHA-256(publicKey)`, and keeps an exportable hex form of `address`, `publicKey`, and `secretKey`.

In existing-address mode, `makeAddressOnlyWallet` validates only the address format and stores empty public/secret key byte arrays. That is enough because the BTC claim transaction only needs the destination address. It does not spend from the destination wallet during the claim.

Generated-wallet mode adds a warning and the generated QBTC secret key to the export panel. The code does not persist that key anywhere else.

### Claim Message and Transaction Shape

`createBrowserClaimTransaction` refuses to proceed unless both `snapshotBlockHash` and `genesisHash` are 64-character hex strings. It then signs the same domain-separated claim message used by the backend claim flow:

```text
QBTC_CLAIM:{btcAddress}:{qbtcAddress}:{snapshotBlockHash}:{genesisHash}
```

The browser double-SHA256s that string and signs the hash with the selected BTC key. For Taproot, it populates `schnorrPublicKey` and `schnorrSignature` and leaves the ECDSA fields empty. For other supported single-key paths, it populates `ecdsaPublicKey` and `ecdsaSignature`.

The resulting transaction has one sentinel input:

```text
txId: cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
outputIndex: 0
```

It has one output to the selected QBTC address for exactly the snapshotted amount returned by the lookup endpoint. Its txid is computed from the same structural signing serialization used by ordinary transactions: input outpoints, outputs, and timestamp, excluding signatures and public keys. The browser then recursively converts all `Uint8Array` fields into hex strings so the object can be posted as JSON.

The node remains authoritative. A browser-built transaction can still be rejected by RPC, mempool, or block validation if the proof, amount, metadata, duplicate-claim state, or serialized shape is invalid.

### Export, Import, and Broadcast

After a successful build, `claimUiState.claimTx` enables two paths:

- "Broadcast" posts the signed transaction object directly through `broadcastTransaction`.
- "Air-gapped Export" renders JSON with `{ transaction, qbtcWallet }` and enables copy/download.

The downloaded filename is `qbtc-claim-<first-8-btc-key-chars>.json`, or `qbtc-claim-tx.json` if there is no address prefix. The export wrapper includes the generated QBTC wallet only when the browser created one; existing-address claims export `qbtcWallet: null`.

The import form accepts either the wrapper shape or a raw transaction object. `extractImportedTransaction` unwraps a top-level `transaction` property when present and otherwise treats the parsed JSON as the transaction itself. The imported transaction is then posted to `/api/v1/tx` using the same `broadcastTransaction` helper as the direct button.

### Privacy Test Boundary

`website/e2e/claim.spec.ts` mocks all `/api/v1` calls, records third-party network requests, fills a deterministic private key and snapshot key, builds a claim, broadcasts it, and inspects the captured POST body. The assertions are intentionally simple: no third-party origin may be requested while the claim page is used, and the broadcast body must contain the snapshot key and `claimData` but not the original BTC private-key string.

That test proves the browser does not send the literal credential it received in that workflow and that the claim-capable page is not loading third-party origins. It does not make a web browser an air gap, and it does not cover extensions, compromised first-party code, clipboard history, or the user's local machine. The code-level boundary is still useful: the intended request payload is the signed transaction, never the BTC secret.

## Invariants and Edge Cases

The snapshot key must be lowercase-normalized before lookup and claim construction. RPC accepts uppercase by lowercasing after validation, but the UI normalizes early so candidate matching compares canonical hex strings.

The browser supports only snapshot entry types it can derive from a single private key: `p2pkh`, `p2sh` for wrapped P2WPKH, and `p2tr`. The API type union also includes `p2wsh` and `multisig`, but the browser builder has no witness-script or m-of-n signature collection path.

`ClaimStats` must include both `btcBlockHash` and `genesisHash`. Without them, the browser cannot produce the replay-protected claim message and fails with "The connected node did not return claim metadata."

A generated QBTC wallet is a one-page secret. The browser exports the secret key and shows a warning, but the implementation does not write it to local storage or rederive it from a mnemonic.

The private-key textarea is cleared only after a successful build. Validation failures leave error text and no transaction; the current DOM rerender replaces the textarea, so the displayed credential is removed after the submit path rerenders.

The import form does not re-verify that the pasted transaction matches the current preview. It is a broadcast convenience for exported JSON or raw transaction JSON. The node still validates the transaction on submission.

The browser signs against the metadata from the connected node. If a user builds against one node's snapshot/genesis metadata and broadcasts to a node on a different fork, the node should reject the claim because the signed message no longer matches its expected claim context.

Network errors and node rejections are intentionally collapsed into short user-facing strings in the UI. Detailed RPC errors are not surfaced by `broadcastTransaction`; backend logs and RPC tests are the better place to debug rejection causes.

## Cross-References

- [CLAIM-FLOW](./CLAIM-FLOW.md) for the consensus claim transaction and `verifyClaimProof` rules.
- [BTC-SCRIPT-COVERAGE](./BTC-SCRIPT-COVERAGE.md) for which Bitcoin script templates enter the snapshot and which are excluded.
- [SNAPSHOT-PIPELINE](./SNAPSHOT-PIPELINE.md) for snapshot metadata, merkle commitment, and address lookup.
- [RPC-ENDPOINTS](./RPC-ENDPOINTS.md) for `/api/v1/claims/stats`, `/api/v1/snapshot/address/:btcAddress`, and `POST /api/v1/tx`.
- [EXPLORER-DATA-FLOW](./EXPLORER-DATA-FLOW.md) for explorer routing and fetch helper conventions.
- [EXPLORER-PRESENTATION](./EXPLORER-PRESENTATION.md) for formatting and escaping helpers used by the claim view.
- [WEBSITE-QA](./WEBSITE-QA.md) for the Playwright workflow that runs the browser claim test.
- [TRANSACTION-ANATOMY](./TRANSACTION-ANATOMY.md) for transaction IDs, signing serialization, and the ordinary spend shape that claim transactions deliberately bypass with the sentinel input.
