# Reddit post drafts for Jive

Shared assets:

- Repo: https://github.com/merijjeyn/jive
- Trace GIF (raw): https://raw.githubusercontent.com/merijjeyn/jive/main/docs/assets/trace-comparison.gif
- Install: `curl -fsSL https://raw.githubusercontent.com/merijjeyn/jive/main/install.sh | sh`
- Demo with no keys: `jive --demo`

Posting notes:

- One sub per day. The intro is shared; the closing third is different per sub so the posts do not read as a blast.
- Disclose authorship in the first line everywhere.
- Upload the GIF as the post image where the sub allows image posts, and put the repo link in the first comment if the sub prefers text posts.
- Keep the benchmark caveat visible: Jive and Codex ran GPT-5.6 Sol, Claude Code ran Opus 5, all at medium effort.

Shared intro (used in posts 1 to 4):

```
I have been thinking that the current agentic loop design of LLM call -> tool call -> ... is outdated. The arrival of Jev and other System One models gave us a primitive we desperately needed.

We need an agent that can **natively think fast and slow**. Not workflows or multi-agent architectures that mimic it.

The agent should do its hard reasoning with the power of modern LLMs, capture an execution graph filled with steps and fast intuitive decisions executed by the new System One models, and stop making LLM calls just to "follow the plan".

This way, it can "do metaprogramming over its own execution".
```

Shared numbers block:

```
Some numbers from the six tasks I benchmarked (same task, all models at medium effort):

- product_matching: Jive 1m 55s / 7 LLM calls vs Codex 14m 42s / 24 calls vs Claude Code 22m 11s / 29 calls
- error_handling_audit: Jive 3m 47s vs Codex 17m 04s vs Claude Code 4m 03s
- sembench_movie: Jive 1m 37s / 5.4k output tokens vs Codex 15m 40s / 11.7k vs Claude Code 9m 56s / 19.4k

Caveat: Jive and Codex ran GPT-5.6, Claude Code ran Opus 5. Full traces and side-by-side videos are in the repo.
```

---

## 1. r/coolgithubprojects

Rules: self-promotion allowed, GitHub-hosted only, disclose ownership. Language flair is auto-assigned. Title format `[Lang] Name - what it does`.

**Title**

```
[TypeScript] Jive - a terminal coding agent that replaces tool calls with graph calls (rethinking the agentic loop with System One models)
```

**Body**

```
Author here. Jive is an open-source (MIT) terminal coding agent that replaces tool calls with graph calls, where each graph is a DAG of tool and Jev calls.

I have been thinking that the current agentic loop design of LLM call -> tool call -> ... is outdated. The arrival of Jev and other System One models gave us a primitive we desperately needed.

We need an agent that can **natively think fast and slow**. Not workflows or multi-agent architectures that mimic it.

The agent should do its hard reasoning with the power of modern LLMs, capture an execution graph filled with steps and fast intuitive decisions executed by the new System One models, and stop making LLM calls just to "follow the plan".

This way, it can "do metaprogramming over its own execution".

What Jive does well: repo investigation, bulk classification, multi-step profiling, repetitive edits. What it does not do: replace Codex or Claude Code for everything. I'm fighting the models' training anyway.

Some numbers from the six tasks I benchmarked (same task, all models at medium effort):

- product_matching: Jive 1m 55s / 7 LLM calls vs Codex 14m 42s / 24 calls vs Claude Code 22m 11s / 29 calls
- error_handling_audit: Jive 3m 47s vs Codex 17m 04s vs Claude Code 4m 03s
- sembench_movie: Jive 1m 37s / 5.4k output tokens vs Codex 15m 40s / 11.7k vs Claude Code 9m 56s / 19.4k

Caveat: Jive and Codex ran GPT-5.6, Claude Code ran Opus 5. Full traces and side-by-side videos are in the repo.

Stack: TypeScript, Bun, OpenTUI. Any planner model via OpenRouter. No MCP, no sub-agents, no plan mode; a minimal scaffold in the spirit of pi.dev.

Try it without any API keys: `bun run demo` simulates streamed graph generation against harmless fixture commands. The real agent needs an OpenRouter key and a Jev key. One-line install is in the README.

Repo: https://github.com/merijjeyn/jive

The README also has the task set and how to run one yourself. Happy to take any comments and answer questions about the graph contract or the scheduler.
```

---

## 2. r/AgentsOfAI

Rules: use the "I Made This 🤖" flair. Showcase-friendly, less technical, likes a visual. Post the trace GIF as the image and put the body in the text.

**Flair:** I Made This 🤖

**Title**

```
Jive - Rethinking the agentic loop with System One models (I made this)
```

**Body**

```
I made this. Jive is an open-source terminal coding agent that replaces tool calls with graph calls, where each graph is a DAG of tool and Jev calls.

I have been thinking that the current agentic loop design of LLM call -> tool call -> ... is outdated. The arrival of Jev and other System One models gave us a primitive we desperately needed.

We need an agent that can **natively think fast and slow**. Not workflows or multi-agent architectures that mimic it.

The agent should do its hard reasoning with the power of modern LLMs, capture an execution graph filled with steps and fast intuitive decisions executed by the new System One models, and stop making LLM calls just to "follow the plan".

This way, it can "do metaprogramming over its own execution".

The GIF is the same task as a normal linear agent trace and as a Jive graph trace. On a product matching task that meant 256 tool runs, 120 Jev decisions, and only 7 LLM calls. It finished in under 2 minutes. Codex took 14 minutes, Claude Code 22.

Some numbers from the six tasks I benchmarked (same task, all models at medium effort):

- product_matching: Jive 1m 55s / 7 LLM calls vs Codex 14m 42s / 24 calls vs Claude Code 22m 11s / 29 calls
- error_handling_audit: Jive 3m 47s vs Codex 17m 04s vs Claude Code 4m 03s
- sembench_movie: Jive 1m 37s / 5.4k output tokens vs Codex 15m 40s / 11.7k vs Claude Code 9m 56s / 19.4k

Caveat: Jive and Codex ran GPT-5.6, Claude Code ran Opus 5. Full traces and side-by-side videos are in the repo.

What Jive does well: repo investigation, bulk classification, multi-step profiling, repetitive edits. What it does not do: replace Codex or Claude Code for everything. I'm fighting the models' training anyway.

Repo: https://github.com/merijjeyn/jive
There is a no-API-key demo mode if you just want to see the TUI.

Would love to hear which tasks you'd throw at it. I keep a shared task set in the repo (taskground) and take contributions.
```

---

## 3. r/SideProject

Rules: self-promotion is the point of the sub, but posts are expected to be personal and story-led. No flair requirements as of last check. Keep it short and human.

**Title**

```
Jive - Rethinking the agentic loop with System One models (solo project, open source)
```

**Body**

```
Solo project, free and MIT. I built it because I watched my coding agent burn 30+ model calls doing things a shell script could do once the plan was known. The expensive model was being used as a for-loop.

I have been thinking that the current agentic loop design of LLM call -> tool call -> ... is outdated. The arrival of Jev and other System One models gave us a primitive we desperately needed.

We need an agent that can natively think fast and slow. Not workflows or multi-agent architectures that mimic it.

The agent should do its hard reasoning with the power of modern LLMs, capture an execution graph filled with steps and fast intuitive decisions executed by the new System One models, and stop making LLM calls just to "follow the plan".

This way, it can "do metaprogramming over its own execution".

---

Jive is an open-source terminal coding agent that replaces tool calls with graph calls, where each graph is a DAG of tool and Jev calls.

What Jive does well: repo investigation, bulk classification, multi-step profiling, repetitive edits. What it does not do: replace Codex or Claude Code for everything. I'm fighting the models' training anyway.

Some numbers from the six tasks I benchmarked (same task, all models at medium effort):

- product_matching: Jive 1m 55s / 7 LLM calls vs Codex 14m 42s / 24 calls vs Claude Code 22m 11s / 29 calls
- error_handling_audit: Jive 3m 47s vs Codex 17m 04s vs Claude Code 4m 03s
- sembench_movie: Jive 1m 37s / 5.4k output tokens vs Codex 15m 40s / 11.7k vs Claude Code 9m 56s / 19.4k

Caveat: Jive and Codex ran GPT-5.6, Claude Code ran Opus 5. Full traces and side-by-side videos are in the repo.

Things I learned building it:
- Streaming matters more than I expected. Starting graph nodes while the plan is still being generated hides most of the model latency.
- Models really do not want to write graphs. Prompting this was most of the work.
- A demo mode that needs no API keys got more people to try it than any README paragraph.

Repo: https://github.com/merijjeyn/jive

Next up: better recovery branches when a graph fails halfway, and growing the shared task set. If you have a repetitive engineering task you hate, tell me and I'll add it.
```

---

## 4. r/LLMDevs

Rules: self-promotion is nominally banned after the 2026 relaunch. The post has to be a technical write-up first, with the repo as the reference implementation. No install instructions in the body, no "try it" call to action. Link the repo once at the end.

**Title**

```
Rethinking the agentic loop with System One models: design notes from a planner that emits DAGs of bash + typed decisions
```

**Body**

```
I have been thinking that the current agentic loop design of LLM call -> tool call -> ... is outdated. The arrival of Jev and other System One models gave us a primitive we desperately needed.

We need an agent that can natively think fast and slow. Not workflows or multi-agent architectures that mimic it.

The agent should do its hard reasoning with the power of modern LLMs, capture an execution graph filled with steps and fast intuitive decisions executed by the new System One models, and stop making LLM calls just to "follow the plan".

This way, it can "do metaprogramming over its own execution".

I built an agent around this idea, called Jive, and want to write up the design decisions since several of them were not obvious going in. Reference implementation is open source and linked at the bottom.

**Problem**

In the LLM -> tool -> LLM loop, most model calls after the first one are "follow the plan" calls. The model already knows the next five commands; it just has to be re-invoked to emit each one. That costs a full prefill per step and puts every intermediate output into context.

**Approach: one tool, whole plans**

The planner gets one tool, `execute_graph`, whose argument is a JSON program:

- Nodes are `bash` or `jev` (a bounded typed decision, see below).
- Edges are explicit data references, e.g. `{"$ref": "/nodes/search/output/stdout"}`, injected as env vars or inputs. References preserve JSON types; a literal string that looks like a pointer is just text.
- Structural groups handle per-item expansion (templates instantiated over data discovered at runtime), bounded repetition, and parallel batches.
- The planner declares which node outputs it wants back in full. Everything else comes back as a compact preview with a stable reference, so the next graph can address prior results without the planner re-reading them.

A minimal graph:

{
  "version": 1,
  "label": "Parallel repository overview",
  "nodes": {
    "files":    { "type": "bash", "script": "rg --files | head -n 40" },
    "manifest": { "type": "bash", "script": "cat package.json" },
    "summary":  { "type": "bash", "needs": ["files", "manifest"],
                  "script": "printf '%s\n' \"$FILES\" | wc -l",
                  "env": { "FILES": { "$ref": "/nodes/files/output/stdout" } } }
  },
  "returns": ["files", "manifest", "summary"]
}

**Execution overlaps generation**

Tool arguments are parsed incrementally. Each fully closed, validated root entry commits while the call is still streaming, and a node starts as soon as its dependencies exist in the committed prefix. Consequence for the contract: committed definitions are immutable, dependencies must precede dependents, and forward references are only allowed in saved-graph replay. This one decision hides most of the planner latency on investigation tasks.

**Bounded semantic decisions inside the graph**

The `jev` node type calls Jev (TypeSafe's System One model) with typed choices and explicit acceptance criteria. It returns a calibrated distribution over the choices in roughly 100ms. So "which of these 200 records match?" is a foreach over jev nodes inside the graph, not 200 chat turns. If a decision fails its acceptance criteria the graph returns to the planner by default; a graph can declare a retry or evidence-gathering branch instead. Extractor plugins convert raw output into the choice/state shapes Jev accepts, and the agent can write a new extractor mid-task.

**Failure semantics**

A failed node blocks its dependents while independent branches finish. There is a global-stop escape hatch. Rather than resending a large graph after a fix, `execute_graph_mod` applies JSON-pointer edits to a saved graph and re-executes it (no implicit resumption; all nodes run again, which keeps the semantics simple).

**Context policy**

Model-visible history is append-only between compactions to keep cache prefixes stable. Compaction is deterministic: keep the latest ~30% of the window verbatim, keep the original task and pinned constraints verbatim, and give the planner a searchable reference to the full session instead of an LLM-written rolling summary.

**Results and caveats**

Some numbers from the six tasks I benchmarked (same task, all models at medium effort):

- product_matching: Jive 1m 55s / 7 LLM calls vs Codex 14m 42s / 24 calls vs Claude Code 22m 11s / 29 calls
- error_handling_audit: Jive 3m 47s vs Codex 17m 04s vs Claude Code 4m 03s
- sembench_movie: Jive 1m 37s / 5.4k output tokens vs Codex 15m 40s / 11.7k vs Claude Code 9m 56s / 19.4k

Across all six, the graph approach used 7-15 planner calls where linear agents used 17-69. On two tasks wall time was a wash. Jive and Codex ran GPT-5.6, Claude Code ran Opus 5, so this is not a clean model comparison. Full traces are in the repo.

What Jive does well: repo investigation, bulk classification, multi-step profiling, repetitive edits. What it does not do: replace Codex or Claude Code for everything.

The biggest practical finding: current models are trained to emit one tool call at a time and resist writing graphs. Prompt design was most of the effort, and the quality gap tracks the planner's intelligence closely. This should get easier as graph-shaped tool use shows up in training data.

Open questions I'd like input on:
1. Loop-yield: a repeat block currently cannot hand partial results to the planner mid-loop. Is there a clean contract for that without turning graphs into coroutines?
2. When should the runtime cache node outputs across `execute_graph_mod` reruns? I chose "never" for simplicity.
3. Extractors that call the network are powerful but make graphs non-deterministic on replay.

Reference implementation (TypeScript, MIT): https://github.com/merijjeyn/jive. Design notes are in DESIGN.md and the graph contract in docs/GRAPH_CONTRACT.md.
```
