# Maintaining search_latency

Version 2 evaluates iterative profiling across recurring dashboard searches,
exploratory time windows, and mixed traffic with ingestion. The original fixture
was solved by one global-to-tenant revision change. That repair must now fail the
exploratory gate; the selective-access-only repair must fail the dashboard gate.
See DESIGN.md for the complete contract and reference implementation rationale,
and CALIBRATION.md for measured partial/full repair results.

Run validation without agent/model calls:

```sh
python3 -m unittest discover -s taskground/task_definitions/search_latency/maintainer -p 'test_*.py' -v
python3 taskground/task_definitions/search_latency/maintainer/smoke.py --output /tmp/search-latency-calibration
```

Smoke uses temporary workspaces, checks baseline and both partial repairs, checks
the full reference, and rejects disabled auditing, stale ingestion, timestamp-sorted
responses, and stale timestamp indexes. Optional
output retains complete verifier reports (samples, per-workload speedups,
construction/ingestion/lifecycle costs, correctness and evidence results).
All timings run serially; avoid competing CPU-heavy jobs. Exact ratios vary by
machine. When changing workload sizes, schedules, or thresholds, recalibrate all
four variants; full-reference success alone is insufficient.

Reference patches modify only searchapp/. Seeded and repaired implementations
must pass public correctness tests. The timestamp reference preserves original
arrival order and duplicates, handles bounds and out-of-order ingestion, and
maintains the existing locking and response-copy semantics. Alternative repairs
are accepted if they meet the same public contract and performance gates.

For fresh agent trials:

```sh
bun run taskground run search_latency --agent jive
bun run taskground verify RUN_ID --json
```

Existing task runs contain frozen definitions and are not updated by these edits.
The agent workspace contains no supplied graph or Jev quota. A harder task cannot
guarantee helper use. For a showcase, encourage evidence-based probe selection in
agent execution guidance; for evaluation, retain neutral task instructions and
compare planner-only and Jev-enabled runs.

A useful Jev decision receives source excerpts, profiles, grouped telemetry,
previous experiments, and a bounded set of candidate probes. The selected probe
must run before the planner resumes. A later decision can reassess residual cost
after the first fix. Deterministic calculations stay in code; original repair
implementation stays with the planner. Track useful branch decisions, planner
round trips, unnecessary probes, final correctness, performance, elapsed time,
and tokens/cost. Mere call count or post-hoc hypothesis labeling is not success.
