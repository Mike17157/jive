# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.
- `.env` resolution (working directory, searched upward, falling back to the jive
  checkout) is centralized in `src/core/env-file.ts`; both `bin/jive.ts` (reading) and
  `jive auth` (writing, in `src/cli.tsx`) use it. Reuse it rather than re-walking
  directories by hand.
- `Bun.spawn`'s `terminal` option (see `taskground/app/terminal.ts` and
  `src/planner/anthropic-auth.ts`) attaches a real PTY to a child process — the only
  way to run another raw-mode/full-screen terminal program (e.g. `claude setup-token`,
  which renders nothing without a real TTY) and still capture its output.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
