# Investigate uneven search latency

This local multi-tenant trace search endpoint returns correct results, but
production-like requests are unexpectedly expensive. Recurring dashboard searches,
exploratory searches over changing time windows, and traffic with new arrivals have
different latency patterns. Investigate and optimize the implementation while
preserving the public API and behavior.

Achieve at least a 3× reduction in elapsed time separately on dashboard,
exploratory, and mixed workloads, with audit recording enabled. Mixed traffic
includes ingestion. Keep construction and ingestion costs reasonable; moving work
outside request timing is measured too. Preserve tenant isolation, insertion order,
duplicates, Unicode normalization, fresh results after ingestion, independent
response objects, and concurrent correctness. Timestamps need not arrive in order.
Use only Python's standard library and keep the fix maintainable.

Read README.md for the application, workload controls, and evaluation contract.
Establish baseline evidence for each traffic pattern. Choose controlled experiments
that distinguish competing explanations, reassess the remaining cost after each
change, and validate across workloads. Preserve supplied scripts, public tests,
and generated inputs. Add regression tests as needed. Record your diagnosis,
alternatives tested, before/after evidence, and reproduction commands in
work/report.md. Retain profiler, benchmark, and trace or comparison artifacts under
work/, including the three final workload benchmarks described in README.md.
