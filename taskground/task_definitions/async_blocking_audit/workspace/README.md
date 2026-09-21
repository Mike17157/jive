# Home Assistant async blocking audit fixture

This workspace contains a small, source-faithful slice of Home Assistant Core
2024.9.0 plus the dependency code needed to inspect important constructor paths.
It is intended for static exploration. The source is not an installable Home
Assistant checkout, and no network or package installation is needed.

The primary scope is defined in `TASK.md` in a prepared task workspace.
The `source/tests` files show intended entry points and behavior. The
`source/homeassistant/helpers/update_coordinator.py` file supplies coordinator
lifecycle context. `source/dependencies` contains preserved upstream source and
licenses. See `SNAPSHOT.md` for the visible provenance summary.

Write two artifacts:

- `work/findings.json`
- `work/report.md`

`findings.json` must have this shape (JSON has no comments; the placeholders
below describe required values):

```json
{
  "schemaVersion": 1,
  "snapshot": {
    "project": "home-assistant/core",
    "version": "2024.9.0",
    "commit": "36ec1b33fe0039d838586730768730c2ea4e054c"
  },
  "scope": {
    "candidateCount": 30,
    "filesReviewed": ["source/homeassistant/components/example/file.py"],
    "searches": [
      {
        "query": "the search or inspection performed",
        "reason": "what kind of candidate it was meant to find",
        "filesMatched": 2
      }
    ]
  },
  "findings": [
    {
      "id": "stable-short-id",
      "classification": "confirmed_blocking",
      "location": {
        "path": "source/homeassistant/components/example/file.py",
        "line": 42
      },
      "symbol": "ClassName.async_method",
      "expression": "client.operation()",
      "callerPath": [
        {
          "path": "source/homeassistant/components/example/file.py",
          "line": 35,
          "symbol": "ClassName.async_method"
        }
      ],
      "evidence": [
        {
          "path": "source/homeassistant/components/example/file.py",
          "startLine": 35,
          "endLine": 43,
          "note": "Why these lines support the classification."
        }
      ],
      "reason": "A concise conclusion that follows from the cited source."
    }
  ],
  "limitations": ["A concrete limitation of this static audit."]
}
```

Use one of these semantic classifications for every finding:

- `confirmed_blocking`: synchronous file, network, subprocess, sleep, or
  similarly blocking work is invoked on an async event-loop path. Conditional
  cold paths still belong here when the condition and impact are stated.
- `executor_protected`: the potentially blocking callable is passed through an
  executor boundary and is therefore a rejected event-loop-blocking candidate.
- `native_async`: the supplied implementation or API contract establishes a
  nonblocking coroutine or event-loop operation. `await` alone is not proof,
  because a coroutine may directly call blocking work before it yields.
- `safe_sync`: the direct synchronous call is bounded in-memory work in the
  supplied path and is a rejected candidate.
- `unresolved`: supplied source does not establish whether a material direct
  call can block. Say exactly which implementation or runtime fact is missing.

Use workspace-relative regular-file paths only. Every cited line number must
exist, every evidence span must be at most 12 lines, and each finding needs a
local evidence span covering or immediately surrounding its location. Caller
path steps need source locations and symbols; keep them ordered from the
entry/caller toward the audited operation. Findings at the same path and line
are duplicates even if their IDs differ.

Use the first source line of the audited call expression for `location.line`
(for a multiline call, this is the line containing the callable). IDs must be
unique lower-case kebab-case strings. Record at least 10 distinct reviewed
files, including all three integration scopes and dependency evidence, and at
least three concrete searches. In addition to all substantiated blockers, the
audit needs at least four `executor_protected`, two `native_async`, two
`safe_sync`, and one `unresolved` findings. Each rejected category must cover at
least two integration scopes. Reasons need at least 40 characters and evidence
notes at least 20 so conclusions are reviewable rather than labels alone.

`report.md` must be between 900 and 30,000 characters. Discuss every confirmed
blocker, at least four rejected candidates, and one unresolved boundary by the
same finding IDs used in JSON.

The audit is source based. If you did not execute Home Assistant under an event
loop detector, say so in the report and limitations rather than implying
runtime validation.
