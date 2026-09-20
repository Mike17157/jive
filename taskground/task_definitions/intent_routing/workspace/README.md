# Banking request routing

This is a small adaptation of [BANKING77](https://github.com/PolyAI-LDN/task-specific-datasets), retaining all 77 categories. `data/test.jsonl` has 154 requests, two from each category, with `id` and `text`. `data/intents.json` lists the exact permitted intent strings. `data/dev.jsonl` provides one labeled training example per category; these examples are for reference, and a full development inference pass is not required.

Assign exactly one intent to each request. Preserve capitalization and punctuation in the intent strings. Some categories differ subtly, such as an expected delivery date versus a card that has not arrived. This task has no out-of-scope category.

## Deliverables and scoring

- `work/predictions.jsonl`: one `{"id":"test-000","intent":"card_arrival"}` record per input.
- A rerunnable script/workflow, per-item evidence, and `work/report.md` with your approach and reproduction command.
- Optional development scoring: put any development predictions in `work/dev_predictions.jsonl` and run `python3 scripts/score.py`. Missing predictions lower coverage.

The runner requires full test coverage and reports accuracy and macro-F1, each with a provisional target of 0.80. These are metrics for this fixed subset, not the full BANKING77 test set. Do not alter task inputs or scripts, download source labels, or inspect other directories/runs. Held-out scoring happens after the run.

Attribution: Iñigo Casanueva et al., *Efficient Intent Detection with Dual Sentence Encoders* (2020), PolyAI. Dataset license: CC-BY-4.0. The subset preserves the original train/test split.
