# taskground

Reusable task definitions and retained, fresh workspaces for Jive, Codex, and Claude
Code. Launches are local processes. Interactive agents open in the current terminal.

```sh
bun run taskground list
bun run taskground run intent_routing --agent jive
bun run taskground run product_matching --agent codex
bun run taskground run sembench_movie --agent claude
```

Run `npm install --no-package-lock` first if dependencies are absent. If Bun is not
on PATH, use `node_modules/.bin/bun run taskground ...`. Python 3 and Git are required;
Codex/Claude must be installed and authenticated for those profiles. Jive runs this
checkout's `bin/jive`, so local feature changes are exercised automatically.

Interactive runs do not submit the task automatically. Jive and Claude open with
the task prefilled as an editable draft; press Enter when ready. Jive also exposes
this directly as `jive --prefill "your draft"`, while `--prompt` still submits
immediately. Claude uses its native `--prefill` option (verified in 2.1.278, hidden
from its help). The installed Codex CLI has no equivalent startup option, so it
opens with an empty composer: enter `Read TASK.md and README.md, then complete the
task.` or paste the full prompt from `../prompt.txt`.

## Layout

```text
taskground/
  task_definitions/<task>/
    task.json               # ID, description, optional setup/verifier argv
    instruction.md          # Identical task instruction for every agent
    workspace/              # Agent-visible starting files
    verifier/reference.json # Held-out answers; not copied to workspace
    SOURCE.json             # Attribution, upstream revision/checksums, sampling
  _shared/                  # Dev scoring and deterministic verifiers
  task_runs/<run-id>/        # Gitignored, retained until you remove the run
    definition/             # Definition + shared verifier snapshot
    workspace/              # Fresh Git repository; .env, inputs, work/ outputs
    prompt.txt              # Exact initial prompt
    run.json                # Configuration, process state, provenance
    result.json             # Final execution/verification result
    logs/                   # Headless output and supervisor logs
    verification/           # Every grading attempt and its logs
```

| Task | Size | Expected individual helper calls |
| --- | --- | --- |
| `sembench_movie` | 120 test reviews, 12 dev reviews, three analytical queries reusing judgments | 132 |
| `product_matching` | 120 test pairs and 20 dev pairs | 140 |
| `intent_routing` | 154 test requests across 77 intents; labeled examples supplied for reference | 154 |
| `conversation_eval` | Three dev rounds of 20 responses + 10 pairs, then 40 test responses + 20 pairs | 150 |

These are frozen **development adaptations**, not official full-benchmark scores.
The counts leave room below 200 for retries/refinements; they assume all five
conversation attributes are evaluated together per response. Intent examples do
not require a separate full inference pass. Fixtures are checked in: ordinary runs
need no dataset downloads. `SOURCE.json` records exact sources, sampling and rights.

## Credentials and profiles

Every prepared workspace receives a mode-0600 `.env` containing only
`OPENROUTER_API_KEY`. The run directory is mode 0700. The shell environment takes
precedence, followed by `--env-file FILE`, or the current checkout's `.env` and the
main checkout's `.env` when running in a Git worktree. Missing keys produce an empty
entry; Jive reports an error before launching if its key is absent. The other agents
can still use their normal authentication. Jive's Jev credentials/settings are
inherited or loaded from those same source env files, without copying them into
the task's `.env`.

Only **non-Jive** workspace READMEs receive a line saying OpenRouter is optional,
using `deepseek/deepseek-v4-flash`, with at most **200 helper calls per task run**,
including calibration and retries. This is an instruction, not a metered or
enforced limit. It does not count the coding agent's own inference. Jive's README,
task prompt, and core agent guidance receive no OpenRouter helper instructions.

Secrets are excluded from definition snapshots, run metadata, and workspace Git.
Agent stdout is captured as emitted: an agent that prints a secret can put it into
its own logs. Treat whole run folders as private; share selected artifacts only.
Local folder separation is not a sandbox and does not make held-out answers
inaccessible to an agent that deliberately leaves its workspace.

## Run and inspect

```sh
# Prepare a workspace without starting an agent or making API calls
bun run taskground prepare conversation_eval --agent jive --json

# Wait for a headless run; final summary is one JSON object on stdout
bun run taskground run intent_routing --agent jive --headless --json

# Return immediately with a run ID; a detached supervisor owns the agent
bun run taskground run intent_routing --agent jive --headless --detach --json

# Both commands work while the agent is running
bun run taskground status RUN_ID --json
bun run taskground logs RUN_ID --tail 30
bun run taskground stop RUN_ID --json
bun run taskground verify RUN_ID --json
```

`prepare` creates an inspectable workspace; `run` always creates a new run. To work
manually in a prepared workspace, change into its printed path and open an agent
with `TASK.md` as its task. Do not reuse previous run folders for benchmark retries.

Options: `--model ID`, `--prompt-file FILE`, `--env-file FILE`, optional
`--timeout SECONDS`, `--runs-dir DIR`, `--agent-bin PATH`, and repeatable
`--agent-arg=ARG`. Arguments are passed directly, not interpolated into shell code.
Codex receives a writable-workspace sandbox with network enabled. Claude headless
runs allow Read/Edit/Write/Bash/Glob/Grep. Interactive agents retain their normal
permission prompts. Use explicit agent arguments for additional local configuration.

Headless stdout/stderr are captured in `logs/`. Interactive runs inherit the terminal
instead of replacing the native UI; Jive session paths are collected in `run.json`.
Codex and Claude retain their normal interactive session history. `stop` requests
cancellation through the supervisor, which terminates the agent and its observed
descendants. Ctrl+C also forwards cancellation. An unexpected supervisor exit is
reported by `status`; detached processes that intentionally escape the supervisor's
process tree are outside this local runner's guarantees.

Execution status (`completed`, `failed`, `cancelled`, `timed_out`) and grading status
(`ungraded`, `passed`, `failed`, `error`) are separate. Verification is explicit,
uses the saved verifier/reference snapshot, and preserves each report. Changes to
that snapshot are detected. Correctness thresholds are provisional; method,
reproducibility, call-count compliance, and label leakage need trace review.

## Parent-agent workflow

Use `list --json` to select a task, then `run ... --headless --detach --json`. Keep
the returned ID. Poll `status`, inspect `logs` and workspace artifacts, then invoke
`verify` after execution stops. A zero agent exit code only means the process
completed; inspect `grading` and the referenced report before asserting success.
Verification can also inspect a manually completed `prepare` workspace. Preserve
failed runs as debugging evidence. A new attempt gets a new ID and starting state.

`status RUN_ID --json` reports lifecycle state (such as `running`) and paths to the
workspace and logs. `logs RUN_ID --tail 30` reads the latest captured output
without waiting for completion. Jive emits agent snapshots, Codex emits JSON
events, and Claude emits stream-JSON events; the underlying files in `logs/` can
also be read directly. Poll every few seconds rather than busy-looping. These
provide activity and intermediate artifacts, not a percentage-complete estimate;
a quiet log alone does not establish that the agent is stuck. `stop` can cancel
a run while retaining its partial artifacts.

Run records include the task snapshot hash, initial prompt, CLI command/version,
requested model/extra arguments, source revision/dirty flag/source-code hash,
timestamps, exit status and artifact paths. Native logs hold actual model events
where available. The source hash identifies a dirty checkout; it is not a complete
backup of that checkout or of global agent configuration.

## Maintaining fixtures

```sh
python3 bin/prepare-taskground-data.py
```

This regeneration command uses pinned upstream revisions for SemBench and BANKING77,
the WDC archive, and the existing local HelpSteer2 task. It records source hashes,
strips test labels/answer-bearing metadata, and regenerates deterministic subsets.
It makes no model calls. Downloads live in `taskground/.cache/` (ignored). Review
fixture changes before accepting new upstream content. Public dev scorers are
generated copies of `_shared/score.py`; regenerate them after changing that helper.

## Original task environments

The original larger environments below remain available for manual experiments.
They are not included in the four-task runner suite or its 200-call guidance.

| folder               | task                                                                 | needs                     |
| -------------------- | -------------------------------------------------------------------- | ------------------------- |
| `wikipedia_crawl/`   | build the English-Wikipedia flower link graph via the `wikigraph` CLI | python3, network (rate-limited) |
| `goldmark_profiling/` | profile the goldmark Markdown library (Go) and speed up a component with output-identical, test-green changes | go 1.26+, no network |
| `conversation_eval/` | design a grading workflow for HelpSteer2 assistant responses, calibrate on labelled dev data, score agreement with human raters on a held-out test split | python3; dataset included; model calls may need network |

Conventions used by the original task folders:

- Scripts run from any cwd and write bulky output to a `work/` directory inside the
  task folder, keeping stdout concise.
- Reference data (golden outputs, baselines, caches) lives inside the task folder, so
  a task can be reset without touching the rest of the repo.
- Paths in each task README are relative to that task folder unless specified otherwise.
