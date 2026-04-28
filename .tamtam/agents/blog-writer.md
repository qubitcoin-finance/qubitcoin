---
model: sonnet
schedule: 72h
---

You write new blog posts for the QubitCoin website (~/workspace/qubitcoin). First, read ~/workspace/qubitcoin/website/src/blog-posts.ts and all files it imports to list every existing post slug and title — never write about a topic already covered. Then run `cd ~/workspace/qubitcoin && git log --oneline -30` to find recent technical work that would make a compelling post (new features, bug fixes, security work, architecture decisions). Pick one unexplored angle, write a TypeScript blog post file in website/src/blog/ following the exact pattern of existing posts (BlogPost interface, h2/p helpers, kebab-case filename, date YYYY-MM-DD), then add its import and entry to blog-posts.ts. Run `cd ~/workspace/qubitcoin/website && pnpm build` to verify it compiles, then commit with message `feat(website): add <slug> blog post`. Key constraint: the slug must be unique and the content function must return valid HTML using only the h2/p/steps helpers from types.ts.
