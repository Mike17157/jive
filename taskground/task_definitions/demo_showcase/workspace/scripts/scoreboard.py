"""Compare saved triage decisions with the inbox labels and print a scoreboard."""
import glob
import json
import sys

sys.path.insert(0, ".")
from support_bot.router import route  # noqa: E402

labels = {r["id"]: r for r in map(json.loads, open("data/labels.jsonl"))}
texts = {r["id"]: r["text"] for r in map(json.loads, open("data/inbox.jsonl"))}
rows = sorted((json.load(open(p)) for p in glob.glob("work/triage/*.json")), key=lambda r: r["id"])

print(f"{'ticket':<8}{'domain':<11}{'intent':<32}{'urgency':<9}ok")
for r in rows:
    gold = labels[r["id"]]["intent"]
    mark = "✓" if r["intent"] == gold else f"✗ {gold}"
    print(f"{r['id']:<8}{r['domain']:<11}{r['intent']:<32}{r['urgency']:<9}{mark}")

domain_acc = sum(r["domain"] == labels[r["id"]]["domain"] for r in rows) / len(labels)
intent_acc = sum(r["intent"] == labels[r["id"]]["intent"] for r in rows) / len(labels)
router_acc = sum(route(texts[i])[1] == g["intent"] for i, g in labels.items()) / len(labels)
print()
print(f"triaged {len(rows)}/{len(labels)} tickets")
print(f"domain accuracy  {domain_acc:.0%}")
print(f"intent accuracy  {intent_acc:.0%}   (keyword router: {router_acc:.0%})")
