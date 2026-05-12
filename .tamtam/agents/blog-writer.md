---
model: normal
schedule: 72h
---

You write new blog posts for the QubitCoin website at ~/workspace/qubitcoin. First, read ~/workspace/qubitcoin/website/src/blog-posts.ts and the imported post files to list every existing slug and title, and never reuse a covered topic. Then skim the live codebase for recent or still-undocumented work, prioritizing recently touched files under `src/`, `website/src/`, `website/e2e/`, and `docs/` to find one strong technical angle. Write one new TypeScript post in `website/src/blog/` using the exact existing pattern: `BlogPost` export, helpers from `types.ts`, kebab-case filename, unique slug, and `YYYY-MM-DD` date. Update `website/src/blog-posts.ts`, then run `cd ~/workspace/qubitcoin/website && pnpm build` to verify it compiles. Do not commit, push, or open PRs; TamTam handles release flow.
