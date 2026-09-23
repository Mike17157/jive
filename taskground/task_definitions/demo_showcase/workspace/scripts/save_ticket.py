"""Persist one routed ticket from the triage graph (JSON on stdin)."""
import json
import os
import sys

URGENCY = ["routine", "today", "urgent"]

row = json.load(sys.stdin)
probabilities = row["urgency"]["probabilities"]
level = int(max(probabilities, key=probabilities.get))
record = {
    "id": row["id"],
    "text": row["text"],
    "domain": row["domain"]["choice"],
    "domain_confidence": row["domain"]["confidence"],
    "intent": row["intent"]["choice"],
    "intent_confidence": row["intent"]["confidence"],
    "urgency": URGENCY[level],
}
os.makedirs("work/triage", exist_ok=True)
json.dump(record, open(f"work/triage/{record['id']}.json", "w"), indent=2)
print(f"{record['id']}  {record['domain']}/{record['intent']}  ({record['urgency']})")
