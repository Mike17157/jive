# Jive

Jive is the terminal agent built in this repository: one planner tool,
`execute_graph`, plus `execute_graph_mod` to run a saved graph by ID or file,
with optional edits. An OpenRouter model submits a JSON graph; bash commands and Jev
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
`google/gemini-3.8-flash`. Model IDs can be selected in the UI or with `--model`.
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
At session creation, Jive snapshots that folder's `AGENTS.md` into the leading
system prompt and persists the snapshot with the session. Changes to the file
take effect in a new session (`/new`), without changing the prompt prefix of an
existing session.

Every planning request also receives runtime facts: the session cwd, runtime and
contract versions, configured Jev model and credential availability (never credential
values), execution limits, and graph replay support. Configuration is not a health
check; useful task calls establish service availability. The latest extractor catalog
is retained through compaction. `planner.context` records the exact system prefix and
tool definitions once per change; `planner.request` records the context snapshot,
history boundary, compaction epoch, model and effort used for each request.

There is no build step to keep in sync. The command runs this checkout's
TypeScript sources through Bun, so it always reflects the latest changes; it
uses the pinned `node_modules/.bin/bun` when no global Bun is installed.

Credentials come from the `.env` in the working directory, then any `.env`
further up the tree, and finally the `.env` in the jive checkout — so the keys
above keep working from any task folder, and a task folder can override them
with its own `.env`.

The UI has a looping lit dahlia drawn in Braille dots that blooms on the empty screen, warm-white text, neutral dark
surfaces, a bottom composer with screen margins, and a conversation that grows
upward from the bottom. User messages are green and left aligned with padding. Type `/`
for a searchable command selector; `/model` opens model selection and `/resume` or
`/sessions` opens the saved-session picker. Completed nodes
and satisfied edges turn green; failure/handoff states are yellow; blocked work
is grey. `/pin TEXT` retains a verbatim instruction through compaction, `/model`
opens model selection, and `/quit` exits. Ctrl+C interrupts active work.

The planner's reasoning for each round is kept in the transcript as a dim,
italic entry beside a grey rule, so rounds that only build and run a graph still
leave a trace instead of a gap between replies. Ctrl+O opens every round's
reasoning in full and closes them again; the collapsed row shows `▸` and the
open one `▾`. Reasoning is recorded with the round, so reopening a session
restores the same rows.

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

Every session receives a stable friendly fallback name from Jive's built-in name
list. After its first turn, a background OpenRouter request asks
`google/gemma-3-27b-it` for a concise title. It retries three times after the
initial attempt; naming never blocks the turn, and the fallback remains if every
attempt fails. `/name TEXT` and `/rename TEXT` set an explicit name that automatic
naming cannot overwrite. Names are append-only session events and appear in
`--sessions` and the session picker.

The session picker is scoped to the current working directory, newest first, and
searchable by typing a name, ID, or model. `/resume ID` also accepts an
unambiguous session-ID prefix. Resuming drains active work, flushes the current
log, and restores the selected transcript, reasoning, graph events, model, and
effort. A missing or corrupt target leaves the current session active.

`/effort` opens a slider inline above the composer — no modal dialog and no
dimmed background: left/right adjusts, Enter applies, Esc cancels. Direct
forms such as `/effort high`, `/effort xhigh`, and `/effort auto` also work.
Only the selected model's supported levels are offered; unavailable levels are
rejected rather than silently substituted. `auto` sends medium, or the nearest
level the model supports, because provider defaults tend to be the heaviest
thinking level. For Anthropic models each level is sent as an explicit thinking
budget (`reasoning.max_tokens`) rather than an effort name, since OpenRouter
would otherwise derive the budget from an unset `max_tokens` and every level
would think freely. Effort settings persist with the session. Model metadata is refreshed
when needed for this control, following [OpenRouter's reasoning metadata](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens).

Transient transport failures — an upstream rate limit, a 5xx, a dropped
connection, a stream that ends early — are retried automatically: four attempts
with exponential backoff and jitter, honouring any `Retry-After` the provider
asks for. The activity line names the reason and counts down to the next
attempt. A retry replays the whole request, so it happens only while nothing of
the attempt has reached the transcript; once reasoning, an answer, or a tool
call has streamed — and a streamed tool call may already have committed a graph
to execution — the failure is reported as before and the planner decides what to
do with the evidence.

Loops are drawn open and cyclic: a `foreach` or `repeat` row (marked `≡` or
`↻`) shows its template body once beneath it, bracketed by a loop-back lane
(`╭ │ ╰`), and every pass re-runs status through those same rows rather than
appending new ones. Each body row reflects the current pass (the latest
iteration, or the running item of a foreach); a loop that has not started yet
shows its body as dimmed placeholders. Inspecting a body row opens the instance
behind it. Completed Jev nodes are purple, bash nodes green. Ctrl+G focuses the
graph: arrows select rows, Space toggles a group, Enter opens the evidence
inspector, `e` and `c` open or fold every group, and Esc returns to chat.
Ctrl+P opens model selection;
Ctrl+O shows or hides the planner's reasoning; Page Up/Page Down scroll the
conversation. Ctrl+J inserts a composer newline.

A call that ends up as a single node is drawn as that node, carrying the graph's
title: a title line above one row would only say the same thing twice, and the
row's own status replaces the "1/1 done" a header would add. A call still being
assembled keeps its title, however few nodes it has so far.

When a run changes files in the working tree its title line ends with
`✎ 3 files +42 −7`, and the files are named on one dim line beneath it, largest
first, closing with how many were left out. Git decides the file set: a status
taken before the run and another after it, so ignored paths and the run's own
`.jev` artifacts never appear. Line counts are measured against the state the
run started from rather than against HEAD, so edits already in the tree are not
billed to the graph. Outside a repository, or without git, nothing is shown.

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

The planning policy appears before the detailed graph contract. It directs the
agent to batch known independent work into one graph, encode predictable
continuations, use code for deterministic decisions and Jev for bounded semantic
decisions, and return for new strategy or original code/rubric generation.
Small executable examples cover parallel reads, deterministic and semantic
branches, and batch judgment with per-item evidence and aggregation. Tests run
these examples through the real executor with fixture Jev answers. Taskground
READMEs describe the task without teaching the execution system.

`execute_graph_mod` accepts exactly one of `base` (a returned graphId) or `file`
(a graph JSON path relative to session cwd, or absolute). Edits are optional:

```json
{"base":"earlier-graph-id"}
{"file":"work/graph.json"}
{"file":"work/graph.json","edits":[{"path":"/limits/concurrency","new":8}]}
```

Each call validates and executes in the active session, records its events, and
saves a new graphId without changing the source graph. All nodes run again; there
is no automatic resume or result cache. Reuse saved evidence when recovering
from an aggregation failure. File replay keeps session cwd semantics. Standalone
replay remains `jive --cwd DIR --run FILE --json`.

Run `bun run eval:planner --model MODEL` for the opt-in live behavior suite.
It uses task-only prompts in fresh temporary workspaces and records correctness,
tool rounds, parallel structure, semantic decisions and capability probes.
See [the evaluation guide](evals/planner/README.md). Regular `bun test` uses
fixtures and makes no model calls.

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

`--sessions` prints each session's ID, friendly name, and last activity time.
`--resume` accepts a complete ID or an unambiguous prefix.

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
