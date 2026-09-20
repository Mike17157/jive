#!/usr/bin/env python3
"""Maintainer command: regenerate the four small, pinned task fixtures (no model calls).

Downloads are cached under taskground/.cache. Only data/, verifier/reference.json,
SOURCE.json, and the shared public dev scorer are generated. Task instructions and
manifests are maintained separately. Normal task runs need no downloads.
"""
import csv
import gzip
import hashlib
import io
import json
from collections import Counter, defaultdict
from pathlib import Path
import shutil
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
TASKGROUND = ROOT / "taskground"
DEFINITIONS = TASKGROUND / "task_definitions"
CACHE = TASKGROUND / ".cache"
SEED = "taskground-v1-2026"
SEMBENCH_REVISION = "c814e3807e72d4cf876b852b17e77f3cc94575c2"
BANKING_REVISION = "57ec275d8078af65b7731c2a98be812d844a6d6b"
WDC_URL = "https://data.dws.informatik.uni-mannheim.de/largescaleproductcorpus/data/wdc-products/80pair.zip"
WDC_SHA256 = "b2044939cee5ea6f12148a2f3551508de3cb77660dfc91767c44daaf9d8a9c4a"


def dump(path, value, lines=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    text = "".join(json.dumps(row, ensure_ascii=False, allow_nan=False) + "\n" for row in value) if lines else json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + "\n"
    path.write_text(text)


def download(url):
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / hashlib.sha256(url.encode()).hexdigest()
    if not path.exists():
        print(f"Downloading {url}")
        request = urllib.request.Request(url, headers={"User-Agent": "jive-taskground/1.0"})
        with urllib.request.urlopen(request, timeout=90) as response:
            content = response.read()
        temporary = path.with_suffix(".part")
        temporary.write_bytes(content)
        temporary.replace(path)
    content = path.read_bytes()
    return content, {"url": url, "sha256": hashlib.sha256(content).hexdigest()}


def ordered(rows, key):
    return sorted(rows, key=lambda row: hashlib.sha256((SEED + str(key(row))).encode()).hexdigest())


def csv_rows(content):
    return list(csv.DictReader(io.StringIO(content.decode("utf-8-sig"))))


def finish(task, public, reference, source):
    target = DEFINITIONS / task
    for filename, rows in public.items():
        dump(target / "workspace/data" / filename, rows, filename.endswith(".jsonl"))
    dump(target / "verifier/reference.json", reference)
    dump(target / "SOURCE.json", {"adaptation": True, "seed": SEED, **source})
    scripts = target / "workspace/scripts"
    scripts.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(TASKGROUND / "_shared/score.py", scripts / "score.py")
    print(f"Prepared {task}: {source['size']}")


def movie():
    url = f"https://raw.githubusercontent.com/SemBench/SemBench/{SEMBENCH_REVISION}/files/movie/data/sf_2000/Reviews.csv"
    content, provenance = download(url)
    rows = csv_rows(content)
    rows = [row for row in rows if row["reviewText"].strip() and row["scoreSentiment"] in ("POSITIVE", "NEGATIVE")]
    # The published scale-factor CSV repeats some reviews. One ID must mean one judgment.
    rows = list({row["reviewId"]: row for row in rows}.values())
    counts = Counter(row["id"] for row in rows)
    movies = sorted((movie for movie, count in counts.items() if count >= 30), key=lambda movie: (-counts[movie], movie))[:4]
    assert len(movies) == 4, "Upstream no longer has four movies with 30 reviews each"
    selected = [row for movie in movies for row in ordered([r for r in rows if r["id"] == movie], lambda r: r["reviewId"])[:30]]
    selected_ids = {row["reviewId"] for row in selected}
    dev = []
    for label in ("POSITIVE", "NEGATIVE"):
        dev.extend(ordered([r for r in rows if r["reviewId"] not in selected_ids and r["scoreSentiment"] == label], lambda r: r["reviewId"])[:6])
    def visible(row):
        return {"id": row["reviewId"], "movie_id": row["id"], "text": row["reviewText"]}
    test = ordered([visible(row) for row in selected], lambda r: r["id"])
    labels = [{"id": row["reviewId"], "sentiment": row["scoreSentiment"].lower()} for row in selected]
    query = {"movies": sorted(movies), "pair_movie": movies[0], "pair_count": 10}
    finish("sembench_movie", {"test.jsonl": test, "dev.jsonl": [{**visible(row), "sentiment": row["scoreSentiment"].lower()} for row in dev], "queries.json": query},
           {"task": "sembench_movie", "records": test, "labels": labels, "queries": query},
           {"benchmark": "SemBench movie scenario", "upstream": "https://github.com/SemBench/SemBench", "revision": SEMBENCH_REVISION, "sources": [provenance], "size": {"test_reviews": 120, "dev_reviews": 12, "movies": 4},
            "selection": "Deduplicate review IDs, then choose four most frequent movies with at least 30 reviews; 30 deterministic hash-sampled reviews per movie; 6 positive and 6 negative disjoint dev examples.",
            "changes": "Small adaptation of semantic count/join/rank workloads. Rank by positive-review fraction rather than Q10's 1–5 ratings. Strip originalScore, reviewState, scoreSentiment, URLs and all other label-bearing metadata from test inputs.",
            "attribution": "SemBench authors; Rotten Tomatoes review corpus distributed with SemBench. Upstream repository code is MIT/Apache-2.0; source review content retains its original rights. These are development fixtures, not official benchmark results."})


def products():
    content, provenance = download(WDC_URL)
    if provenance["sha256"] != WDC_SHA256:
        raise ValueError("WDC archive changed; review its content and update the pinned checksum explicitly")
    archive = zipfile.ZipFile(io.BytesIO(content))
    test_name = "wdcproducts80cc20rnd100un_gs.json.gz"
    dev_name = "wdcproducts80cc20rnd000un_train_small.json.gz"
    def read(name):
        return [json.loads(line) for line in gzip.decompress(archive.read(name)).decode().splitlines() if line.strip()]
    def sample(rows, count):
        result = []
        for label in (0, 1):
            result.extend(ordered([row for row in rows if row["label"] == label], lambda row: row["pair_id"])[:count // 2])
        assert len(result) == count
        return ordered(result, lambda row: row["pair_id"])
    test_rows, dev_rows = sample(read(test_name), 120), sample(read(dev_name), 20)
    fields = ("brand", "title", "description", "price", "priceCurrency")
    def visible(row, index, prefix):
        def side(suffix):
            return {field: row.get(f"{field}_{suffix}") if isinstance(row.get(f"{field}_{suffix}"), (str, int, bool)) else "" for field in fields}
        return {"id": f"{prefix}-{index:03d}", "left": side("left"), "right": side("right")}
    test = [visible(row, i, "test") for i, row in enumerate(test_rows)]
    dev = [{**visible(row, i, "dev"), "match": bool(row["label"])} for i, row in enumerate(dev_rows)]
    finish("product_matching", {"test.jsonl": test, "dev.jsonl": dev},
           {"task": "product_matching", "labels": [{"id": record["id"], "match": bool(row["label"])} for record, row in zip(test, test_rows)]},
           {"benchmark": "WDC Products", "upstream": "https://webdatacommons.org/largescaleproductcorpus/wdc-products/", "sources": [provenance], "size": {"test_pairs": 120, "dev_pairs": 20},
            "selection": {"test_file": test_name, "dev_file": dev_name, "method": "Deterministic balanced sample: half matches, half nonmatches", "test_pair_ids": [r["pair_id"] for r in test_rows], "dev_pair_ids": [r["pair_id"] for r in dev_rows]},
            "changes": "Remove labels, cluster IDs, hard-negative flags, source IDs and split metadata from test records. Retain descriptive product attributes only.",
            "attribution": "Ralph Peeters, Reng Chiz Der and Christian Bizer, WDC Products (EDBT 2024). Data provided by Web Data Commons under its source terms; preserve this attribution. Development subset, not an official benchmark score."})


def intents():
    base = f"https://raw.githubusercontent.com/PolyAI-LDN/task-specific-datasets/{BANKING_REVISION}/banking_data"
    test_bytes, test_source = download(base + "/test.csv")
    train_bytes, train_source = download(base + "/train.csv")
    categories_bytes, categories_source = download(base + "/categories.json")
    categories = json.loads(categories_bytes)
    def sample(content, n):
        by_label = defaultdict(list)
        for row in csv_rows(content):
            by_label[row["category"]].append(row)
        return ordered([row for label in categories for row in ordered(by_label[label], lambda r: r["text"])[:n]], lambda r: r["text"])
    selected, demonstrations = sample(test_bytes, 2), sample(train_bytes, 1)
    test = [{"id": f"test-{i:03d}", "text": row["text"]} for i, row in enumerate(selected)]
    dev = [{"id": f"dev-{i:03d}", "text": row["text"], "intent": row["category"]} for i, row in enumerate(demonstrations)]
    assert len(test) == 154 and len(dev) == 77
    finish("intent_routing", {"test.jsonl": test, "dev.jsonl": dev, "intents.json": categories},
           {"task": "intent_routing", "labels": [{"id": record["id"], "intent": row["category"]} for record, row in zip(test, selected)], "intents": categories},
           {"benchmark": "BANKING77", "upstream": "https://github.com/PolyAI-LDN/task-specific-datasets", "revision": BANKING_REVISION, "sources": [test_source, train_source, categories_source], "size": {"test_requests": 154, "labeled_examples": 77, "intents": 77},
            "selection": "Two deterministic test examples and one training example for every intent. Original train/test boundary preserved; examples shuffled by stable content hash.",
            "license": "CC-BY-4.0", "attribution": "Iñigo Casanueva et al., Efficient Intent Detection with Dual Sentence Encoders (2020), PolyAI. Small development adaptation; not an official full-test score."})


def conversations():
    source = TASKGROUND / "conversation_eval"
    def read(path):
        return [json.loads(line) for line in (source / path).read_text().splitlines() if line.strip()]
    public, reference, provenance = {}, {"task": "conversation_eval"}, []
    for split, count in (("dev", 10), ("test", 20)):
        pairs = ordered(read(f"data/{split}_pairs.jsonl"), lambda r: r["pair_id"])[:count]
        ids = {p[key] for p in pairs for key in ("a", "b")}
        pair_ids = {p["pair_id"] for p in pairs}
        public[f"{split}.jsonl"] = [r for r in read(f"data/{split}.jsonl") if r["id"] in ids]
        public[f"{split}_pairs.jsonl"] = pairs
        reference[f"{split}_labels"] = [r for r in read(f"golden/{split}_labels.jsonl") if r["id"] in ids]
        reference[f"{split}_pairs"] = [r for r in read(f"golden/{split}_pairs.jsonl") if r["pair_id"] in pair_ids]
        for name in (f"data/{split}.jsonl", f"data/{split}_pairs.jsonl", f"golden/{split}_labels.jsonl", f"golden/{split}_pairs.jsonl"):
            provenance.append({"path": "taskground/conversation_eval/" + name, "sha256": hashlib.sha256((source / name).read_bytes()).hexdigest()})
    finish("conversation_eval", public, reference,
           {"benchmark": "NVIDIA HelpSteer2; existing Jive conversation_eval adaptation", "upstream": "https://huggingface.co/datasets/nvidia/HelpSteer2", "sources": provenance, "size": {"dev_responses": 20, "dev_pairs": 10, "test_responses": 40, "test_pairs": 20, "dev_rounds": 3, "judgments_without_batching": 150},
            "selection": "Deterministic subsets of existing dev/test pairs, preserving the original split. Three dev rounds, one final test pass; all five attributes judged together per response.",
            "license": "CC-BY-4.0", "attribution": "NVIDIA HelpSteer2. Original full task remains at taskground/conversation_eval. Thresholds are provisional development targets, not official benchmark scores."})


if __name__ == "__main__":
    movie()
    products()
    intents()
    conversations()
