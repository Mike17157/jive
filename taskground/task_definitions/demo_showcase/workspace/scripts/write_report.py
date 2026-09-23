"""Render reports/triage-report.md from work/summary.json."""
import json
import os

s = json.load(open("work/summary.json"))
coverage = json.load(open("work/coverage.json")) if os.path.exists("work/coverage.json") else None
lines = [
    "# Support inbox triage report",
    "",
    f"- Tickets triaged: **{s['tickets']}**",
    f"- Intent accuracy: **{s['intent_accuracy']:.0%}**",
    f"- Urgent tickets: {', '.join(s['urgent_tickets']) or 'none'}",
]
if coverage:
    gaps = sum(len(v) for v in coverage["missing"].values())
    lines.append(f"- Keyword router gaps: {gaps} intents have no rule")
lines += ["", "| Ticket | Domain | Intent | Urgency |", "| --- | --- | --- | --- |"]
lines += [f"| {r['id']} | {r['domain']} | {r['intent']} | {r['urgency']} |" for r in s["rows"]]
if s["misses"]:
    lines += ["", "## Misses", ""] + [f"- {m['id']}: predicted `{m['predicted']}`, expected `{m['expected']}`" for m in s["misses"]]
os.makedirs("reports", exist_ok=True)
open("reports/triage-report.md", "w").write("\n".join(lines) + "\n")
print(f"wrote reports/triage-report.md ({len(lines)} lines)")
