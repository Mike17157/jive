# Investigate uneven search latency

This local multi-tenant trace search endpoint returns correct results, but repeated
production-like requests are unexpectedly expensive. Latency varies substantially
with the request mix. Find the cause, demonstrate it with measured evidence, and
optimize the implementation while preserving the public API and behavior.

Aim for at least a 3× reduction in total elapsed time on the mixed workload, with
audit recording enabled. Preserve tenant isolation, result ordering, Unicode
normalization, fresh results after ingestion, independent response objects, and
concurrent correctness. Use only Python's standard library. Keep the fix maintainable.

Read README.md for the application and diagnostic commands. Establish baseline
evidence, use controlled experiments to distinguish explanations, and validate the
fix across workloads. Preserve the supplied scripts, public tests, and generated
inputs. Add regression tests as needed. Record your diagnosis, alternatives tested,
before/after evidence, and reproduction commands in work/report.md. Retain profiler,
benchmark, and trace or controlled-comparison artifacts under work/.
