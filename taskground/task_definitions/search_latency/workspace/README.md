# Uneven search latency

`searchapp` is a local multi-tenant trace search endpoint. It has request planning,
a bounded result cache, a document store, response serialization, and batched audit
receipts. The endpoint returns correct results, but dashboard searches, exploratory
time-window searches, and mixed traffic with ingestion are unexpectedly expensive.
Investigate the causes and make maintainable improvements.

This environment uses Python 3.10+ and the standard library. There is no server to
start, network service, or dependency installation. The endpoint is exercised
directly so network timing does not obscure application behavior.

## Public API

```python
from searchapp import SearchService

service = SearchService("data/traces.jsonl")
response = service.handle({
    "request_id": "request-1",
    "tenant": "alpha",
    "query": {"terms": ["needle"], "limit": 12},
})
service.ingest("alpha", [new_record])
service.flush_audit()
receipts = service.audit_records()
service.close()
```

Each service owns its in-memory store, loaded from the JSONL seed file. Ingested
records and audit receipts live for the lifetime of that instance; the seed file
is never modified. Multiple threads may call the same service. Searches started
after `ingest` returns must see the appended records. An ingestion batch is atomic.

Requests have an exact, nonempty string `request_id` and `tenant`, plus an optional
query mapping. Tenant identifiers are case-sensitive and are never normalized.
Unknown tenants return empty results. Responses contain exactly `request_id`,
`tenant`, and `rows`; the first two echo the request. Callers may mutate responses
without changing future results.

Queries support:

- `levels` and `services`: sequences of accepted values; empty means unrestricted.
- `tags`: every requested tag must occur. Repeating a requested tag has no effect.
- `terms`: every requested term must be a substring of the message.
- `min_timestamp` and `max_timestamp`: inclusive integer bounds.
- `limit`: nonnegative maximum number of rows; zero returns no rows, negative
  values raise `ValueError`. Omission or `None` means no limit.

Textual comparisons and returned text use
`unicodedata.normalize("NFKC", value).casefold().strip()`. Each row has exactly
these keys, in this order: `id`, `timestamp`, `service`, `level`, `message`, `tags`.
Text fields and tags are strings; timestamp is an integer. Tags keep their order
and duplicates. Records retain insertion order and duplicate records stay
duplicated. Unknown query/record fields are ignored. Required fields are present
in valid input. Blank lines in the seed file are ignored. Arrival order is
independent of timestamp order, including within ingestion batches.

Every successful request, including a cached result or an empty result, produces
one audit receipt containing `request_id`, `tenant`, and `row_count`. Receipts are
batched; `flush_audit()` or `close()` persists all pending receipts exactly once.
`audit_records()` returns independent copies of persisted receipts. Receipt order
for concurrent requests is unspecified. Audit recording must stay enabled in the
delivered implementation.

Constructor options `cache_enabled=True`, `audit_enabled=True`,
`audit_batch_size=4`, and `cache_capacity=64` are supported for controlled
experiments. Batch size and cache capacity must be positive. Disabling a component
is a diagnostic control, not permission to remove its behavior from the fix.
An optional `recorder(event_dict)` receives structured telemetry; a recorder used
with concurrent requests must be thread-safe.

## Diagnostic tools

Setup runs automatically. To reproduce the supplied inputs, run
`python3 scripts/setup.py`. Preserve these inputs. For size/seed experiments,
use another directory, for example:

```sh
python3 scripts/setup.py --records-per-tenant 12000 --seed 917 --output-dir work/large/data
python3 scripts/diagnose.py benchmark --workload exploratory --data work/large/data/traces.jsonl --output work/large
```

Start with the public tests and an overview; select subsequent probes based on
what the evidence leaves unresolved:

```sh
python3 -m unittest discover -s tests -v
python3 scripts/diagnose.py overview --output work/before
python3 scripts/diagnose.py profile --workload mixed --output work/before/mixed
python3 scripts/diagnose.py trace --workload mixed --output work/before/mixed
```

Workloads:

| Name | Request mix | Default ingestion |
| --- | --- | --- |
| `dashboard` | Six recurring tenant/query combinations, without timestamp bounds | None |
| `exploratory` | Distinct bounded windows, cycling tenants | None |
| `mixed` | Alternating dashboard and exploratory requests | 24 records every 24 requests |
| `warm` | One recurring query | None |
| `concurrent` | Dashboard queries shared across four worker threads | None |

All commands accept `--requests`, `--workers`, `--audit on|off`,
`--cache on|off`, `--audit-batch-size`, and `--data`. Workload controls are:

- `--query-reuse N`: number of recurring dashboard keys (default 6; larger means
  less reuse). This does not affect exploratory requests.
- `--window-width N`: inclusive exploratory timestamp range width (default 64).
  Window positions stay fixed when varying width.
- `--ingest-every N`: ingest between batches of N requests (0 disables).
- `--ingest-batch-size N`: records per ingestion batch (default 24).

Ingestion happens at batch barriers, including with multiple workers. New records
may have older timestamps. `overview` runs workloads serially. `profile` saves
`profile.pstats`, `profile.txt`, and JSON metadata. `trace` saves timed JSONL events
and summaries. Request groups have separate latency, cache, and scan summaries;
phases separate batches before and after ingestion. Ingestion spans and commits
remain visible in overall telemetry.

`compare` requires an explicit variable and two or more values. It runs each
configuration serially, with a fresh service:

```sh
python3 scripts/diagnose.py compare --workload exploratory --vary window-width --values 32 256 2048 --output work/window-experiment
```

Available variables: `audit`, `cache`, `audit-batch-size`, `query-reuse`,
`window-width`, `ingest-every`, and `ingest-batch-size`. Boolean values are `on`
and `off`; other values are integers. Changes to query shape or ingestion can
legitimately change response digests. Disabling a component is only a diagnostic
control. The comparison tool reports observations without choosing a diagnosis.

Each benchmark uses three serial samples with no event recorder. Request workload
time includes scheduled ingestion and the final audit flush. Group telemetry
metrics are null in uninstrumented benchmarks; use trace/profile for scan counts. Construction is
measured separately; `loadSamplesSeconds` and `lifecycleSamplesSeconds` expose
cost moved into startup. Per-group request latencies exclude ingestion, whereas
total workload elapsed time includes it. Instrumented timings are diagnostic,
not substitutes for benchmarks. Nested spans overlap; do not sum them as
independent costs. Concurrent CPU profiles merge worker request profiles;
ingestion at barriers appears in telemetry/wall time, not worker CPU profiles.
Run timing experiments serially without competing CPU-heavy tasks.

## Deliverables and evaluation

Change `searchapp/` and add regression tests as needed. Preserve `scripts/`,
`tests/test_public.py`, and `data/`. Do not substitute precomputed answers or
special-case fixtures. Keep constructor controls operational. Put new diagnostic
scripts under `work/`; additions to the supplied `scripts/` are also checked.

Preserve before-change evidence in separate directories. Re-profile remaining
cost after improvements. Final artifacts use the default parameters, at least
72 requests, one worker, and cache/audit enabled:

```sh
python3 scripts/diagnose.py profile --output work
python3 scripts/diagnose.py trace --output work
python3 scripts/diagnose.py benchmark --output work
python3 scripts/diagnose.py benchmark --workload dashboard --output work/dashboard
python3 scripts/diagnose.py benchmark --workload exploratory --output work/exploratory
```

Deliver `work/report.md`, `work/profile.pstats`, `work/profile.txt`, all three
benchmarks above, and trace or controlled-comparison evidence. Explain hypotheses,
why each experiment distinguished them, remaining bottlenecks after changes,
before/after results for every evaluated workload, correctness checks, and
reproduction commands.

The verifier requires **at least 3× speedup independently on dashboard,
exploratory, and mixed traffic**. It uses three serial samples of original and
candidate implementations, alternating order on the same machine, with unseen
records, tenants, queries, and ingestion schedules. Responses must match an
independent oracle and audit receipts must be complete.

For each workload, candidate construction must take no more than 2.5× original
construction plus 20 ms; total ingestion time must not exceed the larger of 5×
original ingestion time or 25 ms; construction plus workload time must not exceed
1.25× the original lifecycle time. These allowances permit index maintenance but
limit improvements obtained solely by shifting excessive work outside timing.
Correctness covers Unicode/query semantics, exact tenant isolation, duplicate
and insertion-order preservation, out-of-order arrivals, freshness, independent
responses, and concurrency. Evaluation accepts alternative implementations that
meet the contract; it does not require a particular data structure.

Investigation quality and efficient experiment selection require separate run
review. A passing benchmark alone does not establish a causal diagnosis.
