import { type BlogPost, h2, p, steps } from './types.js';

const post: BlogPost = {
  slug: 'per-peer-transaction-rate-limiting',
  title: 'Per-Peer Transaction Rate Limiting in the P2P Layer',
  date: '2026-05-09',
  tags: ['technical', 'engineering', 'development'],
  excerpt: 'Transaction relay is supposed to spread useful data, not hand attackers an unlimited signature-verification budget. QubitCoin now tracks the last tx timestamp per peer and penalizes bursts that arrive faster than 10 per second.',
  content: () => `<h1 class="text-2xl font-bold mb-2">Per-Peer Transaction Rate Limiting in the P2P Layer</h1>
<p class="text-text-muted text-xs font-mono mb-8">2026-05-09</p>
${p('A post-quantum node has a different bottleneck profile than a Bitcoin node. In QubitCoin, every incoming transaction can lead to ML-DSA verification work, and those signatures are intentionally much heavier than secp256k1. That makes mempool relay an attractive abuse target: send a flood of junk transactions, force the receiver to spend CPU rejecting them, repeat.')}
${h2('Why Peer-Level Limits Matter')}
${p('There was already a coarse message-rate control lower in the stack. Each peer connection uses a token bucket to cap overall frame throughput. That protects the socket and parser, but it does not express the thing we actually care about here: transaction messages are more expensive than many other message types, so they need their own policy.')}
${p('The simplest useful rule is local and per-peer. When one peer sends tx payloads too quickly, that peer should accumulate misbehavior score even if the rest of the network is behaving normally.')}
${h2('The Mechanism')}
${p('The implementation adds one small piece of state to the P2P server: a map from peer ID to the timestamp of the last tx message we accepted from that peer. When a new tx message arrives, the node compares the current time with the stored one.')}
${steps([
  'If the gap is at least 100 milliseconds, nothing special happens and processing continues normally.',
  'If the gap is under 100 milliseconds, the peer gets 5 misbehavior points immediately.',
  'The timestamp is then updated either way, so sustained bursts keep accumulating penalties.',
])}
${p('That translates to an effective soft cap of about 10 tx messages per second per peer. It is deliberately not an instant disconnect. A single accidental burst should not sever an otherwise healthy connection, but sustained flooding should become expensive quickly.')}
${h2('Why the Penalty Is Small but Cumulative')}
${p('Peer disconnection already follows a broader scoring model. Misbehavior reaches a threshold at 100 points, and the score decays slowly over time. Adding 5 points for each too-fast tx means a peer has room for occasional noise, while an abusive sender hits the disconnect threshold after repeated bursts.')}
${p('That is the right shape for P2P defense. Hard bans for every small protocol mistake make the network brittle. Small, composable penalties let the node distinguish between a briefly noisy peer and a peer that is trying to turn relay into a denial-of-service channel.')}
${h2('The Important Detail: It Runs Before Deserialization')}
${p('The rate-limit check happens before transaction deserialization and validation. That ordering matters. A defense that fires only after a full parse and verification pass is already paying most of the cost the attacker wanted to impose. By scoring the peer at the top of the handler, the node starts responding to abuse before the expensive path begins.')}
${p('The code still validates everything else afterward. Malformed payloads, invalid transaction IDs, and rejected transactions all carry their own penalties. The tx-rate rule is not replacing correctness checks; it is adding an earlier and cheaper signal that a peer is behaving abnormally.')}
${h2('Memory Hygiene and Tests')}
${p('The timestamp map is cleaned up when a peer disconnects, so the limiter does not retain stale entries. The hardening test suite also covers the new behavior directly: an immediate second tx from the same peer triggers the extra 5-point penalty, while a transaction sent after a 200 millisecond gap does not.')}
${p('This is a small patch, but it is exactly the kind of small patch a networked node needs. Good protocol hardening is often a collection of narrow, boring rules that turn resource exhaustion from “cheap for the attacker” into “annoying and self-defeating.” Transaction gossip should help nodes converge on the mempool, not give one peer a lever over another peer’s CPU.')}`,
};

export default post;
