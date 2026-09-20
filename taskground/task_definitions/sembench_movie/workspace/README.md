# Movie review analytics

This is a small, fixed adaptation of [SemBench's movie scenario](https://github.com/SemBench/SemBench), not the full benchmark. All inputs are included; network access is not needed to download data.

- `data/test.jsonl`: 120 reviews, 30 for each of four movies. Each record has `id`, `movie_id`, and `text`.
- `data/dev.jsonl`: 12 separate labeled examples for reference. `sentiment` is `positive` or `negative`.
- `data/queries.json`: the four movie IDs, the movie for the review-pair query, and the required pair count.

The three analytical queries reuse the same review judgments. Count and join semantics are adapted from SemBench; ranking uses positive-review fraction instead of five-point ratings.

## Deliverables

Write these files under `work/`:

1. `predictions.jsonl`: one `{"id":"…","sentiment":"positive"}` or `negative` prediction per test review.
2. `movie_counts.json`: an object mapping all four movie IDs to integer positive-review counts.
3. `review_pairs.jsonl`: ten `{"a":"review-id","b":"other-review-id"}` records for the movie in `queries.json`. Each pair must have the same sentiment, contain two distinct reviews, and be unique irrespective of pair order.
4. `movie_ranking.json`: an array of `{"movie_id":"…","positive_fraction":0.5}` objects, descending by positive fraction, with movie ID ascending as the tie-breaker. Fractions may be rounded to six decimal places.
5. A rerunnable script/workflow and `report.md` describing your approach and reproduction command.

Optional development scoring: write `work/dev_predictions.jsonl` and run `python3 scripts/score.py`. The helper reads visible dev labels only.

## Success criteria

All test reviews must be covered. The provisional quality targets are at least 80% sentiment accuracy and 90% correct review pairs. Counts and ranking must be consistent with your submitted predictions. The runner grades final artifacts against held-out reference labels after execution; report results honestly rather than tuning on those labels.

Use only the provided inputs. Keep `data/`, `scripts/`, and this task definition unchanged. Do not inspect sibling run metadata, verifier files, source datasets, or other runs. Preserve intermediate evidence and document any uncertainty. Method and reproducibility are reviewed separately from automatic artifact checks.
