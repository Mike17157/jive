# Search latency v2 calibration

Measured on 2026-09-21 using Darwin arm64, Python 3.14.2.

Three serial samples per implementation and workload; original and candidate order
alternates. Each workload independently requires at least 3× speedup. Ratios are
same-machine observations, not portable absolute performance promises.

| Variant | Dashboard | Exploratory | Mixed with ingestion | Overall |
| --- | ---: | ---: | ---: | --- |
| Seeded baseline | 0.99× | 1.00× | 1.00× | failed |
| Invalidation only | 13.76× | 0.99× | 2.67× | failed |
| Selective access only | 0.99× | 32.72× | 1.19× | failed |
| Complete reference | 13.72× | 32.34× | 4.81× | passed |

All four variants passed held-out correctness, sealed-input, and artifact checks;
the baseline and partial repairs failed performance gates. All variants stayed
within the construction, ingestion, and lifecycle cost limits. The complete
reference also passed those limits.

Separate incorrect variants were rejected by held-out correctness:
disabled auditing, stale result-cache invalidation after ingestion, timestamp-order
output instead of insertion order, and a timestamp index not updated on ingestion.

Validation:

```sh
python3 -m unittest discover -s taskground/task_definitions/search_latency/maintainer -p 'test_*.py' -v
python3 taskground/task_definitions/search_latency/maintainer/smoke.py --output /tmp/search-latency-v2-smoke-final
bun test tests/taskground.test.ts --test-name-pattern 'search latency prepares'
```

The maintainer suite passes 14 tests, and the task preparation integration test
passes. Full smoke reports were retained at the output directory above. The final
artifact-only adjustment represents absent benchmark telemetry as null instead
of zero scan counts; it was covered by the maintainer suite and preparation test.

No agent/model trial was run as part of calibration. This establishes the
performance separation and correctness contract, not improved Jev adoption.
Use a fresh Taskground run to evaluate probe-selection behavior; existing runs
retain their frozen definitions.
