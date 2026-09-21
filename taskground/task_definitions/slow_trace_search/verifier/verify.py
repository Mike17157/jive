#!/usr/bin/env python3
"""Held-out verifier for the slow_trace_search Taskground task."""

from __future__ import annotations

import gc
import hashlib
import importlib.util
import json
import math
import os
import pstats
import statistics
import subprocess
import sys
import tempfile
import time
import traceback
import unicodedata
from pathlib import Path
from typing import Any

# Import both implementations without leaving bytecode in the frozen definition.
sys.dont_write_bytecode = True

SCHEMA_VERSION = 1
MIN_SPEEDUP = 3.0
SAMPLES = 3

# Candidate-visible harness and generated data are sealed. Optimizable package
# files are intentionally absent from this table.
SEALED = {
    "scripts/setup.py": "3a5fa482ce622f7e7faf3bc72825fb870bf30d472332b3ee08839ec4d5e6995f",
    "scripts/quick_workload.py": "29a0bac5584c6d0d77abd406f631c3d25a5272bc55129c500b385b9c27f1cda3",
    "scripts/profile.py": "0a4056fde07503d9291a8523905b6bfdc3e41344e1aee138857e123d74bd5a42",
    "scripts/benchmark.py": "18d1ba8adce05912391133c8560a35f818cb3d113d60ac6ba25e38191ac7eac9",
    "tests/test_public.py": "9e25eb43aa16d050ceb76d843d5e14de963d600d87a571c393c40b1436e96efe",
    "data/traces.jsonl": "5a879ddf9b8b758868e3650422ec0e67235166f1d9f4d6ae5ab9cdba94a0eca5",
    "data/query.json": "31136a19e9e8c431d87f4f670102ab74e2ffc3646d6a8d52a069a89a116c678f",
    "data/MANIFEST.json": "7b51b9e57d9dc3081fb9a07446b4efbc160a959caae257f5085167d54d1b0a19",
}

# Filled with the package-tree digest of definition/workspace/tracequery.
FROZEN_PACKAGE_SHA256 = "3e7a08fbbcc3f4719cf20bc874141581f98aa357433f619a6e2a5e2ebce63872"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def tree_digest(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*.py")):
        relative = path.relative_to(root).as_posix().encode()
        content = path.read_bytes()
        digest.update(relative + b"\0" + str(len(content)).encode() + b"\0" + content)
    return digest.hexdigest()


def load_search(root: Path, alias: str):
    package = root / "tracequery"
    spec = importlib.util.spec_from_file_location(
        alias, package / "__init__.py", submodule_search_locations=[str(package)]
    )
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot import tracequery from {root}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[alias] = module
    spec.loader.exec_module(module)
    return module.search


def normalize(value: Any) -> str:
    return unicodedata.normalize("NFKC", str(value)).casefold().strip()


def oracle(records: list[dict[str, Any]], query: dict[str, Any]) -> list[dict[str, Any]]:
    limit = query.get("limit")
    if limit is not None:
        limit = int(limit)
        if limit < 0:
            raise ValueError("limit must be non-negative")
        if limit == 0:
            return []
    levels = {normalize(item) for item in query.get("levels", [])}
    services = {normalize(item) for item in query.get("services", [])}
    required_tags = {normalize(item) for item in query.get("tags", [])}
    terms = [normalize(item) for item in query.get("terms", [])]
    answer: list[dict[str, Any]] = []
    for raw in records:
        timestamp = int(raw["timestamp"])
        level = normalize(raw["level"])
        service = normalize(raw["service"])
        message = normalize(raw["message"])
        tags = [normalize(item) for item in raw["tags"]]
        if "min_timestamp" in query and timestamp < int(query["min_timestamp"]):
            continue
        if "max_timestamp" in query and timestamp > int(query["max_timestamp"]):
            continue
        if levels and level not in levels:
            continue
        if services and service not in services:
            continue
        if required_tags and not required_tags.issubset(set(tags)):
            continue
        if terms and not all(term in message for term in terms):
            continue
        answer.append({
            "id": normalize(raw["id"]), "timestamp": timestamp,
            "service": service, "level": level, "message": message, "tags": tags,
        })
        if limit is not None and len(answer) >= limit:
            break
    return answer


def write_records(path: Path, records: list[dict[str, Any]]) -> None:
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write("\n")
        for record in records:
            handle.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
        handle.write("  \n")


def held_out_records(count: int, salt: int) -> list[dict[str, Any]]:
    services = ("API", " worker ", "ＣＡＴＡＬＯＧ", "cafe\u0301", "İstanbul")
    levels = ("Info", "WARN", " error ", "ＤＥＢＵＧ")
    phrases = ("Café ready", "RETRY Δelta", "Kelvin Key", "naïve façade", "東京 ready")
    rows: list[dict[str, Any]] = []
    for index in range(count):
        value = index + salt * 97
        rows.append({
            "id": f" H-{salt}-{index:05d} ",
            "timestamp": 1_810_000_000 + value,
            "service": services[(value * 7 + value // 9) % len(services)],
            "level": levels[(value * 3 + value // 13) % len(levels)],
            "message": f" {phrases[(value * 11 + value // 17) % len(phrases)]} token-{value % 31} {'needle' if value % 5 else 'haystack'} ",
            "tags": [" Prod ", f"zone-{value % 4}", "βeta" if value % 3 else "BATCH", f"zone-{value % 4}"],
            "context": {"unicode": "① FULL", "items": [f"nested-{value}", {"note": "UNUSED"}]},
        })
    if count >= 8:
        rows.insert(3, dict(rows[7]))
        rows.append(dict(rows[0]))
    # A deterministic permutation catches sorted-output implementations.
    return sorted(rows, key=lambda row: hashlib.sha256((str(row["id"]) + str(salt)).encode()).digest())


def check_correctness(search, temporary: Path) -> tuple[bool, str]:
    records = held_out_records(137, 3)
    path = temporary / "unseen.jsonl"
    write_records(path, records)
    queries = [
        {},
        {"services": [" ｃａｆé "], "levels": ["WARN", "error"], "terms": ["NEEDLE"], "tags": ["prod"]},
        {"min_timestamp": 1_810_000_300, "max_timestamp": 1_810_000_410, "tags": ["βETA", "βeta"], "limit": 9},
        {"services": ["İSTANBUL", "api"], "terms": ["ready", "東京"], "limit": 0, "ignored": "yes"},
    ]
    for index, query in enumerate(queries):
        expected = oracle(records, query)
        actual = search(path, query)
        if type(actual) is not list or json.dumps(actual, ensure_ascii=False) != json.dumps(expected, ensure_ascii=False):
            return False, f"held-out query {index} differed (expected {len(expected)} rows, got {len(actual) if isinstance(actual, list) else type(actual).__name__})"

    try:
        search(path, {"limit": -2})
    except ValueError:
        pass
    else:
        return False, "negative limit did not raise ValueError"

    # Reuse the same path after changing its contents to reject stale result caches.
    changed = held_out_records(43, 11)
    write_records(path, changed)
    query = {"terms": ["needle"], "levels": ["info", "warn", "error", "debug"]}
    if search(path, query) != oracle(changed, query):
        return False, "results did not follow changed input contents"
    return True, f"{len(queries) + 2} varied checks passed"


def perf_records(count: int = 22_000) -> list[dict[str, Any]]:
    rows = []
    for index in range(count):
        rows.append({
            "id": f"perf-{index:06d}",
            "timestamp": 1_900_000_000 + index,
            "service": ("gateway", "worker", "billing", "search")[index % 4],
            "level": ("INFO", "WARN", "ERROR", "DEBUG")[(index * 3 + index // 29) % 4],
            "message": f" distributed trace operation {index % 997} {'needle' if index % 7 else 'ordinary'} completed ",
            "tags": ["production", f"zone-{index % 5}", "trace"],
            "context": {"request": f"req-{index:08x}", "account": f"client-{index % 503}", "nested": ["SYNTHETIC", "payload", {"part": index % 17}]},
        })
    return rows


def median_runtime(search, path: Path, query: dict[str, Any]) -> tuple[float, list[float], list[dict[str, Any]]]:
    search(path, {**query, "limit": 3})
    samples = []
    result = []
    for _ in range(SAMPLES):
        gc.collect()
        enabled = gc.isenabled()
        gc.disable()
        started = time.perf_counter()
        try:
            result = search(path, query)
        finally:
            samples.append(time.perf_counter() - started)
            if enabled:
                gc.enable()
    return statistics.median(samples), samples, result


def check_evidence(workspace: Path) -> tuple[bool, str, dict[str, Any]]:
    paths = [workspace / "work/profile.pstats", workspace / "work/profile.txt", workspace / "work/benchmark.json", workspace / "work/report.md"]
    missing = [path.name for path in paths if not path.is_file() or path.stat().st_size == 0]
    if missing:
        return False, "missing evidence: " + ", ".join(missing), {}
    try:
        benchmark = json.loads(paths[2].read_text(encoding="utf-8"))
        samples = benchmark["samplesSeconds"]
        median = float(benchmark["medianSeconds"])
        if benchmark.get("schemaVersion") != 1 or len(samples) < 3 or not math.isfinite(median) or median <= 0 or any(not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0 for value in samples):
            raise ValueError("invalid benchmark fields")
        pstats.Stats(str(paths[0]))
        if not paths[3].read_text(encoding="utf-8").strip():
            raise ValueError("report is empty")
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError) as error:
        return False, f"invalid evidence: {error}", {}
    return True, "profile, benchmark, and report evidence present", {"reportedMedianSeconds": median}


def main() -> int:
    workspace = Path(os.environ["TASKGROUND_WORKSPACE"]).resolve()
    definition = Path(os.environ["TASKGROUND_DEFINITION"]).resolve()
    result_path = Path(os.environ["TASKGROUND_RESULT"]).resolve()
    checks: list[dict[str, Any]] = []
    metrics: dict[str, Any] = {"minimumSpeedup": MIN_SPEEDUP, "samplesPerImplementation": SAMPLES}

    def add(name: str, passed: bool, detail: str) -> None:
        checks.append({"name": name, "status": "passed" if passed else "failed", "detail": detail})

    try:
        altered = []
        for relative, expected in SEALED.items():
            path = workspace / relative
            if not path.is_file() or sha256(path) != expected:
                altered.append(relative)
        add("immutable harness and data", not altered, "all sealed files match" if not altered else "changed or missing: " + ", ".join(altered))

        frozen_root = definition / "workspace"
        frozen_digest = tree_digest(frozen_root / "tracequery")
        frozen_ok = frozen_digest == FROZEN_PACKAGE_SHA256
        add("frozen baseline integrity", frozen_ok, f"package sha256 {frozen_digest}")

        candidate = load_search(workspace, "candidate_tracequery")
        tests = subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", "tests"], cwd=workspace, text=True, capture_output=True, timeout=10)
        add("workspace tests", tests.returncode == 0, (tests.stdout + tests.stderr)[-4000:])
        with tempfile.TemporaryDirectory(prefix="slow-trace-verify-") as temporary_name:
            temporary = Path(temporary_name)
            correct, detail = check_correctness(candidate, temporary)
            add("held-out correctness", correct, detail)

            records = perf_records()
            perf_path = temporary / "performance.jsonl"
            write_records(perf_path, records)
            query = {
                "min_timestamp": 1_900_000_100,
                "max_timestamp": 1_900_021_900,
                "levels": ["info", "warn", "error", "debug"],
                "services": ["gateway", "worker", "billing", "search"],
                "tags": ["PRODUCTION", "trace"],
                "terms": ["operation", "needle", "completed"],
            }
            expected = oracle(records, query)
            original = load_search(frozen_root, "original_tracequery")
            original_median, original_samples, original_rows = median_runtime(original, perf_path, query)
            candidate_median, candidate_samples, candidate_rows = median_runtime(candidate, perf_path, query)
            result_ok = original_rows == expected and candidate_rows == expected
            add("performance workload correctness", result_ok, f"expected {len(expected)} rows")
            speedup = original_median / candidate_median if candidate_median > 0 else 0.0
            perf_ok = result_ok and frozen_ok and speedup >= MIN_SPEEDUP
            add("calibrated speedup", perf_ok, f"{speedup:.2f}x (original {original_median:.4f}s, candidate {candidate_median:.4f}s)")
            metrics.update({
                "originalMedianSeconds": round(original_median, 6),
                "candidateMedianSeconds": round(candidate_median, 6),
                "speedup": round(speedup, 3),
                "originalSamplesSeconds": [round(value, 6) for value in original_samples],
                "candidateSamplesSeconds": [round(value, 6) for value in candidate_samples],
                "performanceRows": len(expected),
            })

        evidence_ok, evidence_detail, evidence_metrics = check_evidence(workspace)
        add("profiling and benchmark evidence", evidence_ok, evidence_detail)
        metrics.update(evidence_metrics)
    except Exception as error:  # Always leave a machine-readable failure report.
        add("verifier execution", False, f"{type(error).__name__}: {error}")
        metrics["traceback"] = traceback.format_exc(limit=8)

    passed = bool(checks) and all(check["status"] == "passed" for check in checks)
    report = {"schemaVersion": SCHEMA_VERSION, "task": "slow_trace_search", "status": "passed" if passed else "failed", "checks": checks, "metrics": metrics,
              "limitations": ["Automated behavior and evidence checks; investigation method and report quality require trace review. Local folder separation is not a sandbox."]}
    result_path.parent.mkdir(parents=True, exist_ok=True)
    result_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(report, sort_keys=True))
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
