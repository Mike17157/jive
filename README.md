# Jive

Jive is the terminal agent built in this repository: one planner tool,
`execute_graph`. An OpenRouter model submits a JSON graph; bash commands and Jev
decisions execute locally through branches, bounded loops, and parallel template
expansion before returning to the planner.

("Jev" throughout these docs is the external decision service Jive calls — the
`jev` node type, `JEV_API_TOKEN`, and the `.jev/` record directories. The agent
itself is Jive.)

Built with TypeScript, Bun, and OpenTUI/React. This is an experimental first
implementation of the architecture in [DESIGN.md](DESIGN.md).

## Run

```sh
bun install
bun run demo
```

If Bun is not installed globally, the project includes a pinned development
binary. With Node/npm available:

```sh
npm install
npm run demo
```

Demo mode simulates streamed graph generation, runs real, harmless fixture
commands as definitions arrive, and uses simulated Jev answers. It makes no
model API calls. Type a message containing `uncertain` or `failure` to
see a handoff or a failed command with blocked downstream work; other messages
run the successful parallel example.

For the real agent, add these values to your existing `.env`:

```dotenv
OPENROUTER_API_KEY=your-openrouter-key
JEV_API_TOKEN=your-typesafe-key
```

Then run `bun start` or `npm start`. `JEV_MODEL` and `OPENROUTER_MODEL` optionally
override the defaults. The current defaults are `jev-1.13.0` and
`anthropic/claude-sonnet-5`. Model IDs can be selected in the UI or with `--model`.
Changing models is explicit; there is no automatic model fallback.

### The `jive` command

`bun start` always runs in the repository root. To work on another directory,
install the `jive` command once:

```sh
./bin/install.sh            # symlinks bin/jive into ~/.local/bin
./bin/install.sh /usr/local/bin   # or any directory on your PATH
```

Then `jive` starts the agent wherever you invoke it:

```sh
cd taskground/wikipedia_crawl
jive
```

The working directory is that folder: `AGENTS.md`, `.jev/extractors`,
`.jev/sessions` and the model cache are read and written there, so each task
folder keeps its own sessions and records. `--cwd DIR` still overrides it.

There is no build step to keep in sync. The command runs this checkout's
TypeScript sources through Bun, so it always reflects the latest changes; it
uses the pinned `node_modules/.bin/bun` when no global Bun is installed.

Credentials come from the `.env` in the working directory, then any `.env`
further up the tree, and finally the `.env` in the jive checkout — so the keys
above keep working from any task folder, and a task folder can override them
with its own `.env`.

The UI has a slowly swaying ASCII flower, warm-white text, neutral dark
surfaces, a bottom composer with screen margins, and a conversation that grows
upward from the bottom. User messages are green and left aligned with padding. Type `/`
for a searchable command selector; `/model` opens model selection. Completed nodes
and satisfied edges turn green; failure/handoff states are yellow; blocked work
is grey. `/pin TEXT` retains a verbatim instruction through compaction, `/model`
opens model selection, and `/quit` exits. Ctrl+C interrupts active work.

The planner's reasoning for each round is kept in the transcript as a dim,
italic entry beside a grey rule, so rounds that only build and run a graph still
leave a trace instead of a gap between replies. Reasoning is recorded with the
round, so reopening a session restores the same rows.

Agent replies render Markdown headings, emphasis, lists, quotes, links, tables,
and inset code blocks as selectable terminal text, in warm white and grey only —
the blue accent stays on the chrome. Composer text wraps onto a new line at the
card's edge and the card grows up to six rows. Sending a message snaps back
to the latest conversation, even after scrolling up. Selecting text with the
mouse copies it automatically on release, using the local clipboard or the
terminal's clipboard protocol. Thinking, writing, graph building, and execution
have animated activity indicators with elapsed time.

`/new` and `/clear` both cancel and drain active work, then start a new session.
The previous conversation, pins, and evidence remain archived on disk; the fresh
session keeps the selected model and effort but starts with empty context.

`/effort` opens a slider inline above the composer — no modal dialog and no
dimmed background: left/right adjusts, Enter applies, Esc cancels. Direct
forms such as `/effort high`, `/effort xhigh`, and `/effort auto` also work.
Only the selected model's supported levels are offered; unavailable levels are
rejected rather than silently substituted. `auto` preserves the provider's
default. Effort settings persist with the session. Model metadata is refreshed
when needed for this control, following [OpenRouter's reasoning metadata](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens).

Ctrl+G focuses the graph: arrows select nodes, Space expands groups, Enter opens
the evidence inspector, and Esc returns to chat. Ctrl+P opens model selection;
Page Up/Page Down scroll the conversation. Ctrl+J inserts a composer newline.

## Headless commands

Pass options directly to the TypeScript entry point:

```sh
bun src/cli.tsx --headless --prompt "Explain the executor's failure handling"
bun src/cli.tsx --run examples/parallel.json
bun src/cli.tsx --run examples/repeat.json
bun src/cli.tsx --run examples/investigate.json
bun src/cli.tsx --demo --headless --json
bun src/cli.tsx --models
bun src/cli.tsx --refresh-models
bun src/cli.tsx --schema
```

`parallel.json` and `repeat.json` need no API keys. `investigate.json` uses the
Jev key to select the graph-execution source file from actual repository search
results, then reads that file. `--json` with a graph run streams execution events
as JSONL; the final event contains the report.

## Graphs

Executable nodes are `bash` and `jev`. Structural `groups` are `foreach` or
`repeat`; they instantiate bodies from `templates`. There are no arbitrary
plugin-generated nodes. All instantiated work shares graph-wide limits.

```json
{
  "version": 1,
  "label": "Inspect the manifest",
  "nodes": {
    "manifest": { "type": "bash", "script": "cat package.json" },
    "inspect": {
      "type": "bash",
      "stdin": { "$ref": "/nodes/manifest/output/stdout" },
      "script": "cat"
    }
  },
  "returns": ["inspect"]
}
```

References are JSON pointers carried in an object with exactly one `$ref` key.
Values preserve their types. Reference strings embedded in shell source are not
expanded. Use explicit `env` or `stdin` bindings; use `$literal` to pass data
whose shape would otherwise be interpreted as an expression.
For structured command output, set `outputFormat: "json"`; the parsed value is
available at `/nodes/ID/output/json`, including arrays for dynamic expansion.

References infer dependencies. `needs` adds ordering without passing data.
`when` expresses a typed predicate. A failed or skipped required dependency
blocks its dependents; independent branches finish. A recovery node can declare
`allowFailedDependencies: true` and inspect the dependency's status/error.
`onError: "stop"` requests a global stop. Expected command exits can be listed
in `acceptedExitCodes`, for example `[0, 1]` for a test result or empty search.

Every Jev node declares `accept`, a predicate over the returned answers. A false
predicate yields and preserves the evidence. Confidence thresholds are chosen
per decision, not supplied as one universal accuracy guarantee. `select` maps an
accepted option ID back to its original record.

### Streaming construction and early execution

Graph definitions appear as building nodes while the planner writes them, with
a short reveal animation. These previews do not imply execution. Real execution
events update the same nodes rather than creating a second graph.

Set `eager: true` to overlap execution with generation. The stream must declare
`eager`, `version`, `label`, `context`, `templates`, `limits`, and `returns` before
opening `nodes` or `groups` (empty objects/arrays are allowed). Every complete,
validated node or group definition then commits to execution. Headers and
committed definitions cannot change. Dependencies must point backward to
already committed root nodes/groups; templates can contain complete internal
DAGs and bounded loops. Requested return IDs may name later definitions.

```json
{
  "eager": true,
  "version": 1,
  "label": "Inspect while planning",
  "context": {},
  "templates": {},
  "limits": {},
  "returns": ["manifest", "inspect"],
  "nodes": {
    "manifest": { "type": "bash", "script": "cat package.json" },
    "inspect": {
      "type": "bash",
      "stdin": { "$ref": "/nodes/manifest/output/stdout" },
      "script": "cat"
    }
  }
}
```

Here `manifest` can run once its definition closes, while `inspect` is still
being generated. All committed work shares one concurrency limit, time budget,
plugin snapshot, and execution record. Only the first tool call in a response
can start early; subsequent graph calls remain serial. Normal graphs permit
forward references and wait for complete validation before running.

A malformed, truncated, or interrupted eager response cancels remaining work
and saves any completed effects. It cannot roll those effects back. Recovery
records preserve them even if generation ended before a complete assistant tool
call could be saved, and no command is automatically replayed.

See [the examples](examples/) and `--schema` for the implemented interface.
[GRAPH_CONTRACT.md](docs/GRAPH_CONTRACT.md) describes the broader semantics.

## Planner guidance

The system prompt frames `execute_graph` as a program, not a command runner.
The guide in `src/core/planner-guide.ts` tells the model to encode loops,
per-item Jev judgments, and branching inside one graph, to persist progress to
files inside groups, and to return to its own reasoning only for a new
strategy, original code, or a user decision. It carries two reference
examples: a two-node manifest inspection and a crawl loop (a `repeat` group
over a frontier whose body is a `foreach` fetch with a Jev choice per item and
a bash merge). Both examples are validated against the schema, and the crawl
loop is executed end to end with a stubbed Jev, in `tests/planner-guide.test.ts`.

## Extractor plugins

Place a TypeScript module in `.jev/extractors/` for this project, or
`~/.config/jev-agent/extractors/` for all projects. The agent can create one using
a bash node. It becomes available in the next graph invocation.

```ts
export default {
  name: "my-extractor",
  description: "Turn JSON text into candidate records",
  inputSchema: { type: "string" },
  outputSchema: { type: "array" },
  async run(input, config, ctx) {
    ctx.log("Parsing candidates");
    return JSON.parse(input);
  }
};
```

The contract also accepts `configSchema` and `examples`. Plugins can use
`ctx.exec`, `ctx.fetch`, `ctx.artifact`, `ctx.log`, `ctx.cwd`, and `ctx.signal`.
Runtime helpers record activity and propagate cancellation. General plugin code
runs in the agent process and must cooperate with cancellation; it is not an
isolated worker or a sandbox. Keep module initialization free of task work.

Each entry and its bundled dependencies load from a content-addressed module.
Existing graphs retain their loaded version. Invalid plugins produce catalog
diagnostics. Built-ins are `json`, `lines`, `rg-matches`, and `fetch-text`.
`lines` and `rg-matches` produce `options`, `records`, `items`, and a `count`.
Use the included [word-records example](examples/word-records.ts) as a template.

## Context and persistence

Planner messages append without rewriting previous entries. Compaction is
deterministic: retain approximately the latest 30% at complete message/tool
boundaries, the original task and explicit pins verbatim, and an archive locator.
No summarizing model call is added. Compaction begins a new cache prefix for the
changed conversation; cache hits are measured, not assumed.

Jev state is assembled explicitly from graph references and extractor results.
It does not receive the planner transcript automatically. Its documented input
limits are 64k tokens for state plus all questions, and 32k for state plus the
largest question. Preflight estimates are approximate; provider validation is
authoritative. See [CONTEXT.md](docs/CONTEXT.md).

Records live in `.jev/sessions/` and `.jev/runs/`. Graph records include exact
Jev inputs/answers, per-execution results, stdout/stderr artifacts, and UI events.
Every execution gets a compact preview; `returns` requests full result envelopes.
Command streams are stored completely, with an explicit 2 Mi-character inline
capture bound. Truncated stream references are rejected so consumers must read
or process the complete artifact instead. Individually oversized model messages
use explicitly marked excerpts and references to saved full results.

```sh
bun src/cli.tsx --sessions
bun src/cli.tsx --resume SESSION_ID
bun src/cli.tsx --resume SESSION_ID --search "previous failure"
```

Restarting restores the conversation and evidence. An unfinished graph is marked
interrupted; commands are never automatically replayed. Filesystem effects that
already happened remain in place.

## Development

```sh
bun run typecheck
bun test
```

Tests exercise executor ordering, blocking/recovery, parallel limits, bounded
loops, exact reference binding, plugin reloads, response validation, session
compaction/restoration, mocked planner streaming, and terminal rendering. Live
model calls are deliberately separate from the default test suite.
