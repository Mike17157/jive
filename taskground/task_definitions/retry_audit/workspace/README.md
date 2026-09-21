# Apache Airflow retry audit

This is a static, offline audit of a selected Apache Airflow snapshot. The corpus is pinned to commit `ecfa5a139c35f365836c0f462029537023d0357e`; individual source URLs and hashes are in `corpus/MANIFEST.json`. It includes provider implementations, shared helpers, callers, and the tests that existed at that commit. No Airflow environment or third-party packages are needed because the task is source analysis, not test execution.

Read `POLICY.md` before classifying candidates. Search broadly across `corpus/airflow` and use `corpus/tests` to test your interpretation. The source slice intentionally includes genuine problems and healthy retry-shaped code. Local examples under `examples/` illustrate expected invariants; they are original task material rather than upstream code and are not findings.

Inventory at least 30 distinct candidate locations across at least 12 source files and four functional areas. Every inventoried location must resolve to a finding, rejected candidate, or unresolved question. Investigation quality matters more than maximizing issue count: submit between 4 and 16 actionable findings and at least 8 rejected candidates. Evidence must cite real, bounded line spans no longer than 40 lines. Each finding needs 2–8 evidence entries; each rejection needs 1–4. Include source plus a caller, state/helper definition, or relevant test when the corpus contains one. An entire file is not bounded evidence.

Create `work/findings.json` with this shape:

```json
{
  "schemaVersion": 1,
  "scope": {
    "upstream": "apache/airflow",
    "commit": "ecfa5a139c35f365836c0f462029537023d0357e"
  },
  "findings": [
    {
      "id": "stable-local-id",
      "classification": "correctness_defect",
      "severity": "high",
      "confidence": "high",
      "title": "Concise behavior-level title",
      "primaryLocation": {"path": "airflow/...py", "line": 123},
      "evidence": [
        {"path": "airflow/...py", "startLine": 120, "endLine": 137, "claim": "What these lines demonstrate"},
        {"path": "tests/...py", "startLine": 40, "endLine": 61, "claim": "What this companion evidence adds"}
      ],
      "behavior": {
        "trigger": "Concrete preconditions",
        "actual": "Current result",
        "expected": "Contract-preserving result",
        "impact": "User or system consequence"
      },
      "recommendation": "Specific fix and regression-test direction"
    }
  ],
  "rejectedCandidates": [
    {
      "id": "stable-local-id",
      "path": "airflow/...py",
      "line": 123,
      "category": "legitimate_polling",
      "reason": "Why this is healthy under POLICY.md",
      "evidence": [{"path": "airflow/...py", "startLine": 118, "endLine": 135, "claim": "Bounded support"}]
    }
  ],
  "unresolved": [
    {
      "id": "stable-local-id",
      "path": "airflow/...py",
      "line": 123,
      "question": "Decision still open",
      "missingEvidence": "Dependency or contract absent from the snapshot",
      "nextStep": "Concrete follow-up"
    }
  ],
  "coverage": {
    "areas": ["area-a", "area-b", "area-c", "area-d"],
    "reviewedPaths": ["airflow/...py"],
    "candidateSites": [
      {"path": "airflow/...py", "line": 123, "disposition": "finding", "recordId": "stable-local-id"}
    ],
    "searchNotes": "Queries and follow-up strategy, including source/caller/test traversal"
  }
}
```

Allowed finding classifications are `correctness_defect` and `migration_candidate`; severities are `critical`, `high`, `medium`, or `low`; confidence is `high`, `medium`, or `low`. Rejection categories are `legitimate_polling`, `shared_retry_helper`, `sdk_managed_retry`, `bounded_local_retry`, and `configuration_only`. `unresolved` may be empty. Paths are relative to `corpus/`, use `/` separators, and must remain inside the corpus.

Use exactly the documented object keys. IDs must match `[a-z][a-z0-9_-]{2,63}` and be unique across all three disposition lists; finding primary path/line pairs must also be unique. Titles are 12–180 characters. Evidence claims and explanatory fields must be substantive (at least 20 characters for claims, at least 24 for behavior fields, and at least 30 for recommendations and rejection reasons). Candidate sites must be distinct retry-related locations: the named line or its two-line context must contain a retry, attempt, backoff, poll, waiter, reschedule, sleep, or pending-work signal. Each candidate site must lie at its record's primary location or within one of that record's evidence spans; unresolved sites use their exact recorded location.

The narrative `work/report.md` must be useful to a maintainer who has not seen your exploration and contain at least 1,200 characters. Include every finding, rejection, and unresolved ID, rollout order, search coverage, rejected lookalikes, unresolved or dependency boundaries, and test recommendations. Mention at least six reviewed source paths so the report remains traceable. `coverage.searchNotes` must contain at least 80 characters explaining discovery and follow-up. The JSON is the source of truth; keep the report consistent with it.

You may use Python's standard library and ordinary text-search tools. Base source evidence on this snapshot; do not fetch upstream source, issue discussions, or fixes. No dependency installation is needed. Do not inspect files outside this workspace for answers or change anything under `corpus/`.
