#!/usr/bin/env python3
"""Profile the supplied trace workload and retain machine-readable evidence."""

from __future__ import annotations

# This file is named profile.py, so remove its directory before cProfile imports
# the standard-library module with the same basename.
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) in sys.path:
    sys.path.remove(str(SCRIPT_DIR))

import cProfile
import io
import json
import pstats

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tracequery import search  # noqa: E402


def main() -> None:
    work = ROOT / "work"
    work.mkdir(exist_ok=True)
    query = json.loads((ROOT / "data/query.json").read_text(encoding="utf-8"))
    profiler = cProfile.Profile()
    rows = profiler.runcall(search, ROOT / "data/traces.jsonl", query)
    stats_path = work / "profile.pstats"
    profiler.dump_stats(stats_path)
    report = io.StringIO()
    pstats.Stats(profiler, stream=report).strip_dirs().sort_stats("cumulative").print_stats(30)
    report.write(f"\nresult rows: {len(rows)}\n")
    (work / "profile.txt").write_text(report.getvalue(), encoding="utf-8")
    print(f"wrote {stats_path} and {work / 'profile.txt'} ({len(rows)} rows)")


if __name__ == "__main__":
    main()
