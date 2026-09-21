# Maintainer design notes

This fixture freezes a coherent Prefect snapshot at `d1d0f4d663f4b421fccaa78fda0cd1fd70da7f0f` (2026-03-09). It does not splice later fixes into the agent-visible code and does not claim that defects from older Prefect revisions coexist here. The 12-file inventory contains 35 broad handlers. Selected callers, tests, docker-py 7.1.0 source, and CPython 3.12.10 callback source make the five required classifications independently auditable offline.

The reference positives are corroborated by later upstream changes, but those commits and answers are held out:

- Prefect `fd3121de93432dc5561773a067d0148c66051dcb` / #21045 changed both template renderers to raise a typed error, converted the async action error to `ActionFailed`, and converted the sync hydration error to `InvalidJinja`.
- Prefect `4b67d3fe05baeb421deccd78eee82b13bbe616f2` / #21310 replaced docker-py's high-level pull with a decoded low-level stream check because high-level pull can return a stale cached image after discarding a daemon error record.
- Prefect `34586366f0eed9112df75a4e683a4ef91fda8db6` / #21612 stored `_UnpicklingFuture` deserialization errors and invoked the callback with the wrapper future; its regression test describes the pre-fix zombie-flow hang.
- Prefect `675e9bd16b8771210e15bb11f95ffa85d08704e1` / #21797 re-raised failures from V2 task lease cleanup and added failure-injection tests requiring propagation. The scored site is task cleanup, not the more ambiguous flow cleanup.

The async and sync template sites are separate findings because they have separate public functions, callers, error translations, and consequences. The async path makes the automation lifecycle take its success branch. The sync path bypasses the `InvalidJinja` placeholder contract and propagates an ordinary string.

The verifier does not grade free-form explanations by keywords. It requires structured mechanism and failure-mode judgments, exact boundary identity, a small set of required caller/contract facts, and bounded citations to real retained lines. Known safe boundaries catch a specific false-positive class. Other additional findings are reported as `needsReview`, since a deterministic verifier cannot decide arbitrary new semantic claims. Five known positives must all be present. More than eight findings is rejected as an unfocused blanket submission.

Source integrity includes absence of extra files outside `work/`; runner-managed README, task, environment, Git, and ignore files are excluded. The verifier intentionally permits arbitrary agent artifacts under `work/` but cites only retained `prefect/` or `third_party/` files.
