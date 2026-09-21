# Prefect error-handling audit

This is a read-only audit of a bounded, pinned source fixture. The target is not every error-handling issue in Prefect. Review every Python file under the **Primary audit scope** below, then use the included tests and dependency sources to establish behavior and propagation. The snapshot is intentionally large enough that broad exception syntax is only a starting point.

## Primary audit scope

These 12 files form the complete scored inventory:

```text
prefect/src/prefect/server/utilities/user_templates.py
prefect/src/prefect/server/events/actions.py
prefect/src/prefect/server/events/models/automations.py
prefect/src/prefect/server/orchestration/core_policy.py
prefect/src/prefect/server/orchestration/rules.py
prefect/src/prefect/utilities/schema_tools/hydration.py
prefect/src/prefect/task_runners.py
prefect/src/prefect/futures.py
prefect/src/prefect/events/utilities.py
prefect/src/prefect/_internal/analytics/client.py
prefect/src/prefect/utilities/filesystem.py
prefect/src/integrations/prefect-docker/prefect_docker/worker.py
```

`python3 scripts/inventory.py` prints the broad `Exception`, `BaseException`, and bare handlers in that scope. Audit every reported handler. Also inspect boundary APIs in the scope whose implementation may suppress errors outside the immediate call, especially callback and dependency APIs. The inventory count is a coverage aid, not a bug count.

Relevant upstream tests are retained under `prefect/tests/` and `prefect/src/integrations/prefect-docker/tests/`. Exact dependency sources are under `third_party/`. See `SNAPSHOT.md` for versions and provenance. No package installation or test execution is required; this fixture is meant for source, call-path, and test-contract analysis offline.

## Decision policy

Report a finding only when the supplied evidence establishes all of these:

1. A specific exception or error signal is suppressed, converted, discarded, or prevented from reaching the consumer that owns the outcome.
2. A caller, wrapper, lifecycle hook, or test contract treats the boundary as successful or complete, or loses required state/progress.
3. The consequence is concrete: false success, invalid-value propagation, stale-resource use, stalled completion, or leaked capacity.

Logging alone does not make suppression safe. Conversely, a broad handler is not automatically defective. Best-effort telemetry, cleanup that has an explicit recovery owner, validation translated into a documented result, and conservative OS fallbacks can be correct. `examples/EXPECTED_BEHAVIOR.py` contains local, non-Prefect examples of two acceptable patterns. Those examples are explanatory and are outside the audit inventory.

Group multiple sites into one finding only when they implement the same failure boundary and consequence. Keep separate boundaries separate even if one later upstream change could repair both. If evidence is incomplete, put the boundary under `unresolvedBoundaries` instead of presenting it as confirmed.

## `work/findings.json`

The verifier is deterministic and expects this public schema. Extra object keys are allowed, but required keys and types are strict.

```json
{
  "schemaVersion": 1,
  "task": "error_handling_audit",
  "scope": {
    "reviewedFiles": ["prefect/src/..."],
    "broadHandlersReviewed": 0,
    "boundaryApisReviewed": 0
  },
  "findings": [
    {
      "id": "stable-unique-id",
      "title": "Concrete failure and consequence",
      "severity": "high",
      "confidence": "high",
      "boundary": {
        "path": "prefect/src/...",
        "symbol": "Class.method",
        "startLine": 1,
        "endLine": 1
      },
      "mechanism": "exception-returned-as-data",
      "failureMode": "false-success",
      "trigger": "The exact failing operation and exception or error signal.",
      "observedBehavior": "What the boundary and its callers do instead.",
      "impact": "The concrete user or system consequence.",
      "recommendation": "The propagation or translation contract that should replace it.",
      "callPath": [
        {
          "path": "prefect/src/...",
          "symbol": "Class.method",
          "line": 1,
          "role": "boundary"
        }
      ],
      "evidence": [
        {
          "path": "prefect/tests/...",
          "line": 1,
          "description": "What this exact line establishes."
        }
      ]
    }
  ],
  "rejectedLookalikes": [
    {
      "path": "prefect/src/...",
      "symbol": "function_or_Class.method",
      "line": 1,
      "reason": "Why suppression is safe or contractually expected here."
    }
  ],
  "unresolvedBoundaries": [
    {
      "path": "prefect/src/... or third_party/...",
      "symbol": "function_or_Class.method",
      "line": 1,
      "reason": "The missing fact that prevents a confident classification.",
      "recommendedNextStep": "A bounded check that would resolve it."
    }
  ]
}
```

Allowed `severity` values are `critical`, `high`, `medium`, and `low`. Allowed `confidence` values are `high`, `medium`, and `low`.

Allowed `mechanism` values are:

- `exception-returned-as-data`
- `dependency-stream-discard`
- `callback-notification-lost`
- `cleanup-failure-suppressed`
- `other`

Allowed `failureMode` values are:

- `false-success`
- `invalid-value-propagation`
- `stale-resource-use`
- `stalled-completion`
- `leaked-capacity`
- `other`

Allowed call-path roles are `boundary`, `caller`, `observer`, and `contract`. Cite two to six call-path steps and two to six evidence lines per finding. Every path must name a retained file, every line must be a nonblank real line, and a boundary span may cover at most 12 lines. IDs and boundary locations must be unique. Keep the findings list focused; uncertain candidates belong in `unresolvedBoundaries`.

Submit at most eight findings. Titles must contain at least 12 characters. Each trigger, observed behavior, impact, recommendation, rejected reason, unresolved reason, and next step must contain at least 24 characters; evidence descriptions must contain at least 16. These are malformed-artifact guards, not prose-quality scoring.

Include every primary-scope path in `scope.reviewedFiles`. `broadHandlersReviewed` is the inventory count you actually reviewed and must cover all 35 handlers. `boundaryApisReviewed` counts callback or dependency APIs examined beyond syntactic exception handlers and must be at least two.

Reject at least three plausible lookalikes from the primary scope, with precise locations and reasons. They may be any representative handlers you actually assessed; do not reject a boundary also reported as a finding. Include at least one unresolved boundary or dependency assumption.

## `work/report.md`

Use these headings and explain the judgments in prose:

```text
# Error Handling Audit
## Scope and search coverage
## Confirmed findings
## Rejected lookalikes
## Unresolved and dependency boundaries
```

The JSON carries machine-checkable facts. The report must be UTF-8 and at least 500 bytes, and should explain why callers observe the stated outcome, what you ruled out, and where static evidence stops. The verifier checks structure, bounded citations, inventory coverage, fixture integrity, and confirmed reference coverage. It rejects findings that contradict a small held-out set of known-safe boundaries; additional unrecognized findings are surfaced as `needsReview`, not automatically marked true or false. It cannot fully judge prose quality or prove how the investigation was performed; those require trace review.
