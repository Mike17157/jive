# Trace query performance task

`tracequery` is a small, dependency-free JSONL log search library. Its output is correct, but production-like searches over `data/traces.jsonl` have regressed and now take seconds. Your job is to profile and optimize the implementation without changing observable behavior.

## Public API and semantics

```python
from tracequery import search
rows = search("data/traces.jsonl", query)
```

`query` is a mapping with these optional keys:

- `levels`: a sequence of accepted log levels.
- `services`: a sequence of accepted service names.
- `tags`: every requested tag must occur in the record's tags. Repeated requested tags have no additional effect.
- `terms`: every requested term must be a substring of the record message.
- `min_timestamp` / `max_timestamp`: inclusive integer bounds.
- `limit`: non-negative maximum number of returned rows.

All textual comparisons use `unicodedata.normalize("NFKC", value).casefold().strip()`. Text in returned rows is normalized the same way. Input lines are processed in file order; blank lines are skipped; matching duplicate lines remain duplicate output rows. Search stops once `limit` rows have been collected. Unknown record and query fields are ignored.

Every returned dictionary has exactly these keys, in this insertion order:

```text
id, timestamp, service, level, message, tags
```

`id` and the four textual fields are strings after normalization, `timestamp` is an integer, and `tags` is a list in its original order (including duplicates). Fixtures contain valid UTF-8 JSON objects with those six required fields.

## Commands

The setup command is safe and deterministic:

```sh
python3 scripts/setup.py
```

Run the quick functional workload, public tests, profiler, and benchmark:

```sh
python3 -m unittest discover -s tests -v
python3 scripts/quick_workload.py
python3 scripts/profile.py
python3 scripts/benchmark.py
```

The last two commands write `work/profile.pstats`, `work/profile.txt`, and `work/benchmark.json`. The benchmark is intentionally quick enough for iteration, but the initial implementation may take several seconds. Save baseline evidence before overwriting it, for example `cp work/benchmark.json work/benchmark-before.json`.

The grading target is at least **3× faster** on a held-out workload, with identical results. The verifier measures three serial samples of both the frozen starting implementation and your candidate on the same machine. Do not run competing benchmarks concurrently. The reference optimization has ample margin above this threshold; exact timings depend on hardware.

## Deliverables

- Optimized source in `tracequery/`, with the `search(path, query)` API intact.
- Passing public tests.
- `work/profile.pstats`, `work/profile.txt`, and `work/benchmark.json` produced by the supplied commands.
- `work/report.md` describing the measured bottleneck, changes, correctness checks, before/after timings, and reproduction commands.

Use only the Python standard library. Do not modify `data/`, `scripts/`, or the supplied `tests/test_public.py`; add new tests under `tests/` when needed. Held-out checks use new trace files, Unicode spellings, duplicate records, different ordering and query combinations; avoid fixture-specific shortcuts or cached answers. Automated grading checks evidence presence and behavior; report quality and the investigation method require trace review.
