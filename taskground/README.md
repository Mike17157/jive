# taskground

Self-contained task environments for exercising the Jive agent. Each subfolder is
one task family with its own README written for an agent that starts there with no
other context: layout, tooling, the dev loop, and the definition of done.

| folder               | task                                                                 | needs                     |
| -------------------- | -------------------------------------------------------------------- | ------------------------- |
| `wikipedia_crawl/`   | build the English-Wikipedia flower link graph via the `wikigraph` CLI | python3, network (rate-limited) |
| `goldmark_profiling/` | profile the goldmark Markdown library (Go) and speed up a component with output-identical, test-green changes | go 1.26+, no network |

Conventions shared by every task folder:

- Scripts run from any cwd and write bulky output to a `work/` directory inside the
  task folder, keeping stdout short enough for a planner's context.
- Reference data (golden outputs, baselines, caches) lives inside the task folder, so
  a task can be reset without touching the rest of the repo.
- From an `execute_graph` bash node, each node is its own process in the session
  working directory, so use paths relative to the repo root such as
  `taskground/goldmark_profiling/scripts/check.sh`.
