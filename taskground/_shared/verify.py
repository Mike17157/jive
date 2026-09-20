#!/usr/bin/env python3
"""Runner-owned, deterministic artifact verification. Never calls a model."""
import json
import os
from pathlib import Path
import sys

from score import ATTRS, classification, conversation_scores, index_rows, read_jsonl


def movie(workspace, reference):
    work = workspace / "work"
    predictions = read_jsonl(work / "predictions.jsonl")
    metrics = classification(predictions, reference["labels"], "sentiment")
    predicted, gold = index_rows(predictions), index_rows(reference["labels"])
    records = index_rows(reference["records"])
    queries = reference["queries"]
    counts = json.loads((work / "movie_counts.json").read_text())
    expected_counts = {movie: sum(predicted.get(key, {}).get("sentiment") == "positive" for key, row in records.items() if row["movie_id"] == movie) for movie in queries["movies"]}
    ground_counts = {movie: sum(gold[key]["sentiment"] == "positive" for key, row in records.items() if row["movie_id"] == movie) for movie in queries["movies"]}
    metrics["count_mae"] = sum(abs(expected_counts[movie] - ground_counts[movie]) for movie in expected_counts) / len(expected_counts)
    pairs = read_jsonl(work / "review_pairs.jsonl")
    seen, valid, correct = set(), True, 0
    for pair in pairs:
        a, b = pair.get("a"), pair.get("b")
        if not isinstance(a, str) or not isinstance(b, str) or a == b or a not in records or b not in records or records[a]["movie_id"] != queries["pair_movie"] or records[b]["movie_id"] != queries["pair_movie"]:
            valid = False
            continue
        key = tuple(sorted((a, b)))
        if key in seen:
            valid = False
        seen.add(key)
        correct += gold[a]["sentiment"] == gold[b]["sentiment"]
    metrics["pair_precision"] = correct / len(pairs) if pairs else 0
    ranking = json.loads((work / "movie_ranking.json").read_text())
    expected_ranking = sorted(expected_counts, key=lambda movie: (-expected_counts[movie], movie))
    ranking_valid = isinstance(ranking, list) and len(ranking) == len(expected_ranking) and all(isinstance(row, dict) for row in ranking)
    if ranking_valid:
        ranking_valid = [row.get("movie_id") for row in ranking] == expected_ranking
        ranking_valid = ranking_valid and all(type(row.get("positive_fraction")) in (int, float) and abs(row["positive_fraction"] - expected_counts[row["movie_id"]] / 30) <= 1e-6 for row in ranking)
    return metrics, {"complete_predictions": metrics["coverage"] == 1, "sentiment_accuracy": metrics["accuracy"] >= .80,
                     "counts_consistent": isinstance(counts, dict) and counts == expected_counts and all(type(v) is int for v in counts.values()),
                     "ten_distinct_valid_pairs": valid and len(pairs) == queries["pair_count"], "pair_precision": metrics["pair_precision"] >= .90,
                     "ranking_consistent": ranking_valid}


def conversation(workspace, reference):
    work = workspace / "work"
    predictions = read_jsonl(work / "predictions.jsonl")
    pairs = read_jsonl(work / "pair_predictions.jsonl")
    metrics = conversation_scores(predictions, pairs, reference["test_labels"], reference["test_pairs"])
    h, p = metrics["attributes"]["helpfulness"], metrics["pairs"]
    checks = {"all_attributes_complete": all(metrics["attributes"][attr]["coverage"] == 1 for attr in ATTRS),
              "pairs_complete": p["coverage"] == 1, "helpfulness_qwk": h["qwk"] >= .45,
              "helpfulness_within1": h["within1"] >= .80, "pair_decisive_accuracy": p["decisive_accuracy"] >= .65}
    dev_metrics = {}
    for round_id in ("r1", "r2", "r3"):
        files = [work / f"dev_predictions-{round_id}.jsonl", work / f"dev_pair_predictions-{round_id}.jsonl", work / f"rubric-{round_id}.md", work / f"score-dev-{round_id}.json", work / f"evidence-{round_id}.jsonl"]
        exists = all(path.is_file() and path.stat().st_size > 0 for path in files)
        checks[f"artifacts_{round_id}"] = exists
        if exists:
            score = conversation_scores(read_jsonl(files[0]), read_jsonl(files[1]), reference["dev_labels"], reference["dev_pairs"])
            dev_metrics[round_id] = score
            checks[f"complete_{round_id}"] = all(score["attributes"][attr]["coverage"] == 1 for attr in ATTRS) and score["pairs"]["coverage"] == 1
    metrics["dev_rounds"] = dev_metrics
    checks["report"] = (work / "report.md").is_file() and (work / "report.md").stat().st_size > 0
    # These are artifact/quality checks, not proof of method, replayability or absence of test leakage.
    return metrics, checks


def main():
    workspace = Path(os.environ["TASKGROUND_WORKSPACE"])
    definition = Path(os.environ["TASKGROUND_DEFINITION"])
    output = Path(os.environ["TASKGROUND_RESULT"])
    reference = json.loads((definition / "verifier/reference.json").read_text())
    task = reference["task"]
    try:
        if task == "sembench_movie":
            metrics, checks = movie(workspace, reference)
        elif task == "conversation_eval":
            metrics, checks = conversation(workspace, reference)
        else:
            field = "match" if task == "product_matching" else "intent"
            predictions = read_jsonl(workspace / "work/predictions.jsonl")
            metrics = classification(predictions, reference["labels"], field)
            checks = {"complete_predictions": metrics["coverage"] == 1, "accuracy": metrics["accuracy"] >= .80, "macro_f1": metrics["macro_f1"] >= .80}
        report = {"schemaVersion": 1, "task": task, "status": "passed" if all(checks.values()) else "failed", "checks": checks, "metrics": metrics,
                  "limitations": ["Artifact and quality checks only; method, resource-instruction compliance, and held-out-label access require trace review."]}
    except (OSError, ValueError, KeyError, TypeError) as error:
        report = {"schemaVersion": 1, "task": task, "status": "failed", "checks": {"valid_artifacts": False}, "error": str(error)}
    output.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
    print(json.dumps(report, allow_nan=False))
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    sys.exit(main())
