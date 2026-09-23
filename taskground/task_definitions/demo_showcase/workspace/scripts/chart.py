"""Draw ASCII bar charts of tickets per domain and urgency; save to reports/triage-chart.txt."""
import json
import os

s = json.load(open("work/summary.json"))


def bars(title, counts):
    width = max(len(k) for k in counts)
    out = [title]
    out += [f"  {k:<{width}}  {'█' * (4 * v)} {v}" for k, v in counts.items()]
    return out


lines = bars("tickets by domain", s["by_domain"]) + [""] + bars("tickets by urgency", s["by_urgency"])
os.makedirs("reports", exist_ok=True)
open("reports/triage-chart.txt", "w").write("\n".join(lines) + "\n")
print("\n".join(lines))
