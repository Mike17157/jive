"""List taxonomy intents that the keyword router never produces."""
import json
import os
import re

taxonomy = json.load(open("support_bot/intents.json"))
source = open("support_bot/router.py").read()
routed = set(re.findall(r'\(\s*"[^"]+",\s*"[a-z]+",\s*"([a-z_]+)"\s*\)', source))
missing = {domain: sorted(i for i in intents if i not in routed) for domain, intents in taxonomy.items()}
total = sum(len(v) for v in taxonomy.values())
gaps = sum(len(v) for v in missing.values())
os.makedirs("work", exist_ok=True)
json.dump({"routed": sorted(routed), "missing": missing}, open("work/coverage.json", "w"), indent=2)
print(f"{gaps} of {total} intents have no keyword rule")
for domain, intents in missing.items():
    print(f"  {domain:<10} {', '.join(intents) or '-'}")
