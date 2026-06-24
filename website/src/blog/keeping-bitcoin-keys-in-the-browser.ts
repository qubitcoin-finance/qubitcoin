import { type BlogPost, h2, p, steps } from './types.js';

const post: BlogPost = {
  slug: 'keeping-bitcoin-keys-in-the-browser',
  title: 'Keeping Bitcoin Keys in the Browser During Claims',
  date: '2026-06-24',
  tags: ['technical', 'engineering', 'bitcoin'],
  excerpt: 'QubitCoin&apos;s new browser claim builder is useful only if its trust boundary is explicit. The page derives BTC candidates, signs locally, clears the credential field after building, and ships browser tests that prove the node receives a signed claim transaction, not the original Bitcoin key.',
  content: () => `<h1 class="text-2xl font-bold mb-2">Keeping Bitcoin Keys in the Browser During Claims</h1>
<p class="text-text-muted text-xs font-mono mb-8">2026-06-24</p>
${p('A browser claim flow is only credible if the privacy boundary is narrow and testable. QubitCoin&apos;s new <span class="font-mono text-xs text-qubit-400">/#/claim</span> route does not ask the node to derive addresses, sign messages, or hold temporary secrets. It uses the browser for the sensitive part, and it uses the node for the stateful part. That split is the entire design.')}
${p('The result is a claim builder that can handle compressed single-key BTC claims without installing Node.js while still keeping the backend on the right side of the trust boundary. The node serves snapshot eligibility and chain metadata. The browser turns a BTC credential into a signed claim transaction. Then the browser submits that finished JSON object over <span class="font-mono text-xs text-qubit-400">POST /api/v1/tx</span> just like any other client would.')}
${h2('What The Browser Does')}
${p('The browser path starts in <span class="font-mono text-xs text-qubit-400">website/src/explorer-claim.ts</span> and <span class="font-mono text-xs text-qubit-400">website/src/claim-browser.ts</span>. A user enters a 40- or 64-character snapshot key, checks eligibility, and only then provides the BTC credential needed to prove ownership.')}
${steps([
  'The page fetches <span class="font-mono text-xs text-qubit-400">/api/v1/snapshot/address/:btcAddress</span> and <span class="font-mono text-xs text-qubit-400">/api/v1/claims/stats</span> to learn whether the snapshot entry exists, whether it is already claimed, and which <span class="font-mono text-xs text-qubit-400">btcBlockHash</span> and <span class="font-mono text-xs text-qubit-400">genesisHash</span> must be signed.',
  'The browser classifies the credential as hex, compressed WIF, or BIP39 seed phrase and derives the matching BTC candidates locally.',
  'The page either generates a fresh ML-DSA-65 destination wallet in-browser or validates an existing 64-character QBTC address.',
  'The browser signs the replay-protected claim message and serializes a claim transaction JSON object that the RPC endpoint already knows how to validate.',
])}
${p('That local derivation step matters because the browser is not merely hiding an upload. It is doing the cryptographic work itself. Raw hex keys and WIF keys expand into P2PKH or P2WPKH-style key-hash candidates, P2SH-P2WPKH candidates, and Taproot candidates. Seed phrases are normalized, checked against the BIP39 wordlist, and derived across a small fixed set of BIP44, BIP49, BIP84, and BIP86 receive paths.')}
${h2('What The Node Never Sees')}
${p('The cleanest way to understand the feature is to look at what never crosses the RPC boundary. The node does not receive the seed phrase. It does not receive the WIF string. It does not receive the original 32-byte Bitcoin private key. It receives only public snapshot metadata requests and, after signing, a transaction-shaped JSON payload containing the claim proof.')}
${p('That is visible in the transaction builder itself. <span class="font-mono text-xs text-qubit-400">createBrowserClaimTransaction</span> constructs the same domain-separated claim message that the backend expects, signs it with ECDSA or Schnorr depending on the snapshot type, and converts the byte arrays to hex so they can be posted as JSON. The final payload contains proof material like public keys and signatures because the chain must verify them. It does not contain the secret input that created them.')}
${p('The UI reinforces the same contract. The page warns that it loads no third-party scripts, keeps the generated QBTC wallet export local to the tab, and clears the BTC credential textarea after a successful build. That last step is not magic security, but it does reduce accidental retention in a long-lived page state once the signed transaction is ready.')}
${h2('Why The Route Is Intentionally Narrow')}
${p('The browser builder does not try to cover every claimable Bitcoin script. That would blur the boundary between a simple signer and a full wallet implementation. Instead it stays inside the subset that can be derived and signed from one compressed secret: key-hash paths, wrapped SegWit key-hash, and Taproot key-path claims.')}
${p('That is why uncompressed WIF keys are rejected up front in <span class="font-mono text-xs text-qubit-400">detectCredentialFormat</span>. It is also why multisig and P2WSH remain a CLI feature. The browser route is deliberately opinionated: do the common single-key cases well, fail early on unsupported shapes, and leave the broader surface area to the existing offline-friendly CLI tools.')}
${h2('The Test That Matters')}
${p('Privacy claims about frontend code are cheap unless the browser tests check the actual network traffic. QubitCoin now has that guardrail in <span class="font-mono text-xs text-qubit-400">website/e2e/claim.spec.ts</span>. The Playwright test drives the real <span class="font-mono text-xs text-qubit-400">/#/claim</span> route, records every outbound request, builds a deterministic claim, broadcasts it, and inspects the captured <span class="font-mono text-xs text-qubit-400">POST /api/v1/tx</span> body.')}
${p('The assertions are straightforward and strong. The broadcast body must contain the snapshot key and <span class="font-mono text-xs text-qubit-400">claimData</span> because that is the proof the node needs. The same body must not contain the original private-key string used to construct the claim. The test also fails if the page reaches out to any third-party origin while the claim flow runs.')}
${p('That does not turn a web browser into an HSM, and it does not protect against malicious extensions or a compromised local machine. But it does pin down the application-level contract in code: first-party explorer logic is allowed to build and submit a signed claim, and it is not allowed to leak the raw BTC credential over the network.')}
${h2('Why This Boundary Is Worth Defending')}
${p('QubitCoin&apos;s claim system already depends on a precise separation of responsibilities. Consensus verifies ownership proofs, snapshot inclusion, replay protection, and one-time claim state. The browser claim builder extends that flow without changing who is trusted for what. The node remains the authority on chain state. The browser remains the place where secrets are handled for this route.')}
${p('That is the part worth preserving as the claim page evolves. If future changes add analytics, hosted widgets, or backend "helper" endpoints that accept private material for convenience, the feature stops being a browser signer and starts becoming a custodial workflow in disguise. The current implementation avoids that trap by keeping the boundary simple enough to explain and small enough to test.')}`,
};

export default post;
