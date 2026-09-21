# Maintainer notes

Run the local standard-library smoke test from the repository root:

```sh
python3 taskground/task_definitions/async_blocking_audit/maintainer/smoke.py
```

It proves that the reference audit passes and that empty, blanket-positive,
wrong-location/category, malformed, and source-tampered submissions fail. The
verifier does not import or execute Home Assistant.

`reference_sites.json` is a reviewed alternatives catalog, not a requirement to
report every listed negative. Unknown well-formed findings remain visible in
the verification metrics for manual review. The deterministic gate requires
all three confirmed sites and a varied subset of independently checked
lookalikes and unresolved boundaries.

The verifier checks source integrity, JSON types, duplicate keys and locations,
real line ranges, local evidence, broad source coverage, held-out known-site
classifications, and report-to-finding cross references. It can establish that
citations exist and that a known classification matches; it cannot fully judge
the prose semantics of a novel finding or prove runtime latency. Caller-path
symbols are schema checked and line bounded, but their semantic ordering still
requires review.
