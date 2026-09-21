#!/usr/bin/env python3
"""Measure serial median runtime for the supplied workload."""

from __future__ import annotations

import json
import statistics
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tracequery import search  # noqa: E402


def main() -> None:
    work = ROOT / "work"
    work.mkdir(exist_ok=True)
    query = json.loads((ROOT / "data/query.json").read_text(encoding="utf-8"))
    path = ROOT / "data/traces.jsonl"
    search(path, {**query, "limit": 5})
    samples = []
    row_count = None
    for _ in range(3):
        started = time.perf_counter()
        rows = search(path, query)
        samples.append(time.perf_counter() - started)
        row_count = len(rows)
    result = {
        "schemaVersion": 1,
        "samplesSeconds": [round(value, 6) for value in samples],
        "medianSeconds": round(statistics.median(samples), 6),
        "rows": row_count,
    }
    destination = work / "benchmark.json"
    destination.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
