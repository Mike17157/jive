#!/usr/bin/env python3
"""Run one representative query and print a compact, stable summary."""

from __future__ import annotations

import hashlib
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tracequery import search  # noqa: E402


def main() -> None:
    query = json.loads((ROOT / "data/query.json").read_text(encoding="utf-8"))
    started = time.perf_counter()
    rows = search(ROOT / "data/traces.jsonl", query)
    elapsed = time.perf_counter() - started
    encoded = json.dumps(rows, ensure_ascii=False, separators=(",", ":")).encode()
    print(json.dumps({
        "rows": len(rows),
        "sha256": hashlib.sha256(encoded).hexdigest(),
        "elapsedSeconds": round(elapsed, 6),
    }, sort_keys=True))


if __name__ == "__main__":
    main()
