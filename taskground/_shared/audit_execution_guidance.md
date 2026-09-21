## Execution guidance

Keep searches broad, then organize plausible candidates by source location and
the behavior that needs checking. Retrieve the enclosing function and relevant
caller or dependency context. Save evidence under `work/` and reuse it instead
of repeatedly returning overlapping whole files to your main reasoning context.
Read more source whenever a conclusion needs it.

Use available helper tools for repeated, bounded semantic judgments when the
possible next actions are already clear. Supply the actual source excerpts,
audit policy, and known call relationships. Keep observed facts separate from
hypotheses. Useful alternatives include rejecting a supported lookalike,
inspecting a caller, inspecting a dependency implementation, marking evidence
sufficient, or escalating an unresolved case for deeper investigation. A short
summary of several suspected bugs is not a substitute for their evidence.

Connect each judgment to its next action. Where your tools support it, execute
the selected follow-up and reassess the new evidence without an extra planning
round. Process independent candidates concurrently. Return compact decisions,
evidence locations, and unresolved questions to your main reasoning context.
Keep new hypotheses, unfamiliar investigations, and final synthesis in your
main reasoning. There is no minimum helper-call count: use a helper only when
its answer can affect the investigation, and keep uncertainty explicit.

Use ordinary code for deterministic searching, extraction, counting, and schema
validation. Maintain a concise candidate ledger under `work/` recording each
decision, its supporting evidence, and the next check or reason for stopping.
Do not infer complete coverage from a large search output or candidate count.

Before writing final artifacts, reopen `README.md` and check its exact output
contract. Validate required fields, classifications, citation bounds, duplicate
rules, and coverage against that contract. After any context reduction, retrieve
the saved evidence and contract you need. A validator based on a different
self-invented schema does not establish task completion.
