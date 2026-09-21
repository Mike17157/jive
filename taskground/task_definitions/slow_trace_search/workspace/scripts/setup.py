#!/usr/bin/env python3
"""Generate the deterministic local performance fixture."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
COUNT = 32_000

SERVICES = ("api", "billing", "catalog", "search", "worker", "café")
LEVELS = ("DEBUG", "INFO", "WARN", "ERROR")
PHRASES = (
    "request accepted for tenant",
    "cache refresh completed for shard",
    "retry scheduled after upstream timeout",
    "database query completed with trace",
    "payment authorization pending review",
    "index update propagated to replica",
)


def record(index: int) -> dict[str, object]:
    service = SERVICES[(index * 7 + index // 11) % len(SERVICES)]
    level = LEVELS[(index * 5 + index // 17) % len(LEVELS)]
    phrase = PHRASES[(index * 13 + index // 19) % len(PHRASES)]
    marker = " needle" if index % 7 else " ordinary"
    return {
        "id": f"trace-{index:06d}",
        "timestamp": 1_700_000_000 + index,
        "service": service,
        "level": level,
        "message": f" {phrase} {index % 997}{marker} ",
        "tags": ["production", f"zone-{index % 4}", "http" if index % 3 else "batch"],
        "context": {
            "request": f"req-{index:08x}",
            "customer": f"Ténant {index % 311}",
            "route": ["/v1/items", f"partition-{index % 23}"],
            "details": {"attempt": index % 5, "note": "Synthetic payload for profiling"},
        },
    }


def main() -> None:
    DATA.mkdir(exist_ok=True)
    trace_path = DATA / "traces.jsonl"
    with trace_path.open("w", encoding="utf-8", newline="\n") as handle:
        for index in range(COUNT):
            handle.write(json.dumps(record(index), ensure_ascii=False, separators=(",", ":")) + "\n")

    query = {
        "min_timestamp": 1_700_000_100,
        "max_timestamp": 1_700_031_900,
        "levels": ["info", "warn", "error", "debug"],
        "services": list(SERVICES),
        "tags": ["PRODUCTION"],
        "terms": ["needle", "trace"],
    }
    query_path = DATA / "query.json"
    query_path.write_text(json.dumps(query, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    manifest = {
        "schemaVersion": 1,
        "seed": "slow-trace-search-v1",
        "records": COUNT,
        "tracesSha256": hashlib.sha256(trace_path.read_bytes()).hexdigest(),
        "querySha256": hashlib.sha256(query_path.read_bytes()).hexdigest(),
    }
    (DATA / "MANIFEST.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"generated {COUNT} records at {trace_path}")


if __name__ == "__main__":
    main()
