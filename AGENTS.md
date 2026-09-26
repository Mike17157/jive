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
- `GraphAgentController`'s constructor (`src/planner/agent.ts`) throws synchronously
  if no `OPENROUTER_API_KEY`/`apiKey` is resolved, even when a direct Anthropic
  credential is configured — every test construction needs `apiKey`. Which backend
  serves `anthropic/claude-*` calls (direct Anthropic vs OpenRouter) is controlled by
  `#clientFor`, overridable via `/provider` / `--provider` (session-persisted like
  `/model`/`/effort`); every other model always goes through OpenRouter.
- The `/model` catalog tracks `/provider` (`GraphAgentController#fetchLiveModels`,
  `src/planner/agent.ts`): `anthropic` sources the list from Anthropic's own
  `/v1/models` (`fetchAnthropicModelCatalog`/`mergeAnthropicModelOptions`,
  `src/planner/models.ts`, cached at `.jev/anthropic-models.json`), `auto`/`openrouter`
  keep OpenRouter's curated/refreshed list (`.jev/openrouter-models.json`) since `auto`
  can still route anything. Switching `/provider` across that boundary triggers the same
  opt-in `refreshModels()` fetch `/effort`'s picker already uses — there is no second
  refresh path. `ANTHROPIC_OAUTH_TOKEN` works against `/v1/models` the same way it does
  against `/v1/messages` (`anthropicCredentialHeaders` in `src/planner/anthropic.ts` is
  shared by both); `anthropic-version` is required, `anthropic-beta` is not but is sent
  anyway. Confirmed live against the real API: some curated ids in `CURATED_MODEL_IDS`
  use a dotted version suffix (e.g. `anthropic/claude-opus-5.5`) that Anthropic's actual
  model ids do not (`claude-opus-5-5`, dashed) — `mergeAnthropicModelOptions` only lists
  a curated id when it matches a live Anthropic id, so a dotted mismatch is silently left
  off the Anthropic-sourced list rather than shown as servable. That mismatch is untouched
  in `AnthropicClient`'s own request path (out of scope for the catalog work); worth a
  look if a curated Claude model ever 404s under `/provider anthropic`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
