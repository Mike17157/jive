# Contributing

Thanks for helping with Jive. This is a small project with a simple workflow.

## Setup

```sh
git clone https://github.com/merijjeyn/jive.git
cd jive
bun install          # or: npm install, which also fetches a pinned Bun binary
bun run demo         # exercises the UI and executor without API keys
```

## Before opening a pull request

```sh
bun run typecheck
bun test
```

`bun test` is offline and uses fixtures. The live planner evaluation
(`bun run eval:planner`) and the taskground runs make real model calls and are
not required for ordinary changes.

## Guidelines

- Keep the graph contract and the planner guide in sync: `docs/GRAPH_CONTRACT.md`,
  `src/core/schema.ts`, `src/core/planner-guide.ts`, and their tests.
- Behaviour that users can observe belongs in `docs/USAGE.md`; architectural
  decisions belong in `DESIGN.md`.
- Do not commit credentials, `.jev/` records, or large media. `.gitignore`
  already covers these.
- Open an issue first for larger changes so we can agree on the approach.
