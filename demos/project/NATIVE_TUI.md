# Three-agent native TUI captures

The six `Jive vs Codex vs Claude - <task>.mp4` edits use timed output from the
actual Jive, Codex, and Claude Code interactive terminals. They are not activity
summaries reconstructed from agent logs. Each complete 120 × 36 terminal is
replayed through xterm and rendered side by side, without cropping its viewport.

This batch is identified by run IDs starting `20260921T1936` or `20260921T1937`
under the local Taskground run store. The original timed PTY output is retained
as `terminal.cast` in each run directory. Set `TASKGROUND_CAPTURE_TUI=1` when
launching future terminal runs to retain the same format. The capture test checks
that its concatenated output matches the raw terminal log, including ANSI and
split UTF-8, and that resize events and monotonic timestamps are retained.

Playback uses a shared source clock: 10× until the first agent finishes, then
50× until the last finishes, followed by a six-second hold. Completed panes
freeze after a one-second final-repaint allowance at their completion boundary.
Headers show agent, model, effort, and boxed source-time/playback counters.
Each pane's source clock stops at that agent's own completion time.
Large completion banners appear below each finished terminal, without hiding any
TUI rows, and show that agent's elapsed time. The underlying TUI content is retained apart from known
credential redaction. Original raw casts remain local and can contain secrets;
do not publish them without a separate review. Times include
startup and initial native trust prompts. These 18 runs were launched concurrently;
they are illustrative single runs, not isolated/repeated performance measurements.

## Reproduce locally

Requires Bun, ffmpeg, Pillow and fonttools in `.venv`, and the macOS Menlo/Arial fonts. From the
repository root, after all three runs for a task finish:

```sh
bun demos/project/export_tui_frames.ts slow_trace_search
demos/project/.venv/bin/python demos/project/render_native_tui.py slow_trace_search
bun demos/project/native_benchmark_stats.ts
```

The exporter and stats script currently select this specific local run batch.
`monitor_native_benchmarks.ts` watches that batch and renders completed groups;
optional task arguments identify videos already rendered. Generated frame JSON
and previews are ignored under `tui-generated/`. The repository also ignores
`demos/edits/`; README video links refer to local files until the videos are
separately published or deliberately included in version control.

## Counter scope

- Time: Taskground's native task-completion boundary, not terminal process exit.
  Claude background tasks must also have completion notifications followed by a
  final native turn boundary; an idle prompt with outstanding jobs is not done.
- LLM calls/output tokens: main-agent planner requests/responses and reported
  output usage; Claude blocks are deduplicated by message ID and Codex usage by
  response ID. Hidden retries without usage records cannot be counted.
- Tool calls: native main-agent tool invocations; for Jive, executed leaf nodes
  (including Jev nodes). Jev decisions are also shown separately.
- Task-authored helper-model calls, child-agent calls/tokens, and Jev output
  tokens are excluded from the main-agent LLM/output-token columns.

The benchmark summary deliberately omits success labels and task-quality scores.
The unaltered native TUI can naturally show the agents' own discussion of results.
