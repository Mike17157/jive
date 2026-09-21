# Search latency fixture contract

Maintainer-only coordination document. Do not copy this file into the workspace.

This task is an original Python-standard-library in-process search endpoint. The
agent must investigate uneven latency across workloads, repair the implementation,
and retain profiling/benchmark/controlled-experiment evidence. No supplied graph,
Jev instruction, or root-cause label belongs in the workspace.

The seeded defect is cache invalidation coupled to the store's global commit
revision: batched audit writes advance it, even though searchable records have
not changed. A tenant's data revision is already available, and the reference fix
changes the catalog cache token to that revision. Queries span enough cache keys
that audit flushes erase reuse in mixed traffic. Disabling audit is a diagnostic
control, never an acceptable production fix. Ingestion must still invalidate the
affected tenant. CPU profiles show scanning/decoding; cache events, commit events,
and controlled experiments are needed to explain why scans keep happening.

## Stable interfaces (shared with implementation agents)

Workspace package `searchapp`, exported `SearchService`:

```python
service = SearchService(data_path, cache_enabled=True, audit_enabled=True,
                        audit_batch_size=4, cache_capacity=64, recorder=None)
response = service.handle({"request_id": "r1", "tenant": "alpha", "query": {...}})
service.ingest("alpha", [record, ...])
service.flush_audit()
service.audit_records()  # persisted records, after explicit flush
service.close()          # flushes audit
```

Data is UTF-8 JSONL, each object has `tenant`, `id`, `timestamp`, `service`,
`level`, `message`, `tags`, optional ignored `context`. Required textual fields
and tags are strings, timestamp is an integer. Query semantics match
slow_trace_search: NFKC/casefold/strip, levels/services accepted sets, tags/terms
all-of, inclusive timestamp bounds, nonnegative limit; unknown query fields
ignored. Tenant and request_id are exact nonempty strings (not normalized).
Missing tenants return no rows. Return exactly `request_id`, `tenant`, `rows`;
each row has exactly id,timestamp,service,level,message,tags in that order.
Preserve insertion order and duplicates. Responses are independent mutable copies.
Every successful handle call creates exactly one audit entry (when enabled),
including cache hits, with request_id,tenant,row_count. Flush persists pending
entries without duplication. Concurrent calls on the SAME service are supported;
ingest is atomic and searches begun after it returns see its data. No network.

Optional recorder is callable: `recorder(event_dict)`; events contain `event`
and monotonic `time_ns`, request_id for request work, and operation-specific
metadata. Span events use `event="span"`, `operation`, `duration_ns`.
Operations: `request`, `lock.wait`, `query.plan`, `cache.lookup`, `storage.scan`,
`filter`, `serialize`, `audit.flush`. Instant events: `cache` with hit(bool),
tenant, token, key; `commit` with collection (`audit` or `traces`), revision,
tenant (null for audit); `scan` with tenant, records count. Recorder must be
thread-safe if diagnostic harness uses concurrency. No shared global recorder.

## Harness owned by scripts/tests agent

`scripts/setup.py`: deterministic generator, produces data/traces.jsonl and
data/MANIFEST.json with SHA256; seed 731 default, 6000 records per tenant across
alpha/beta/gamma; CLI --seed, --records-per-tenant, --output-dir. Use records
containing `needle` every 211th row, other varied messages, Unicode text,
services api/worker/search, levels info/warn/error and tags prod/zone-N.

`scripts/diagnose.py`: argparse CLI with commands overview, profile, trace,
compare, benchmark. --workload warm|mixed|cold|concurrent (default mixed),
--requests (default 72), --workers (default 1 except concurrent 4), --audit on|off,
--cache on|off, --audit-batch-size (default 4), --output DIR (default work),
--data PATH. Each measurement creates a fresh service and excludes fixture load.
Warm: one repeated query; mixed: six recurring tenant/query combinations; cold:
unique queries; concurrent: same combinations through ThreadPoolExecutor. Queries
use terms needle and e.g. service/level filters, limit 12 (or no limit). Avoid
queries that all return empty rows. Mixed six keys MUST cycle across flushes of 4.
Plain benchmark has no recorder, >=3 serial samples, records samplesSeconds,
medianSeconds, p50/p95 request latency, response digest. Profile saves valid
profile.pstats and profile.txt; trace writes JSONL events and aggregate stats;
overview runs each workload serially; compare runs defaults, audit off, cache off
serially with output/digests and cache/scan/commit metrics. Every command saves
machine-readable JSON under output, stdout concise JSON. Diagnostics do not print
root cause or recommendations. Expose workload builder/helpers in scripts/support.py
for smoke use; avoid external dependencies. Never run competing benchmarks.
Public tests test query semantics, isolation, audit on cache hits/flush, ingestion,
mutable response copies, concurrency correctness. They PASS seeded implementation.

## Verifier owned by verifier agent

Use existing Taskground env contract/result format. Load candidate and frozen
searchapp with importlib aliases. Generate held-out data independently (new seeds,
tenant names, Unicode, duplicates); independent oracle checks queries and sequence
of ingestion/audit/cache mutations, response aliasing, concurrent requests.
Audit data must remain complete with default audit enabled. Performance: three
serial samples each, fresh service, exclude load; 72-96 mixed requests cycling six
keys, sufficient data; >=3x candidate vs frozen with matching responses. No
artificial sleeps. Protect scripts/ and tests/test_public.py by comparing frozen
definition bytes; compare generated input hashes against a fresh default setup
in a temp directory (never trust workspace manifest alone). Require nonempty
work/report.md, work/profile.pstats, work/profile.txt, work/benchmark.json and
at least one trace/compare evidence file; structurally validate machine artifacts.
Reference fix is maintainer/reference_fix.patch, generated by root agent after
package is ready. Smoke copies clean workspace to temp, setup, public tests,
diagnostics evidence, baseline verifier fails performance, apply reference patch,
same evidence commands, fixed verifier passes. Keep runtimes modest. Additional
negative checks disabling audit or ignoring data invalidation should fail.

No agent calls are necessary to build or smoke-test the fixture. Model behavior
and report reasoning quality are separately evaluated through run trace review.
