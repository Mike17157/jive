# Uneven search latency

`searchapp` is a local multi-tenant trace search endpoint. It has request planning,
a bounded result cache, a document store, response serialization, and batched audit
receipts. The endpoint returns correct results, but latency under recurring mixed
traffic is unexpectedly high. Investigate the cause and make a maintainable fix.

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
in valid input. Blank lines in the seed file are ignored.

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

Setup runs automatically when Taskground prepares a workspace. To reproduce the
same seed inputs manually, run `python3 scripts/setup.py`. Do not change supplied
inputs. Experiments with different generated data must use a separate output path.

```sh
python3 -m unittest discover -s tests -v
python3 scripts/diagnose.py overview --output work/before
python3 scripts/diagnose.py profile --workload mixed --output work/before
python3 scripts/diagnose.py trace --workload mixed --output work/before
python3 scripts/diagnose.py compare --workload mixed --output work/experiments
python3 scripts/diagnose.py benchmark --workload mixed --output work/before
```

Use `python3 scripts/diagnose.py --help` and command `--help` for options.
Commands persist JSON artifacts and print a concise JSON result. Profiling also
saves `profile.pstats` and `profile.txt`; tracing saves individual JSONL events.
Output directories let you preserve observations before modifying code.

The four workload shapes are `warm` (one recurring query), `mixed` (several
recurring tenant/query combinations), `cold` (unique queries), and `concurrent`
(recurring requests sharing one service across worker threads). Options include
request count, worker count, audit batch size, `--audit on|off`, `--cache on|off`,
and an alternate `--data` file. `compare` runs component controls serially.

Each measurement begins with a fresh service and excludes seed loading from
request timing. Benchmarks use at least three serial samples and no event
recorder. Trace timings include instrumentation overhead and are diagnostic, not
substitutes for an uninstrumented benchmark. Span durations are inclusive and may
overlap: a storage iterator can remain open while its caller filters records.
Do not sum nested spans as independent costs. Run timing experiments serially,
without other CPU-heavy tasks competing for the same machine.

## Deliverables and evaluation

Change `searchapp/` and add regression tests as needed. Preserve `scripts/`,
`tests/test_public.py`, and `data/`. Do not substitute precomputed answers or
special-case known fixtures. Keep the documented constructor controls operational.
Put additional investigation scripts under `work/`; the supplied `scripts/`
directory is checked for additions as well as edits.

Preserve baseline evidence in a separate directory. After the fix, run the public
tests and the diagnostic tools with normal component settings, writing final
artifacts to `work/`:

```sh
python3 scripts/diagnose.py profile --output work
python3 scripts/diagnose.py benchmark --output work
python3 scripts/diagnose.py trace --output work
```

The final benchmark must use the mixed workload with at least 72 requests, one
worker, and caching and auditing enabled. These are the command defaults.

Deliver `work/report.md`, `work/profile.pstats`, `work/profile.txt`,
`work/benchmark.json`, and trace or controlled-comparison evidence. The report
should explain the causal mechanism, competing explanations and experiments,
correctness checks, before/after performance across workloads, and reproduction
commands. Profiling alone may identify expensive work without explaining why it
recurs.

The performance target is at least **3× faster total elapsed time** on recurring
mixed traffic with auditing enabled. The verifier compares the frozen starting
implementation with yours using three serial samples on the same machine and
unseen data. It checks Unicode/query semantics, isolation, duplicates, ingestion
freshness, mutable response independence, audit completeness, and concurrency.
Diagnosis quality and efficient investigation require separate run-trace review;
passing a timing threshold alone does not establish the cause.
