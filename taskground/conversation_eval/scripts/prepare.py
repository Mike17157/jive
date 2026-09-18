#!/usr/bin/env python3
"""Build the conversation_eval data splits from NVIDIA HelpSteer2 (validation split).

Deterministic: the same --seed and sizes always produce the same files. Downloads once
into .cache/, then writes data/ (what the agent reads) and golden/ (held-out labels).

    scripts/prepare.py                 # defaults: 100 dev conversations, 200 test
    scripts/prepare.py --dev 60 --test 300 --seed 7
    scripts/prepare.py --offline       # fail instead of downloading if the cache is empty
"""
import argparse
import gzip
import json
import os
import random
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CACHE = os.path.join(ROOT, ".cache", "helpsteer2-validation.jsonl.gz")
URL = "https://huggingface.co/datasets/nvidia/HelpSteer2/resolve/main/validation.jsonl.gz"
ATTRS = ["helpfulness", "correctness", "coherence", "complexity", "verbosity"]
SEP = "<extra_id_1>"
MAX_CHARS = 12000  # prompt + response; keeps one conversation well inside Jev's input limit


def download(offline):
    if os.path.exists(CACHE):
        return
    if offline:
        sys.exit(f"cache missing at {CACHE} and --offline given")
    os.makedirs(os.path.dirname(CACHE), exist_ok=True)
    print(f"downloading {URL}", file=sys.stderr)
    req = urllib.request.Request(URL, headers={"User-Agent": "jive-taskground/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r, open(CACHE + ".part", "wb") as f:
            f.write(r.read())
    except Exception as e:  # noqa: BLE001
        sys.exit(f"download failed: {e}\nIf Hugging Face now requires a login for this dataset, "
                 f"download validation.jsonl.gz manually and place it at {CACHE}")
    os.replace(CACHE + ".part", CACHE)


def parse_turns(prompt):
    """HelpSteer2 stores multi-turn context as 'user text<extra_id_1>Assistant\\n...<extra_id_1>User\\n...'."""
    parts = prompt.split(SEP)
    turns = [{"role": "user", "content": parts[0].strip()}]
    for part in parts[1:]:
        role, _, content = part.partition("\n")
        role = role.strip().lower()
        if role not in ("user", "assistant"):
            raise ValueError(f"unexpected role marker {role!r}")
        turns.append({"role": role, "content": content.strip()})
    return turns


def load_rows():
    with gzip.open(CACHE, "rt", encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def write_jsonl(path, records):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dev", type=int, default=100, help="dev conversations (labels visible); rounded down to an even number")
    ap.add_argument("--test", type=int, default=200, help="test conversations (labels hidden in golden/); rounded down to even")
    ap.add_argument("--seed", type=int, default=2026)
    ap.add_argument("--offline", action="store_true")
    args = ap.parse_args()

    download(args.offline)
    rows = load_rows()

    # Group the two responses that share one prompt; they become a pair.
    groups = {}
    for row in rows:
        groups.setdefault(row["prompt"], []).append(row)
    prompts = sorted(p for p, rs in groups.items() if len(rs) == 2 and all(len(p) + len(r["response"]) <= MAX_CHARS for r in rs))
    rng = random.Random(args.seed)
    rng.shuffle(prompts)

    n_dev, n_test = args.dev // 2, args.test // 2
    if n_dev + n_test > len(prompts):
        sys.exit(f"asked for {n_dev + n_test} prompts but only {len(prompts)} are available")
    splits = {"dev": prompts[:n_dev], "test": prompts[n_dev:n_dev + n_test]}

    for split, chosen in splits.items():
        conversations, labels, pairs, pair_labels = [], [], [], []
        for i, prompt in enumerate(chosen):
            turns = parse_turns(prompt)
            pair_id = f"{split}-p{i:03d}"
            responses = list(groups[prompt])
            rng.shuffle(responses)  # hide which response HelpSteer2 listed first
            ids = []
            for j, row in enumerate(responses):
                cid = f"{pair_id}-{'ab'[j]}"
                ids.append(cid)
                record = {"id": cid, "pair_id": pair_id, "turns": turns, "response": row["response"]}
                label = {"id": cid, **{a: row[a] for a in ATTRS}}
                if split == "dev":
                    record["labels"] = {a: row[a] for a in ATTRS}
                conversations.append(record)
                labels.append(label)
            ha, hb = responses[0]["helpfulness"], responses[1]["helpfulness"]
            preferred = "tie" if ha == hb else ("a" if ha > hb else "b")
            pair = {"pair_id": pair_id, "a": ids[0], "b": ids[1]}
            if split == "dev":
                pair["preferred"] = preferred
            pairs.append(pair)
            pair_labels.append({"pair_id": pair_id, "preferred": preferred, "margin": abs(ha - hb)})

        write_jsonl(os.path.join(ROOT, "data", f"{split}.jsonl"), conversations)
        write_jsonl(os.path.join(ROOT, "data", f"{split}_pairs.jsonl"), pairs)
        write_jsonl(os.path.join(ROOT, "golden", f"{split}_labels.jsonl"), labels)
        write_jsonl(os.path.join(ROOT, "golden", f"{split}_pairs.jsonl"), pair_labels)
        ties = sum(1 for p in pair_labels if p["preferred"] == "tie")
        print(json.dumps({"split": split, "conversations": len(conversations), "pairs": len(pairs), "tie_pairs": ties,
                          "multi_turn": sum(1 for c in conversations if len(c["turns"]) > 1)}))

    with open(os.path.join(ROOT, "golden", "MANIFEST.json"), "w") as f:
        json.dump({"source": URL, "seed": args.seed, "dev": args.dev, "test": args.test, "max_chars": MAX_CHARS,
                   "attributes": ATTRS, "scale": "0-4 integers", "license": "CC-BY-4.0 (NVIDIA HelpSteer2)"}, f, indent=2)


if __name__ == "__main__":
    main()
