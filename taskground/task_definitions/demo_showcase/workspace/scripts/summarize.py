"""Aggregate triage results into work/summary.json."""
import collections
import glob
import json

labels = {r["id"]: r for r in map(json.loads, open("data/labels.jsonl"))}
rows = sorted((json.load(open(p)) for p in glob.glob("work/triage/*.json")), key=lambda r: r["id"])
summary = {
    "tickets": len(rows),
    "intent_accuracy": round(sum(r["intent"] == labels[r["id"]]["intent"] for r in rows) / len(labels), 3),
    "by_domain": dict(collections.Counter(r["domain"] for r in rows)),
    "by_urgency": {u: sum(r["urgency"] == u for r in rows) for u in ("urgent", "today", "routine")},
    "urgent_tickets": [r["id"] for r in rows if r["urgency"] == "urgent"],
    "misses": [{"id": r["id"], "predicted": r["intent"], "expected": labels[r["id"]]["intent"]} for r in rows if r["intent"] != labels[r["id"]]["intent"]],
    "rows": rows,
}
json.dump(summary, open("work/summary.json", "w"), indent=2)
print(json.dumps({k: v for k, v in summary.items() if k != "rows"}, indent=2))
