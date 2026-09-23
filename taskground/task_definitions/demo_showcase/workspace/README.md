# Support inbox triage

`support_bot/` is a small keyword-routed support bot for a bank. `support_bot/intents.json`
defines 24 intents across three domains (cards, transfers, account). `data/inbox.jsonl`
holds 12 customer tickets; `data/labels.jsonl` has their expected domain and intent.

`graphs/` contains ready-made Jive graphs, and `scripts/` contains the helpers they call.
The run order is in `AGENTS.md`.

Requests are adapted from BANKING77 (Casanueva et al., 2020, PolyAI, CC-BY-4.0).
