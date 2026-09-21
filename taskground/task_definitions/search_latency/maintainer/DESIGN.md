# Search latency fixture contract, version 2

Maintainer-only. Do not copy this file, the verifier, or reference repairs into the
agent workspace. The public application stays agent-neutral and uses only Python
3.10+ standard-library code. No model calls are needed to validate the fixture.

## Investigation shape

Two interacting performance problems replace the original one-step task:

1. Catalog cache tokens use the store's global revision. Audit batches advance
   that revision, making unchanged recurring dashboard results miss the cache.
2. Selective time-window queries decode records in arrival order and filter their
   timestamps afterwards. Each distinct exploratory query repeats that work.

Both appear as storage/decoding work in an initial profile. Fixing invalidation
alone helps dashboards but leaves exploratory traffic slow. Selective access alone
helps exploratory requests but leaves unbounded recurring dashboard scans intact.
Mixed traffic includes out-of-order ingestion and exercises both improvements.

The full reference repair switches to per-tenant trace revisions and maintains a
sorted (timestamp, insertion-position) index. Bounds select candidates with
bisect; selected positions are restored to insertion order before decoding.
Ingestion merges a sorted batch into the affected tenant's index while holding the
existing transaction lock. This is an example repair, not a mandated algorithm.

`reference_fix.patch` contains both changes. `invalidation_only.patch` and
`selective_only.patch` isolate them for calibration. Each partial repair must pass
its corresponding standalone workload and fail the other. The complete repair
must pass all gates with margin. No artificial sleeps, dummy CPU work, hidden
root-cause labels, or required helper-call counts belong in the application.

## Semantics

Keep the existing SearchService constructor and methods, query normalization,
exact tenant/request identity, inclusive timestamp bounds, limit behavior,
insertion ordering, duplicates, independent response objects, complete audit
receipts, and atomic ingestion. Timestamps can arrive in arbitrary order at load
and ingestion. Searches begun after ingestion returns see its results. Calls on
one service remain thread-safe. All seeded public correctness tests pass.

Telemetry keeps request/span/cache/scan/commit events, plus an ingestion span.
Request-group summaries separate recurring and exploratory traffic. Nested span
durations overlap and cannot be added as independent costs. Request timings
exclude construction; workload totals include ingestion barriers and final flush.
Construction and total lifecycle costs are recorded separately.

## Diagnostics

The three evaluated workloads are dashboard, exploratory, and mixed. Warm and
concurrent controls remain available. Dashboard keys are unbounded; exploratory
queries use distinct narrow windows. Mixed alternates both, with default ingestion
every 24 requests. Input generation shuffles arrival order deterministically.

Controls: recurring key count (`query-reuse`), window width, ingestion interval
and batch size, audit batching, cache/audit toggles, workers, request count, and
alternate generated data. Tenant-size experiments use setup's existing
records-per-tenant and output-dir controls. Changing query/data controls can
change response digests; component controls should preserve them.

`compare` requires an investigator-selected variable and at least two distinct
values. It does not automatically run the audit-off/cache-off experiments.
Overview, profile, trace, compare, and benchmark persist structured evidence.
Benchmark takes three fresh-service samples without instrumentation, serially.
Concurrent CPU profiling still aggregates per-request worker profiles; ingestion
at barriers is included in wall time and telemetry, but not those CPU profiles.

## Held-out verification

Generate independent tenant names, data, queries, shuffled arrivals, duplicate
records/timestamps, and out-of-order ingestion. Oracle checks bounded searches,
one-sided bounds, reversed bounds, limits, Unicode, isolation, response mutation,
audit accounting, and concurrent requests. Performance replays also check every
response against an independent oracle and every audit receipt, including explicit
queries immediately after ingestion.

Three serial samples per implementation, alternating execution order, for EACH:

- dashboard: 84 requests cycling six unbounded keys;
- exploratory: 84 distinct bounded windows with varying widths and limits;
- mixed: alternating requests, two 32-record arrivals at 28-request boundaries,
  and explicit bounded freshness probes after each arrival.

Each workload must achieve >=3x original/candidate median elapsed speedup.
Construction <=2.5x original +20ms, total ingestion <=max(5x original,25ms),
and construction+workload <=1.25x original lifecycle. These bounds allow index
construction/maintenance but reject excessive work moved out of request timing.
Correctness and integrity prerequisites gate performance evaluation. No algorithm
or internal event count is mandated as a performance solution.

Protect scripts, public tests, and regenerated default inputs. Evidence requires
mixed profile/text/report/trace-or-compare and three default-parameter benchmarks:
work/benchmark.json, work/dashboard/benchmark.json, work/exploratory/benchmark.json.
Reports and reasoning quality still require separate review.

## Validation and Jev evaluation

Smoke must reject the baseline and both partial repairs, accept the complete
reference, and reject disabled audits, stale ingestion, timestamp-sorted responses,
and stale timestamp indexes. Maintainer unit tests
check diagnostic provenance, selected comparisons, group evidence, ingestion
barriers, and performance/evidence gates. Retain calibration reports with smoke's
--output option; do not ship generated data or timing artifacts in workspace/.

Useful semantic delegation selects the next distinguishing probe from evidence,
then executes that probe before the planner resumes. Reassessing remaining cost
after a first improvement provides a second opportunity. Counts, digests, timing
ratios, and simple numerical branches stay in code. Low-confidence/unsupported
choices yield to the planner. Never put a root-cause-specific graph in the task.

For an explicit showcase, agent execution guidance can encourage this bounded
probe-selection workflow; keep it separate from neutral task instructions.
Measure decisions that cause useful downstream work, planner turns avoided,
unnecessary probes, diagnosis accuracy, correctness, latency, and tokens/cost.
More Jev calls alone do not establish a better investigation.
