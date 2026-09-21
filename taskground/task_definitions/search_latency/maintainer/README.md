# Maintaining search_latency

This is a fixture for evaluating adaptive investigation, not a prescribed graph
or a claim that helper calls improve every run. Its workspace is deliberately
agent-neutral. The task runner copies only `workspace/` to the agent's repository;
this directory and `verifier/` remain outside it.

The application exposes several plausible first explanations for mixed-traffic
latency: decoding/filtering cost, cache reuse, serialized access, response copies,
and audit work. Profiling shows where time goes; a controlled experiment plus
event/source relationships explains why that work recurs. Baseline public tests
pass. The intended repair changes the catalog token from the global commit
revision to the tenant's searchable-data revision. Audit writes still persist,
and ingestion still invalidates results. See `reference_fix.patch`.

Run the fixture validation without any model calls:

```sh
python3 taskground/task_definitions/search_latency/maintainer/smoke.py
python3 -m unittest discover -s taskground/task_definitions/search_latency/maintainer -p 'test_*.py' -v
```

The smoke check uses temporary workspaces, verifies that the starting application
fails the speed requirement, applies the reference repair, and checks that it
passes. Deliberately disabling auditing or breaking ingestion must be rejected.
Benchmark samples are serial and service construction is excluded. Do not run this
alongside other CPU-heavy checks. Exact ratios depend on the machine.

For agent trials, start a fresh Taskground run:

```sh
bun run taskground run search_latency --agent jive
bun run taskground verify RUN_ID --json
```

Useful investigation graph decisions could route from workload observations to
cache, storage, or contention evidence; choose controlled experiments; and decide
whether another prepared probe is needed. Jev should receive the relevant source,
observations, candidate explanations, and task constraints. It does not generate
the repair. Raw counts, digests, and timing comparisons belong in code. There is
no requirement to use Jev, and no supplied graph to replay.

Compare planner-only and graph/Jev trials using diagnosis correctness, unnecessary
probes, planner round trips, tokens/cost, elapsed time, and final behavior. A call
only demonstrates useful delegation if its result leads to meaningful work before
the planner resumes, or avoids substantial evidence interpretation by the planner.
Do not score an arbitrary call quota as success. Record full graph and model
traces; the automated verifier cannot establish causal reasoning quality.

The initial version contains one reproducible defect. Data, tenants, query shapes,
and ingestion sequences differ in hidden validation. Randomly selecting among
multiple defect families is a possible later extension, not implemented here.
