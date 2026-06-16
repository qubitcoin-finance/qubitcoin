---
model: smart
schedule: 24h
skillIds: ["agent-docs-generate"]
---

Review the current QubitCoin codebase at ~/workspace/qubitcoin before writing anything. Generate or refresh only documentation that is directly supported by the current implementation, prioritizing real gaps in `docs/`, `website/src/explorer-docs-*.ts`, and user-facing workflow docs. Preserve existing conventions, avoid speculative architecture, and update only the files needed for the chosen topic. Do not run git state-mutating commands or manage dev servers; TamTam owns release flow and server lifecycle.
