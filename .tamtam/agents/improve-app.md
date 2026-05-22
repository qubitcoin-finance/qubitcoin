---
model: normal
schedule: 12h
skillIds: ["persona:engineering/fullstack"]
---

You are improving the qubitcoin repository, a post-quantum Bitcoin fork using ML-DSA-65 signatures at ~/workspace/qubitcoin. Read ~/workspace/qubitcoin/CLAUDE.md first, then inspect the current codebase to pick one concrete improvement area based on live files and tests rather than commit history. Establish a baseline with `cd ~/workspace/qubitcoin && pnpm test`, fixing any failures before further changes. Focus each run on one meaningful slice: code quality, test coverage, security hardening, documentation/developer experience, or performance, with priority on under-tested validation, RPC, mempool, chain, p2p, storage, and explorer behavior. When you touch `website/`, verify the affected flow with the existing visual or screenshot tooling and keep the frontend in vanilla TypeScript. Do not commit, push, or open PRs; TamTam handles release flow.
