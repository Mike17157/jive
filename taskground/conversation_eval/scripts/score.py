#!/usr/bin/env python3
"""Score predictions against the HelpSteer2 labels.

    scripts/score.py                       # test split: work/predictions.jsonl + work/pair_predictions.jsonl
    scripts/score.py --split dev           # calibrate against the visible dev labels
    scripts/score.py --predictions work/try3.jsonl --pairs work/try3_pairs.jsonl

Prediction formats (JSON lines; any subset of attributes, any subset of items):
    {"id": "test-p012-a", "helpfulness": 3, "correctness": 4, "coherence": 4, "complexity": 1, "verbosity": 2}
    {"pair_id": "test-p012", "preferred": "a"}        # "a" | "b" | "tie"   ("choice" is accepted as an alias)

Prints one summary table; writes the full breakdown to work/score-<split>.json.
Exit code 0 when every gate passes on --split test (gates are informational on dev), 1 otherwise.
"""
import argparse
import json
import math
import os
import sys
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ATTRS = ["helpfulness", "correctness", "coherence", "complexity", "verbosity"]
SCALE = 5

# Definition of done on the test split. Provisional calibration targets: beat them and you
# are clearly above a constant-answer judge; the majority baselines are printed alongside.
GATES = {
    "coverage": 1.0,                 # every test conversation and pair has a prediction
    "helpfulness_qwk": 0.45,         # quadratic-weighted kappa vs human helpfulness
    "helpfulness_within1": 0.80,     # |pred - human| <= 1 (a constant answer gets ~0.72)
    "pairs_decisive_accuracy": 0.65, # non-tie pairs where the judge picked a side and got it right
}


def read_jsonl(path):
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def rankdata(xs):
    order = sorted(range(len(xs)), key=lambda i: xs[i])
    ranks = [0.0] * len(xs)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and xs[order[j + 1]] == xs[order[i]]:
            j += 1
        avg = (i + j) / 2 + 1
        for k in range(i, j + 1):
            ranks[order[k]] = avg
        i = j + 1
    return ranks


def spearman(a, b):
    if len(a) < 3:
        return None
    ra, rb = rankdata(a), rankdata(b)
    ma, mb = sum(ra) / len(ra), sum(rb) / len(rb)
    cov = sum((x - ma) * (y - mb) for x, y in zip(ra, rb))
    va = math.sqrt(sum((x - ma) ** 2 for x in ra))
    vb = math.sqrt(sum((y - mb) ** 2 for y in rb))
    return None if va == 0 or vb == 0 else cov / (va * vb)


def quadratic_weighted_kappa(pred, gold):
    n = len(pred)
    if n == 0:
        return None
    obs = [[0] * SCALE for _ in range(SCALE)]
    for p, g in zip(pred, gold):
        obs[p][g] += 1
    hp, hg = Counter(pred), Counter(gold)
    num = den = 0.0
    for i in range(SCALE):
        for j in range(SCALE):
            w = (i - j) ** 2 / (SCALE - 1) ** 2
            num += w * obs[i][j]
            den += w * hp[i] * hg[j] / n
    return None if den == 0 else 1 - num / den


def attribute_metrics(pred_by_id, gold_by_id, attr):
    pairs = [(int(pred_by_id[i][attr]), gold_by_id[i][attr]) for i in gold_by_id if i in pred_by_id and pred_by_id[i].get(attr) is not None]
    if not pairs:
        return {"n": 0}
    p, g = zip(*pairs)
    n = len(pairs)
    return {
        "n": n,
        "coverage": round(n / len(gold_by_id), 3),
        "exact": round(sum(x == y for x, y in pairs) / n, 3),
        "within1": round(sum(abs(x - y) <= 1 for x, y in pairs) / n, 3),
        "mae": round(sum(abs(x - y) for x, y in pairs) / n, 3),
        "spearman": _r(spearman(p, g)),
        "qwk": _r(quadratic_weighted_kappa(list(p), list(g))),
        "pred_distribution": dict(sorted(Counter(p).items())),
        "gold_distribution": dict(sorted(Counter(g).items())),
    }


def _r(x):
    return None if x is None else round(x, 3)


def pair_metrics(preds, golds):
    gold_by_id = {g["pair_id"]: g for g in golds}
    pred_by_id = {}
    for p in preds:
        choice = p.get("preferred", p.get("choice"))
        if choice in ("a", "b", "tie"):
            pred_by_id[p["pair_id"]] = choice
    scored = [(pred_by_id[i], g["preferred"]) for i, g in gold_by_id.items() if i in pred_by_id]
    decisive = [(p, g) for p, g in scored if g != "tie"]
    picked = [(p, g) for p, g in decisive if p != "tie"]
    return {
        "n": len(scored),
        "coverage": round(len(scored) / len(gold_by_id), 3) if gold_by_id else None,
        "accuracy_all": _r(sum(p == g for p, g in scored) / len(scored)) if scored else None,
        "decisive_pairs": len(decisive),
        "decisive_picked": len(picked),
        "decisive_accuracy": _r(sum(p == g for p, g in picked) / len(picked)) if picked else None,
        "abstained_on_decisive": len(decisive) - len(picked),
        "tie_recall": _r(sum(p == "tie" for p, g in scored if g == "tie") / max(1, sum(g == "tie" for _, g in scored))),
        "pred_distribution": dict(Counter(p for p, _ in scored)),
        "gold_distribution": dict(Counter(g["preferred"] for g in golds)),
    }


def baselines(gold_by_id, dev_labels, gold_pairs):
    """Constant-answer judges: the bar any real judge must clear."""
    out = {}
    for attr in ATTRS:
        majority = Counter(r[attr] for r in dev_labels).most_common(1)[0][0] if dev_labels else 4
        const = {i: {attr: majority} for i in gold_by_id}
        m = attribute_metrics(const, gold_by_id, attr)
        out[attr] = {"majority_value": majority, "exact": m["exact"], "within1": m["within1"], "qwk": m["qwk"]}
    decisive = [g for g in gold_pairs if g["preferred"] != "tie"]
    out["pairs"] = {"always_a_decisive_accuracy": _r(sum(g["preferred"] == "a" for g in decisive) / len(decisive)) if decisive else None,
                    "always_tie_accuracy_all": _r(sum(g["preferred"] == "tie" for g in gold_pairs) / len(gold_pairs)) if gold_pairs else None}
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--split", choices=["dev", "test"], default="test")
    ap.add_argument("--predictions", help="attribute predictions jsonl (default work/predictions.jsonl, or work/dev_predictions.jsonl for dev)")
    ap.add_argument("--pairs", help="pair predictions jsonl (default work/pair_predictions.jsonl, or work/dev_pair_predictions.jsonl)")
    args = ap.parse_args()

    prefix = "" if args.split == "test" else "dev_"
    pred_path = args.predictions or os.path.join(ROOT, "work", f"{prefix}predictions.jsonl")
    pair_path = args.pairs or os.path.join(ROOT, "work", f"{prefix}pair_predictions.jsonl")

    gold_labels = read_jsonl(os.path.join(ROOT, "golden", f"{args.split}_labels.jsonl"))
    gold_pairs = read_jsonl(os.path.join(ROOT, "golden", f"{args.split}_pairs.jsonl"))
    if not gold_labels:
        sys.exit("no golden labels found; run scripts/prepare.py first")
    dev_labels = read_jsonl(os.path.join(ROOT, "golden", "dev_labels.jsonl"))
    gold_by_id = {g["id"]: g for g in gold_labels}

    preds = read_jsonl(pred_path)
    pred_by_id = {p["id"]: p for p in preds if "id" in p}
    unknown = sorted(set(pred_by_id) - set(gold_by_id))
    result = {
        "split": args.split,
        "predictions_file": os.path.relpath(pred_path, ROOT),
        "pairs_file": os.path.relpath(pair_path, ROOT),
        "conversations": len(gold_by_id),
        "predicted_conversations": len(set(pred_by_id) & set(gold_by_id)),
        "unknown_ids": unknown[:10],
        "attributes": {a: attribute_metrics(pred_by_id, gold_by_id, a) for a in ATTRS},
        "pairs": pair_metrics(read_jsonl(pair_path), gold_pairs),
        "baselines": baselines(gold_by_id, dev_labels, gold_pairs),
    }

    h = result["attributes"]["helpfulness"]
    pr = result["pairs"]
    checks = {
        "coverage": (min(h.get("coverage", 0) or 0, pr.get("coverage") or 0), GATES["coverage"]),
        "helpfulness_qwk": (h.get("qwk") or 0, GATES["helpfulness_qwk"]),
        "helpfulness_within1": (h.get("within1") or 0, GATES["helpfulness_within1"]),
        "pairs_decisive_accuracy": (pr.get("decisive_accuracy") or 0, GATES["pairs_decisive_accuracy"]),
    }
    result["gates"] = {k: {"value": round(v, 3), "threshold": t, "pass": v >= t} for k, (v, t) in checks.items()}
    all_pass = all(g["pass"] for g in result["gates"].values())

    os.makedirs(os.path.join(ROOT, "work"), exist_ok=True)
    out_path = os.path.join(ROOT, "work", f"score-{args.split}.json")
    with open(out_path, "w") as f:
        json.dump(result, f, indent=2)

    print(f"split={args.split}  conversations={len(gold_by_id)}  predicted={result['predicted_conversations']}  pairs_predicted={pr['n']}/{len(gold_pairs)}")
    print(f"{'attribute':<12}{'n':>5}{'exact':>7}{'within1':>9}{'mae':>6}{'rho':>7}{'qwk':>7}   baseline(exact/qwk)")
    for a in ATTRS:
        m, b = result["attributes"][a], result["baselines"][a]
        if m["n"] == 0:
            print(f"{a:<12}{0:>5}   (no predictions)")
            continue
        print(f"{a:<12}{m['n']:>5}{m['exact']:>7}{m['within1']:>9}{m['mae']:>6}{str(m['spearman']):>7}{str(m['qwk']):>7}   always {b['majority_value']}: {b['exact']}/{b['qwk']}")
    bp = result["baselines"]["pairs"]
    print(f"pairs        n={pr['n']} accuracy_all={pr['accuracy_all']} decisive_accuracy={pr['decisive_accuracy']} "
          f"(picked {pr['decisive_picked']}/{pr['decisive_pairs']}) tie_recall={pr['tie_recall']}   baseline always-a: {bp['always_a_decisive_accuracy']}")
    if unknown:
        print(f"warning: {len(unknown)} prediction ids not in this split, e.g. {unknown[:3]}")
    for k, g in result["gates"].items():
        print(f"gate {k:<24} {g['value']:>6} >= {g['threshold']:<5} {'PASS' if g['pass'] else 'FAIL'}")
    print(f"details: {os.path.relpath(out_path, ROOT)}")
    print("SCORE PASS" if all_pass else "SCORE FAIL")
    sys.exit(0 if all_pass or args.split == "dev" else 1)


if __name__ == "__main__":
    main()
