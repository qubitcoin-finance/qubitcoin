import { type BlogPost, h2, p } from './types.js';

const post: BlogPost = {
  slug: 'inside-ml-dsa-65',
  title: 'Inside ML-DSA-65: The Signature Algorithm Securing QubitCoin',
  date: '2026-04-10',
  tags: ['cryptography', 'ml-dsa', 'dilithium', 'technical'],
  excerpt: 'A technical walkthrough of Module-Lattice Digital Signature Algorithm — why NIST chose it, how it works at a high level, and what the tradeoffs mean for a Bitcoin-style UTXO chain.',
  content: () => `<h1 class="text-2xl font-bold mb-2">Inside ML-DSA-65: The Signature Algorithm Securing QubitCoin</h1>
<p class="text-text-muted text-xs font-mono mb-8">2026-04-10</p>
${p('QubitCoin replaces ECDSA secp256k1 with ML-DSA-65 — formally specified in NIST FIPS 204. This post walks through what that means, why we chose it, and what the practical tradeoffs look like on a UTXO chain.')}
${h2('What Is a Lattice-Based Signature?')}
${p('Classical public-key cryptography (RSA, ECDSA) relies on problems that quantum computers can solve efficiently with Shor\'s algorithm. Lattice-based cryptography relies on different hard problems — specifically the <strong>Module Learning With Errors (MLWE)</strong> problem.')}
${p('MLWE asks: given a matrix A and a vector b = As + e (where s is a secret vector and e is small random noise), recover s. No efficient classical or quantum algorithm is known for this. The best known attacks are exponential in the dimension of the lattice.')}
${p('ML-DSA (Module-Lattice Digital Signature Algorithm, formerly Dilithium) builds a signature scheme on top of MLWE. Signing involves producing a response to a challenge derived from a hash of the message, and verifying checks that the response is consistent with the public key without revealing the secret.')}
${h2('ML-DSA-65 Parameters')}
${p('NIST standardized three ML-DSA parameter sets. We use ML-DSA-65:')}
<div class="bg-surface rounded-xl glow-border p-5 my-4">
  <div class="space-y-3 font-mono text-xs">
    <div class="flex justify-between items-center py-2 border-b border-border">
      <span class="text-text-muted">Parameter set</span><span class="text-qubit-300">ML-DSA-65</span>
    </div>
    <div class="flex justify-between items-center py-2 border-b border-border">
      <span class="text-text-muted">NIST security level</span><span class="text-entropy-cyan">3 (≈ AES-192)</span>
    </div>
    <div class="flex justify-between items-center py-2 border-b border-border">
      <span class="text-text-muted">Public key size</span><span class="text-qubit-300">1,952 bytes</span>
    </div>
    <div class="flex justify-between items-center py-2 border-b border-border">
      <span class="text-text-muted">Secret key size</span><span class="text-qubit-300">4,032 bytes</span>
    </div>
    <div class="flex justify-between items-center py-2 border-b border-border">
      <span class="text-text-muted">Signature size</span><span class="text-qubit-300">3,309 bytes</span>
    </div>
    <div class="flex justify-between items-center py-2">
      <span class="text-text-muted">Library</span><span class="text-qubit-300">@noble/post-quantum</span>
    </div>
  </div>
</div>
${p('For comparison, a Bitcoin ECDSA public key is 33 bytes compressed and a DER signature is ~71 bytes. ML-DSA-65 is roughly 50× larger. This is the fundamental tradeoff of post-quantum signatures today — more security margin costs more bytes.')}
${h2('Why Level 3, Not Level 2 or 5?')}
${p('ML-DSA-44 (Level 2) is smaller but targets ~128-bit quantum security. ML-DSA-87 (Level 5) targets ~256-bit quantum security but signatures are 4,595 bytes. Level 3 gives us ~192-bit quantum security — comparable to a 192-bit symmetric key, which is well beyond any foreseeable attack.')}
${p('We picked Level 3 because it\'s the sweet spot: enough security margin that no realistic quantum computer in the next several decades threatens it, without the extra 40% signature overhead of Level 5.')}
${h2('Impact on Block Size')}
${p('Larger signatures mean larger transactions. A typical QubitCoin transaction with one input and two outputs is roughly 5–6 KB — versus ~250 bytes for a comparable Bitcoin transaction. This affects block capacity.')}
${p('We target the same 10-minute block time with a block size limit that accounts for these larger inputs. The UTXO model is otherwise identical to Bitcoin — same selection algorithm, same fee mechanics, same coin value structure.')}
${h2('Implementation')}
${p('We use <span class="font-mono text-xs text-qubit-400">@noble/post-quantum</span> — a zero-dependency TypeScript implementation of FIPS 204 by Paul Miller. It\'s audited, constant-time where it matters, and runs in both Node.js and browser environments.')}
${p('Key generation, signing, and verification all happen in-process. The private key never leaves the node that holds it — same trust model as Bitcoin.')}
${p('For the technical specification, see our <a href="#/docs/architecture" class="text-qubit-400 hover:text-qubit-300 transition-colors">architecture docs</a>. For the security analysis, see the <a href="#/docs/security" class="text-qubit-400 hover:text-qubit-300 transition-colors">security section</a>.')}`,
};

export default post;
