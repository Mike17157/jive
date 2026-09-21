#!/usr/bin/env python3
"""Generate the deterministic search latency fixture."""

from __future__ import annotations

import argparse
import hashlib
import json
import random
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT / "data"
TENANTS = ("alpha", "beta", "gamma")
SERVICES = ("api", "worker", "search")
LEVELS = ("info", "warn", "error")
PHRASES = (
    "request accepted for café account",
    "index replica completed résumé update",
    "worker retried an upstream operation",
    "search returned ordinary catalog rows",
    "api processed a Unicode payload λ",
    "background cleanup finished normally",
)
BASE_TIMESTAMP = 1_720_000_000


def build_record(rng: random.Random, tenant: str, tenant_index: int, index: int) -> dict[str, object]:
    """Build one stable record; ``rng`` makes ``--seed`` observable."""
    marker_index = index // 211
    if index % 211 == 0:
        service = SERVICES[marker_index % len(SERVICES)]
        level = LEVELS[marker_index % len(LEVELS)]
        marker = " needle"
    else:
        service = SERVICES[(index + rng.randrange(len(SERVICES))) % len(SERVICES)]
        level = LEVELS[(index * 2 + rng.randrange(len(LEVELS))) % len(LEVELS)]
        marker = ""
    phrase = PHRASES[(index * 7 + rng.randrange(len(PHRASES))) % len(PHRASES)]
    return {
        "tenant": tenant,
        "id": f"{tenant}-{index:06d}",
        "timestamp": BASE_TIMESTAMP + tenant_index * 100_000 + index,
        "service": service,
        "level": level,
        "message": f"{phrase} item {index % 997}{marker}",
        "tags": ["prod", f"zone-{index % 4}"],
        "context": {
            "sequence": index,
            "correlation": f"{tenant}-{rng.getrandbits(32):08x}",
            "note": "synthetic diagnostic payload",
        },
    }


def generate(output_dir: Path, seed: int, records_per_tenant: int) -> dict[str, object]:
    if records_per_tenant < 0:
        raise ValueError("records per tenant must be nonnegative")
    output_dir.mkdir(parents=True, exist_ok=True)
    trace_path = output_dir / "traces.jsonl"
    rng = random.Random(seed)
    with trace_path.open("w", encoding="utf-8", newline="\n") as handle:
        for tenant_index, tenant in enumerate(TENANTS):
            for index in range(records_per_tenant):
                record = build_record(rng, tenant, tenant_index, index)
                handle.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")

    manifest = {
        "schemaVersion": 1,
        "seed": seed,
        "tenants": list(TENANTS),
        "recordsPerTenant": records_per_tenant,
        "records": records_per_tenant * len(TENANTS),
        "tracesSha256": hashlib.sha256(trace_path.read_bytes()).hexdigest(),
    }
    manifest_path = output_dir / "MANIFEST.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed", type=int, default=731)
    parser.add_argument("--records-per-tenant", type=int, default=6000)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    manifest = generate(args.output_dir, args.seed, args.records_per_tenant)
    print(json.dumps(manifest, sort_keys=True, separators=(",", ":")))


if __name__ == "__main__":
    main()
