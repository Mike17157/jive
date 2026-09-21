#!/usr/bin/env python3
"""Held-out verifier for the search_latency Taskground task."""

from __future__ import annotations

import concurrent.futures
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
import threading
import time
import traceback
import unicodedata
from collections import Counter
from pathlib import Path
from typing import Any, Iterable

# Import candidate and baseline packages without modifying the frozen definition.
sys.dont_write_bytecode = True

SCHEMA_VERSION = 1
MIN_SPEEDUP = 3.0
SAMPLES = 3
PERF_REQUESTS = 84


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def comparable_files(root: Path) -> dict[str, str]:
    """Return hashes of source-controlled files, excluding interpreter litter."""
    answer: dict[str, str] = {}
    if not root.is_dir():
        return answer
    for path in sorted(root.rglob("*")):
        if not path.is_file() or "__pycache__" in path.parts or path.suffix == ".pyc":
            continue
        answer[path.relative_to(root).as_posix()] = sha256(path)
    return answer


def load_service(root: Path, alias: str):
    package = root / "searchapp"
    spec = importlib.util.spec_from_file_location(
        alias, package / "__init__.py", submodule_search_locations=[str(package)]
    )
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot import searchapp from {root}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[alias] = module
    spec.loader.exec_module(module)
    service = getattr(module, "SearchService", None)
    if service is None:
        raise RuntimeError(f"searchapp at {root} does not export SearchService")
    return service


def normalize(value: Any) -> str:
    return unicodedata.normalize("NFKC", str(value)).casefold().strip()


def output_row(raw: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": normalize(raw["id"]),
        "timestamp": int(raw["timestamp"]),
        "service": normalize(raw["service"]),
        "level": normalize(raw["level"]),
        "message": normalize(raw["message"]),
        "tags": [normalize(item) for item in raw["tags"]],
    }


def oracle(
    records: Iterable[dict[str, Any]], tenant: str, query: dict[str, Any]
) -> list[dict[str, Any]]:
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
        if raw["tenant"] != tenant:
            continue
        row = output_row(raw)
        if "min_timestamp" in query and row["timestamp"] < int(query["min_timestamp"]):
            continue
        if "max_timestamp" in query and row["timestamp"] > int(query["max_timestamp"]):
            continue
        if levels and row["level"] not in levels:
            continue
        if services and row["service"] not in services:
            continue
        if required_tags and not required_tags.issubset(set(row["tags"])):
            continue
        if terms and not all(term in row["message"] for term in terms):
            continue
        answer.append(row)
        if limit is not None and len(answer) >= limit:
            break
    return answer


def expected_response(
    request_id: str,
    tenant: str,
    records: Iterable[dict[str, Any]],
    query: dict[str, Any],
) -> dict[str, Any]:
    return {
        "request_id": request_id,
        "tenant": tenant,
        "rows": oracle(records, tenant, query),
    }


def write_records(path: Path, records: Iterable[dict[str, Any]]) -> None:
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write("\n")
        for record in records:
            handle.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
        handle.write("  \n")


def held_out_records(count_per_tenant: int = 73) -> list[dict[str, Any]]:
    tenants = ("Amber", "tenant-β", "東京")
    services = (" API ", "worker", "ＳＥＡＲＣＨ", "cafe\u0301")
    levels = ("Info", " WARN ", "ＥＲＲＯＲ", "debug")
    phrases = ("Café ready", "RETRY Δelta", "Kelvin Key", "東京 ready", "naïve façade")
    rows: list[dict[str, Any]] = []
    for tenant_index, tenant in enumerate(tenants):
        for index in range(count_per_tenant):
            value = index + tenant_index * 109
            rows.append({
                "tenant": tenant,
                "id": f" H-{tenant_index}-{index:04d} ",
                "timestamp": 1_830_000_000 + value,
                "service": services[(value * 5 + value // 7) % len(services)],
                "level": levels[(value * 3 + value // 11) % len(levels)],
                "message": f" {phrases[(value * 7 + value // 13) % len(phrases)]} token-{value % 17} {'needle' if value % 4 else 'haystack'} ",
                "tags": [" Prod ", f"zone-{value % 4}", "βeta" if value % 3 else "BATCH", f"zone-{value % 4}"],
                "context": {"unicode": "① FULL", "nested": [f"item-{value}", {"ignored": True}]},
            })
    # Duplicates and this deterministic interleaving catch deduplication, sorting,
    # and implementations that accidentally group output by tenant.
    rows.insert(5, dict(rows[17]))
    rows.insert(91, dict(rows[82]))
    rows.append(dict(rows[0]))
    return sorted(
        rows,
        key=lambda row: hashlib.sha256(
            (str(row["id"]) + row["tenant"] + "held-out-991").encode("utf-8")
        ).digest(),
    )


def same_json(actual: Any, expected: Any) -> bool:
    return json.dumps(actual, ensure_ascii=False, separators=(",", ":")) == json.dumps(
        expected, ensure_ascii=False, separators=(",", ":")
    )


def response_shape(response: Any) -> bool:
    if type(response) is not dict or list(response) != ["request_id", "tenant", "rows"]:
        return False
    if type(response["rows"]) is not list:
        return False
    expected = ["id", "timestamp", "service", "level", "message", "tags"]
    return all(type(row) is dict and list(row) == expected for row in response["rows"])


class EventCollector:
    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []
        self.lock = threading.Lock()

    def __call__(self, event: dict[str, Any]) -> None:
        with self.lock:
            self.events.append(dict(event))


def check_behavior(Service: Any, temporary: Path) -> tuple[bool, str]:
    records = held_out_records()
    path = temporary / "held-out.jsonl"
    write_records(path, records)
    collector = EventCollector()
    service = Service(
        path,
        cache_enabled=True,
        audit_batch_size=4,
        cache_capacity=32,
        recorder=collector,
    )
    expected_audit: list[dict[str, Any]] = []

    def request(request_id: str, tenant: str, query: dict[str, Any]) -> dict[str, Any]:
        response = service.handle({"request_id": request_id, "tenant": tenant, "query": query})
        expected = expected_response(request_id, tenant, records, query)
        if not response_shape(response) or not same_json(response, expected):
            raise AssertionError(
                f"request {request_id} differed (expected {len(expected['rows'])} rows, "
                f"got {len(response.get('rows', [])) if isinstance(response, dict) else type(response).__name__})"
            )
        expected_audit.append({"request_id": request_id, "tenant": tenant, "row_count": len(expected["rows"])})
        return response

    try:
        varied = [
            (" Req-① ", "Amber", {}),
            ("filters", "tenant-β", {"services": [" ｃａｆé ", "api"], "levels": ["WARN", "error"], "terms": ["NEEDLE"], "tags": ["prod"], "ignored": "yes"}),
            ("bounds", "東京", {"min_timestamp": 1_830_000_220, "max_timestamp": 1_830_000_292, "tags": ["βETA", "βeta"], "limit": 9}),
            ("zero", "Amber", {"services": ["search"], "limit": 0}),
            ("missing", "missing", {"terms": ["ready"]}),
            ("tenant-exact", "amber", {}),
        ]
        for request_id, tenant, query in varied:
            request(request_id, tenant, query)

        repeated_query = {"terms": ["NEEDLE"], "tags": ["prod"], "limit": 7}
        original = request("copy-1", "Amber", repeated_query)
        if original["rows"]:
            original["rows"][0]["message"] = "mutated"
            original["rows"][0]["tags"].append("mutated")
        original["rows"].append({"bad": "row"})
        # This request is a cache hit before the fourth pending audit entry
        # advances the seeded implementation's global revision.
        request("copy-2", "Amber", repeated_query)
        request("copy-3", "Amber", repeated_query)

        hit_events = [
            event for event in collector.events
            if event.get("event") == "cache" and event.get("hit") is True and event.get("tenant") == "Amber"
        ]
        if not hit_events:
            raise AssertionError("repeated query did not produce a cache-hit event")

        added = [
            {
                "tenant": "Amber", "id": " Fresh-① ", "timestamp": 1_930_000_001,
                "service": " API ", "level": "WARN", "message": " Café NEEDLE just ingested ",
                "tags": [" Prod ", "zone-new", "βeta"], "context": {"ignored": "YES"},
            },
            {
                "tenant": "Amber", "id": " Fresh-① ", "timestamp": 1_930_000_001,
                "service": " API ", "level": "WARN", "message": " Café NEEDLE just ingested ",
                "tags": [" Prod ", "zone-new", "βeta"], "context": {"ignored": "YES"},
            },
        ]
        fresh_query = {"terms": ["just ingested"], "tags": ["ZONE-NEW"]}
        request("fresh-before", "Amber", fresh_query)
        service.ingest("Amber", added)
        records.extend(added)
        request("fresh-alpha", "Amber", fresh_query)
        request("fresh-isolation", "tenant-β", {"terms": ["just ingested"]})

        try:
            service.handle({"request_id": "negative", "tenant": "Amber", "query": {"limit": -1}})
        except ValueError:
            pass
        else:
            raise AssertionError("negative limit did not raise ValueError")

        for bad_request in (
            {"request_id": "", "tenant": "Amber", "query": {}},
            {"request_id": "bad-tenant", "tenant": "", "query": {}},
            {"request_id": 17, "tenant": "Amber", "query": {}},
        ):
            try:
                service.handle(bad_request)
            except ValueError:
                pass
            else:
                raise AssertionError("empty or non-string request identity was accepted")

        service.flush_audit()
        service.flush_audit()
        audit = service.audit_records()
        if audit != expected_audit:
            raise AssertionError(f"audit mismatch: expected {len(expected_audit)} exact entries, got {len(audit)}")
    finally:
        service.close()

    # A separate service makes concurrent response and audit accounting easy to
    # compare without assuming an order among workers.
    concurrent_path = temporary / "concurrent.jsonl"
    write_records(concurrent_path, records)
    concurrent_collector = EventCollector()
    concurrent_service = Service(
        concurrent_path,
        cache_enabled=True,
        audit_batch_size=4,
        cache_capacity=32,
        recorder=concurrent_collector,
    )
    jobs: list[tuple[str, str, dict[str, Any]]] = []
    tenants = ("Amber", "tenant-β", "東京")
    queries = (
        {"terms": ["needle"], "limit": 6},
        {"tags": ["prod", "βeta"], "levels": ["info", "warn"], "limit": 8},
        {"services": ["api", "search"], "min_timestamp": 1_830_000_020, "limit": 5},
    )
    for index in range(36):
        jobs.append((f"parallel-{index:02d}", tenants[index % len(tenants)], queries[index % len(queries)]))

    def concurrent_call(job: tuple[str, str, dict[str, Any]]) -> tuple[str, dict[str, Any]]:
        request_id, tenant, query = job
        return request_id, concurrent_service.handle({"request_id": request_id, "tenant": tenant, "query": query})

    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            actual = dict(pool.map(concurrent_call, jobs))
        for request_id, tenant, query in jobs:
            expected = expected_response(request_id, tenant, records, query)
            if not response_shape(actual[request_id]) or not same_json(actual[request_id], expected):
                raise AssertionError(f"concurrent request {request_id} differed")
        concurrent_service.flush_audit()
        audit = concurrent_service.audit_records()
        expected_counter = Counter(
            (request_id, tenant, len(oracle(records, tenant, query)))
            for request_id, tenant, query in jobs
        )
        actual_counter = Counter(
            (item.get("request_id"), item.get("tenant"), item.get("row_count"))
            for item in audit if isinstance(item, dict)
        )
        if actual_counter != expected_counter or len(audit) != len(jobs):
            raise AssertionError(f"concurrent audit mismatch: expected {len(jobs)} exact entries, got {len(audit)}")
    finally:
        concurrent_service.close()

    return True, f"varied sequential checks and {len(jobs)} concurrent requests passed"


def perf_records(count_per_tenant: int = 7_000) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    tenants = ("perf-amber", "perf-blue", "perf-紫")
    services = ("api", "worker", "search")
    levels = ("info", "warn", "error")
    for tenant_index, tenant in enumerate(tenants):
        for index in range(count_per_tenant):
            value = index + tenant_index * 37
            # Each service/level pairing occurs and every 211th row supplies the
            # rare term, forcing meaningful scans while keeping response copies small.
            rows.append({
                "tenant": tenant,
                "id": f"perf-{tenant_index}-{index:06d}",
                "timestamp": 1_950_000_000 + index,
                "service": services[(value + value // 19) % len(services)],
                "level": levels[(value * 2 + value // 23) % len(levels)],
                "message": f"distributed operation {value % 997} {'needle' if index % 211 == 0 else 'ordinary'} completed",
                "tags": ["prod", f"zone-{index % 5}", "trace"],
                "context": {"request": f"req-{value:08x}", "nested": ["payload", {"part": value % 17}]},
            })
    return rows


def perf_queries() -> list[tuple[str, dict[str, Any]]]:
    return [
        ("perf-amber", {"terms": ["needle", "completed"], "services": ["api"], "tags": ["PROD"], "limit": 12}),
        ("perf-blue", {"terms": ["needle"], "levels": ["warn"], "tags": ["trace"], "limit": 12}),
        ("perf-紫", {"terms": ["needle"], "services": ["search"], "levels": ["error"], "limit": 12}),
        ("perf-amber", {"terms": ["needle"], "services": ["worker"], "limit": 12}),
        ("perf-blue", {"terms": ["needle", "operation"], "levels": ["info"], "limit": 12}),
        ("perf-紫", {"terms": ["needle"], "tags": ["prod", "zone-3"], "limit": 12}),
    ]


def run_perf_sample(
    Service: Any,
    data_path: Path,
) -> tuple[float, str, int]:
    service = Service(
        data_path,
        cache_enabled=True,
        audit_enabled=True,
        audit_batch_size=4,
        cache_capacity=64,
        recorder=None,
    )
    responses: list[dict[str, Any]] = []
    enabled = gc.isenabled()
    gc.collect()
    gc.disable()
    started = time.perf_counter()
    try:
        for index in range(PERF_REQUESTS):
            tenant, query = perf_queries()[index % 6]
            request = {
                "request_id": f"perf-{index:03d}",
                "tenant": tenant,
                "query": query,
            }
            responses.append(service.handle(request))
    finally:
        elapsed = time.perf_counter() - started
        if enabled:
            gc.enable()
        service.close()
    digest = hashlib.sha256()
    row_count = 0
    for response in responses:
        row_count += len(response["rows"])
        digest.update(json.dumps(response, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
    return elapsed, digest.hexdigest(), row_count


def check_performance(
    Candidate: Any, Original: Any, temporary: Path
) -> tuple[bool, str, dict[str, Any]]:
    records = perf_records()
    expected_rows = [oracle(records, tenant, query) for tenant, query in perf_queries()]
    if any(not rows for rows in expected_rows):
        raise RuntimeError("internal performance workload unexpectedly has an empty query")

    paths: dict[tuple[str, int], Path] = {}
    for implementation in ("original", "candidate"):
        for sample_index in range(SAMPLES):
            sample_dir = temporary / f"perf-{implementation}-{sample_index}"
            sample_dir.mkdir()
            path = sample_dir / "traces.jsonl"
            write_records(path, records)
            paths[(implementation, sample_index)] = path

    samples: dict[str, list[float]] = {"original": [], "candidate": []}
    digests: dict[str, list[str]] = {"original": [], "candidate": []}
    row_counts: dict[str, list[int]] = {"original": [], "candidate": []}
    services = {"original": Original, "candidate": Candidate}
    for sample_index in range(SAMPLES):
        order = ("original", "candidate") if sample_index % 2 == 0 else ("candidate", "original")
        for implementation in order:
            elapsed, digest, count = run_perf_sample(
                services[implementation], paths[(implementation, sample_index)]
            )
            samples[implementation].append(elapsed)
            digests[implementation].append(digest)
            row_counts[implementation].append(count)

    expected_total = sum(len(expected_rows[index % 6]) for index in range(PERF_REQUESTS))
    responses_match = (
        len(set(digests["original"] + digests["candidate"])) == 1
        and all(count == expected_total for counts in row_counts.values() for count in counts)
    )
    original_median = statistics.median(samples["original"])
    candidate_median = statistics.median(samples["candidate"])
    speedup = original_median / candidate_median if candidate_median > 0 else 0.0
    passed = responses_match and speedup >= MIN_SPEEDUP
    detail = (
        f"{speedup:.2f}x across {PERF_REQUESTS} requests "
        f"(original {original_median:.4f}s, candidate {candidate_median:.4f}s; "
        f"responses {'matched' if responses_match else 'differed'})"
    )
    metrics = {
        "originalMedianSeconds": round(original_median, 6),
        "candidateMedianSeconds": round(candidate_median, 6),
        "speedup": round(speedup, 3),
        "originalSamplesSeconds": [round(value, 6) for value in samples["original"]],
        "candidateSamplesSeconds": [round(value, 6) for value in samples["candidate"]],
        "performanceRequests": PERF_REQUESTS,
        "performanceRowsPerSample": expected_total,
        "responseDigest": digests["original"][0],
    }
    return passed, detail, metrics


def check_sealed(workspace: Path, frozen_workspace: Path, temporary: Path) -> tuple[bool, str]:
    problems: list[str] = []
    frozen_scripts = comparable_files(frozen_workspace / "scripts")
    candidate_scripts = comparable_files(workspace / "scripts")
    if not frozen_scripts:
        problems.append("frozen scripts directory is empty")
    elif candidate_scripts != frozen_scripts:
        changed = sorted(set(candidate_scripts) ^ set(frozen_scripts))
        changed.extend(
            name for name in set(candidate_scripts) & set(frozen_scripts)
            if candidate_scripts[name] != frozen_scripts[name]
        )
        problems.append("scripts differ: " + ", ".join(sorted(set(changed))))

    frozen_test = frozen_workspace / "tests/test_public.py"
    candidate_test = workspace / "tests/test_public.py"
    if not frozen_test.is_file() or not candidate_test.is_file() or sha256(frozen_test) != sha256(candidate_test):
        problems.append("tests/test_public.py differs or is missing")

    fresh = temporary / "fresh-default"
    fresh.mkdir()
    setup = frozen_workspace / "scripts/setup.py"
    try:
        completed = subprocess.run(
            [sys.executable, str(setup), "--output-dir", str(fresh / "data")], cwd=fresh, text=True,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=60,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        problems.append(f"fresh setup failed: {error}")
    else:
        if completed.returncode != 0:
            problems.append("fresh setup failed: " + completed.stdout[-1000:])
        else:
            generated = comparable_files(fresh / "data")
            candidate_data = comparable_files(workspace / "data")
            if not generated:
                problems.append("fresh setup generated no data")
            else:
                bad = [name for name, digest in generated.items() if candidate_data.get(name) != digest]
                if bad:
                    problems.append("generated inputs differ: " + ", ".join(bad))

    return not problems, "sealed harness and regenerated inputs match" if not problems else "; ".join(problems)


def finite_positive(value: Any) -> bool:
    return type(value) in (int, float) and math.isfinite(value) and value > 0


def validate_trace_or_compare(work: Path) -> str:
    candidates = sorted(
        path for path in work.rglob("*")
        if path.is_file() and ("trace" in path.name.casefold() or "compare" in path.name.casefold())
        and path.suffix in {".json", ".jsonl"}
    )
    errors: list[str] = []
    for path in candidates:
        try:
            if path.suffix == ".jsonl":
                values = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
                kinds = {item.get("event") for item in values if isinstance(item, dict)}
                valid_events = values and all(
                    isinstance(item, dict)
                    and isinstance(item.get("event"), str)
                    and type(item.get("time_ns")) is int
                    and item["time_ns"] > 0
                    for item in values
                )
                if valid_events and {"span", "cache", "scan", "commit"}.issubset(kinds):
                    return path.relative_to(work).as_posix()
                raise ValueError("trace JSONL lacks valid timed span/cache/scan/commit events")
            value = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(value, dict) or value.get("schemaVersion") != 1:
                raise ValueError("JSON artifact lacks schemaVersion 1")
            if value.get("command") == "trace":
                measurement = value.get("measurement")
                events_file = value.get("eventsFile")
                if not isinstance(measurement, dict) or not finite_positive(measurement.get("elapsedSeconds")):
                    raise ValueError("trace measurement is missing or invalid")
                if not isinstance(events_file, str) or Path(events_file).name != events_file:
                    raise ValueError("trace eventsFile is invalid")
                event_path = path.parent / events_file
                events = [json.loads(line) for line in event_path.read_text(encoding="utf-8").splitlines() if line.strip()]
                kinds = {item.get("event") for item in events if isinstance(item, dict)}
                if not events or not all(
                    isinstance(item, dict) and isinstance(item.get("event"), str)
                    and type(item.get("time_ns")) is int and item["time_ns"] > 0
                    for item in events
                ) or not {"span", "cache", "scan", "commit"}.issubset(kinds):
                    raise ValueError("referenced trace events are structurally invalid")
                return path.relative_to(work).as_posix()
            if value.get("command") == "compare":
                configurations = value.get("configurations")
                if not isinstance(configurations, dict) or not {"default", "auditOff", "cacheOff"}.issubset(configurations):
                    raise ValueError("compare configurations are incomplete")
                for name in ("default", "auditOff", "cacheOff"):
                    result = configurations[name]
                    if not isinstance(result, dict) or not finite_positive(result.get("elapsedSeconds")):
                        raise ValueError(f"compare {name} measurement is invalid")
                    if not isinstance(result.get("responseDigest"), str) or not isinstance(result.get("metrics"), dict):
                        raise ValueError(f"compare {name} digest or metrics are missing")
                return path.relative_to(work).as_posix()
            raise ValueError("expected a trace or compare command artifact")
        except (OSError, ValueError, json.JSONDecodeError) as error:
            errors.append(f"{path.name}: {error}")
    if errors:
        raise ValueError("; ".join(errors))
    raise ValueError("no trace or compare JSON evidence")


def check_evidence(workspace: Path) -> tuple[bool, str, dict[str, Any]]:
    work = workspace / "work"
    paths = {
        "profile": work / "profile.pstats",
        "profile_text": work / "profile.txt",
        "benchmark": work / "benchmark.json",
        "report": work / "report.md",
    }
    missing = [name for name, path in paths.items() if not path.is_file() or path.stat().st_size == 0]
    if missing:
        return False, "missing evidence: " + ", ".join(missing), {}
    try:
        pstats.Stats(str(paths["profile"]))
        if not paths["profile_text"].read_text(encoding="utf-8").strip():
            raise ValueError("profile.txt is empty")
        if not paths["report"].read_text(encoding="utf-8").strip():
            raise ValueError("report.md is empty")
        benchmark = json.loads(paths["benchmark"].read_text(encoding="utf-8"))
        if (
            not isinstance(benchmark, dict)
            or benchmark.get("schemaVersion") != 1
            or benchmark.get("command") != "benchmark"
        ):
            raise ValueError("benchmark schemaVersion must be 1")
        if benchmark.get("workload") != "mixed":
            raise ValueError("benchmark workload must be mixed")
        if type(benchmark.get("requestsPerSample")) is not int or benchmark["requestsPerSample"] < 72:
            raise ValueError("benchmark must include at least 72 requests per sample")
        if benchmark.get("workers") != 1:
            raise ValueError("benchmark samples must be serial")
        if benchmark.get("auditEnabled") is not True or benchmark.get("cacheEnabled") is not True:
            raise ValueError("benchmark must keep audit and cache enabled")
        samples = benchmark["samplesSeconds"]
        median = benchmark["medianSeconds"]
        if not isinstance(samples, list) or len(samples) < 3 or not all(finite_positive(item) for item in samples):
            raise ValueError("benchmark needs at least three positive finite samplesSeconds")
        if not finite_positive(median):
            raise ValueError("benchmark medianSeconds must be positive and finite")
        if not math.isclose(float(median), statistics.median(samples), rel_tol=0.05, abs_tol=1e-6):
            raise ValueError("benchmark medianSeconds does not match samplesSeconds")
        p50 = benchmark.get("p50RequestSeconds", benchmark.get("p50Seconds"))
        p95 = benchmark.get("p95RequestSeconds", benchmark.get("p95Seconds"))
        if not finite_positive(p50) or not finite_positive(p95) or p95 < p50:
            raise ValueError("benchmark needs valid p50/p95 request latency")
        digest = benchmark.get("responseDigest")
        if not isinstance(digest, str) or len(digest) < 16:
            raise ValueError("benchmark responseDigest is missing")
        digests = benchmark.get("responseDigests")
        if not isinstance(digests, list) or len(digests) < 3 or set(digests) != {digest}:
            raise ValueError("benchmark response digests must agree across samples")
        evidence_name = validate_trace_or_compare(work)
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError) as error:
        return False, f"invalid evidence: {error}", {}
    return True, f"profile, benchmark, report, and {evidence_name} are structurally valid", {
        "reportedMedianSeconds": float(median),
    }


def main() -> int:
    workspace = Path(os.environ["TASKGROUND_WORKSPACE"]).resolve()
    definition = Path(os.environ["TASKGROUND_DEFINITION"]).resolve()
    result_path = Path(os.environ["TASKGROUND_RESULT"]).resolve()
    checks: list[dict[str, Any]] = []
    metrics: dict[str, Any] = {
        "minimumSpeedup": MIN_SPEEDUP,
        "samplesPerImplementation": SAMPLES,
    }

    def add(name: str, passed: bool, detail: str) -> None:
        checks.append({"name": name, "status": "passed" if passed else "failed", "detail": detail})

    try:
        frozen_workspace = definition / "workspace"
        with tempfile.TemporaryDirectory(prefix="search-latency-verify-") as temporary_name:
            temporary = Path(temporary_name)
            sealed_ok, sealed_detail = check_sealed(workspace, frozen_workspace, temporary)
            add("immutable harness and generated inputs", sealed_ok, sealed_detail)

            Candidate = load_service(workspace, "candidate_searchapp")
            Original = load_service(frozen_workspace, "original_searchapp")

            tests = subprocess.run(
                [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-v"],
                cwd=workspace, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=45,
            )
            tests_ok = tests.returncode == 0
            add("workspace tests", tests_ok, tests.stdout[-4000:])

            try:
                correct, detail = check_behavior(Candidate, temporary)
            except Exception as error:
                correct, detail = False, f"{type(error).__name__}: {error}"
            add("held-out service correctness", correct, detail)

            if sealed_ok and tests_ok and correct:
                perf_ok, perf_detail, perf_metrics = check_performance(Candidate, Original, temporary)
                add("calibrated mixed-workload speedup", perf_ok, perf_detail)
                metrics.update(perf_metrics)
            else:
                add(
                    "calibrated mixed-workload speedup",
                    False,
                    "not run because integrity or correctness prerequisites failed",
                )

        evidence_ok, evidence_detail, evidence_metrics = check_evidence(workspace)
        add("profiling and benchmark evidence", evidence_ok, evidence_detail)
        metrics.update(evidence_metrics)
    except Exception as error:  # Always leave a machine-readable result.
        add("verifier execution", False, f"{type(error).__name__}: {error}")
        metrics["traceback"] = traceback.format_exc(limit=10)

    passed = bool(checks) and all(item["status"] == "passed" for item in checks)
    report = {
        "schemaVersion": SCHEMA_VERSION,
        "task": "search_latency",
        "status": "passed" if passed else "failed",
        "checks": checks,
        "metrics": metrics,
        "limitations": [
            "Automated behavior, integrity, evidence, and same-machine performance checks; investigation quality requires trace review. Definition/workspace separation is not an OS sandbox."
        ],
    }
    result_path.parent.mkdir(parents=True, exist_ok=True)
    result_path.write_text(json.dumps(report, indent=2, sort_keys=True, allow_nan=False) + "\n", encoding="utf-8")
    print(json.dumps(report, sort_keys=True, allow_nan=False))
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
