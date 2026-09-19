# taskground

Self-contained task environments. Each subfolder describes its inputs, task-specific
tools, constraints, output formats, and success criteria. Execution-system knowledge
comes from the agent's own context; these tasks do not prescribe its orchestration.

| folder               | task                                                                 | needs                     |
| -------------------- | -------------------------------------------------------------------- | ------------------------- |
| `wikipedia_crawl/`   | build the English-Wikipedia flower link graph via the `wikigraph` CLI | python3, network (rate-limited) |
| `goldmark_profiling/` | profile the goldmark Markdown library (Go) and speed up a component with output-identical, test-green changes | go 1.26+, no network |
| `conversation_eval/` | design a grading workflow for HelpSteer2 assistant responses, calibrate on labelled dev data, score agreement with human raters on a held-out test split | python3; dataset included; model calls may need network |

Conventions shared by every task folder:

- Scripts run from any cwd and write bulky output to a `work/` directory inside the
  task folder, keeping stdout concise.
- Reference data (golden outputs, baselines, caches) lives inside the task folder, so
  a task can be reset without touching the rest of the repo.
- Paths in each task README are relative to that task folder unless specified otherwise.
