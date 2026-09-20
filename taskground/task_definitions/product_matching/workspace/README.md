# Product offer matching

A deterministic development subset of [WDC Products](https://webdatacommons.org/largescaleproductcorpus/wdc-products/): 120 test pairs and 20 labeled dev pairs. Each set contains equal numbers of matches and nonmatches. The test selection comes from the 80%-corner-case, 100%-unseen-products variant; dev examples retain the original training boundary.

`data/test.jsonl` records contain `id`, `left`, and `right`. Each offer has descriptive attributes such as brand, title, description, price, and currency. `data/dev.jsonl` also contains a boolean `match` label. All data is local.

Decide whether the two offers describe the same exact product. Similar products, accessories, or conflicting sizes/capacities/model variants need not be matches. Differences in seller wording and price alone do not establish different products.

## Deliverables and scoring

- `work/predictions.jsonl`: exactly one `{"id":"test-000","match":true}` record per test input. Use JSON booleans.
- A rerunnable script/workflow, per-item evidence, and `work/report.md` containing your approach, limitations, and reproduction command.
- Optional: `work/dev_predictions.jsonl`, scored with `python3 scripts/score.py`.

The runner checks full test coverage and reports accuracy and macro-F1. Both provisional quality targets are 0.80. These are development-subset metrics, not an official WDC benchmark score. Preserve the supplied data and scripts. Use only the provided descriptions; do not retrieve source records, reference labels, or files outside the workspace. Final grading is performed by the runner after execution.

Attribution: Ralph Peeters, Reng Chiz Der, and Christian Bizer, WDC Products (EDBT 2024), Web Data Commons.
