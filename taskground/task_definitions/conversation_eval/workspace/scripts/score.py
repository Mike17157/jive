#!/usr/bin/env python3
"""Public dev scoring utilities. No held-out labels or model calls.

Run from any cwd: python3 scripts/score.py [--predictions PATH] [--pairs PATH].
This helper scores visible dev data only. The task runner grades final test files.
"""
import argparse
from collections import Counter
import json
from pathlib import Path

ATTRS = ("helpfulness", "correctness", "coherence", "complexity", "verbosity")


def read_jsonl(path):
    rows = [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]
    if any(not isinstance(row, dict) for row in rows):
        raise ValueError("Each JSONL line must be an object")
    return rows


def index_rows(rows):
    result = {}
    for row in rows:
        key = row.get("id", row.get("pair_id"))
        if not isinstance(key, str) or key in result:
            raise ValueError("Each record must have a unique string id (or pair_id)")
        result[key] = row
    return result


def classification(predictions, labels, field):
    expected, predicted = index_rows(labels), index_rows(predictions)
    unknown = set(predicted) - set(expected)
    if unknown:
        raise ValueError(f"Unknown prediction IDs: {sorted(unknown)[:5]}")
    def equal(a, b):
        return type(a) is type(b) and a == b
    correct = sum(equal(predicted.get(key, {}).get(field), row[field]) for key, row in expected.items())
    classes = sorted({row[field] for row in labels}, key=str)
    f1s = []
    for category in classes:
        tp = sum(equal(row[field], category) and equal(predicted.get(key, {}).get(field), category) for key, row in expected.items())
        fp = sum(not equal(row[field], category) and equal(predicted.get(key, {}).get(field), category) for key, row in expected.items())
        fn = sum(equal(row[field], category) and not equal(predicted.get(key, {}).get(field), category) for key, row in expected.items())
        f1s.append(2 * tp / (2 * tp + fp + fn) if 2 * tp + fp + fn else 0)
    return {"n": len(expected), "predicted": len(predicted), "coverage": len(predicted) / len(expected), "accuracy": correct / len(expected), "macro_f1": sum(f1s) / len(f1s)}


def quadratic_kappa(predicted, gold):
    n = len(gold)
    if not n:
        return 0
    observed = sum((a - b) ** 2 for a, b in zip(predicted, gold)) / n
    p, g = Counter(predicted), Counter(gold)
    expected = sum((a - b) ** 2 * pa * gb for a, pa in p.items() for b, gb in g.items()) / (n * n)
    return 1 - observed / expected if expected else (1.0 if observed == 0 else 0.0)


def conversation_scores(predictions, pairs, labels, pair_labels):
    expected, predicted = index_rows(labels), index_rows(predictions)
    if set(predicted) - set(expected):
        raise ValueError("Unknown conversation prediction IDs")
    for row in predictions:
        if any(type(row.get(attr)) is not int or not 0 <= row[attr] <= 4 for attr in ATTRS):
            raise ValueError("Each response needs all five integer ratings in 0–4")
    attributes = {}
    for attr in ATTRS:
        ids = [key for key in expected if key in predicted]
        ps, gs = [predicted[key][attr] for key in ids], [expected[key][attr] for key in ids]
        attributes[attr] = {"coverage": len(ids) / len(expected), "exact": sum(a == b for a, b in zip(ps, gs)) / len(expected),
                            "within1": sum(abs(a - b) <= 1 for a, b in zip(ps, gs)) / len(expected), "qwk": quadratic_kappa(ps, gs)}
    pair_result = classification(pairs, pair_labels, "preferred")
    pair_predictions = index_rows(pairs)
    decisive = [row for row in pair_labels if row["preferred"] != "tie"]
    # Abstentions and missing answers count as wrong, not as a way to shrink the denominator.
    pair_result["decisive_accuracy"] = sum(pair_predictions.get(row["pair_id"], {}).get("preferred") == row["preferred"] for row in decisive) / len(decisive) if decisive else 0
    return {"attributes": attributes, "pairs": pair_result}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--split", choices=["dev"], default="dev")
    ap.add_argument("--predictions")
    ap.add_argument("--pairs")
    ap.add_argument("--out")
    args = ap.parse_args()
    workspace = Path(__file__).resolve().parents[1]
    labels = read_jsonl(workspace / "data/dev.jsonl")
    predictions = read_jsonl(args.predictions or workspace / "work/dev_predictions.jsonl")
    if "labels" in labels[0]:
        expected = [{"id": row["id"], **row["labels"]} for row in labels]
        pair_labels = read_jsonl(workspace / "data/dev_pairs.jsonl")
        pairs = read_jsonl(args.pairs or workspace / "work/dev_pair_predictions.jsonl")
        result = conversation_scores(predictions, pairs, expected, pair_labels)
    else:
        field = next(field for field in ("sentiment", "match", "intent") if field in labels[0])
        result = classification(predictions, labels, field)
    output = Path(args.out or workspace / "work/score-dev.json")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
