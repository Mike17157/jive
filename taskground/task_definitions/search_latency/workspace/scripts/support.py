"""Shared workload and measurement helpers for the diagnostic commands."""

from __future__ import annotations

import cProfile
import hashlib
import json
import math
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Callable, Iterable


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

BASE_TIMESTAMP = 1_720_000_000
WORKLOADS = ("warm", "mixed", "cold", "concurrent")


class EventRecorder:
    """A callable, thread-safe in-memory recorder."""

    def __init__(self) -> None:
        self._events: list[dict[str, Any]] = []
        self._lock = threading.Lock()

    def __call__(self, event: dict[str, Any]) -> None:
        with self._lock:
            self._events.append(dict(event))

    def snapshot(self) -> list[dict[str, Any]]:
        with self._lock:
            return [dict(event) for event in self._events]


def _mixed_query(index: int) -> tuple[str, dict[str, Any]]:
    combinations: tuple[tuple[str, dict[str, Any]], ...] = (
        ("alpha", {"terms": ["needle"], "services": ["api"], "limit": 12}),
        ("beta", {"terms": ["needle"], "services": ["worker"], "limit": 12}),
        ("gamma", {"terms": ["needle"], "services": ["search"], "limit": 12}),
        ("alpha", {"terms": ["needle"], "levels": ["warn"], "limit": 12}),
        ("beta", {"terms": ["needle"], "levels": ["error"], "limit": 12}),
        ("gamma", {"terms": ["needle"], "levels": ["info"], "limit": 12}),
    )
    tenant, query = combinations[index % len(combinations)]
    return tenant, dict(query)


def build_workload(name: str = "mixed", requests: int = 72) -> list[dict[str, Any]]:
    """Create deterministic request payloads for a named workload."""
    if name not in WORKLOADS:
        raise ValueError(f"unknown workload: {name}")
    if requests < 0:
        raise ValueError("requests must be nonnegative")
    payloads: list[dict[str, Any]] = []
    for index in range(requests):
        if name == "warm":
            tenant = "alpha"
            query: dict[str, Any] = {"terms": ["needle"], "limit": 12}
        elif name == "cold":
            tenant_index = index % 3
            tenant = ("alpha", "beta", "gamma")[tenant_index]
            query = {
                "terms": ["needle"],
                "min_timestamp": BASE_TIMESTAMP + tenant_index * 100_000 + index,
                "limit": 12,
            }
        else:
            tenant, query = _mixed_query(index)
        payloads.append({
            "request_id": f"{name}-{index:04d}",
            "tenant": tenant,
            "query": query,
        })
    return payloads


def response_digest(responses: Iterable[dict[str, Any]]) -> str:
    encoded = json.dumps(
        list(responses), ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def percentile(values: list[float], percentage: float) -> float:
    """Return a linearly interpolated percentile for a nonempty list."""
    if not values:
        return 0.0
    ordered = sorted(values)
    position = (len(ordered) - 1) * percentage
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def summarize_events(events: Iterable[dict[str, Any]]) -> dict[str, Any]:
    cache_hits = cache_misses = scans = scanned_records = 0
    commits = {"audit": 0, "traces": 0}
    spans: dict[str, list[int]] = {}
    event_count = 0
    for event in events:
        event_count += 1
        kind = event.get("event")
        if kind == "cache":
            if event.get("hit") is True:
                cache_hits += 1
            else:
                cache_misses += 1
        elif kind == "scan":
            scans += 1
            scanned_records += int(event.get("records", 0))
        elif kind == "commit":
            collection = event.get("collection")
            if collection in commits:
                commits[collection] += 1
        elif kind == "span":
            operation = str(event.get("operation", "unknown"))
            spans.setdefault(operation, []).append(int(event.get("duration_ns", 0)))
    span_summary = {
        operation: {
            "count": len(durations),
            "totalNs": sum(durations),
            "maxNs": max(durations, default=0),
        }
        for operation, durations in sorted(spans.items())
    }
    return {
        "events": event_count,
        "cacheHits": cache_hits,
        "cacheMisses": cache_misses,
        "scans": scans,
        "scannedRecords": scanned_records,
        "commits": commits,
        "spans": span_summary,
    }


def _call_timed(service: Any, payload: dict[str, Any]) -> tuple[dict[str, Any], float]:
    started = time.perf_counter()
    response = service.handle(payload)
    return response, time.perf_counter() - started


def execute_workload(
    service: Any,
    payloads: list[dict[str, Any]],
    workers: int = 1,
) -> tuple[list[dict[str, Any]], list[float], float]:
    """Execute prepared payloads against an already-loaded service."""
    if workers < 1:
        raise ValueError("workers must be positive")
    responses: list[dict[str, Any] | None] = [None] * len(payloads)
    latencies: list[float] = [0.0] * len(payloads)
    started = time.perf_counter()
    if workers > 1:
        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures = {
                executor.submit(_call_timed, service, payload): index
                for index, payload in enumerate(payloads)
            }
            for future in as_completed(futures):
                index = futures[future]
                responses[index], latencies[index] = future.result()
    else:
        for index, payload in enumerate(payloads):
            responses[index], latencies[index] = _call_timed(service, payload)
    elapsed = time.perf_counter() - started
    return [response for response in responses if response is not None], latencies, elapsed


def _call_profiled(
    service: Any,
    payload: dict[str, Any],
) -> tuple[dict[str, Any], float, cProfile.Profile]:
    """Profile one request in the worker thread that executes it."""
    profiler = cProfile.Profile()
    started = time.perf_counter()
    response = profiler.runcall(service.handle, payload)
    return response, time.perf_counter() - started, profiler


def execute_profiled_workers(
    service: Any,
    payloads: list[dict[str, Any]],
    workers: int,
) -> tuple[list[dict[str, Any]], list[float], float, list[cProfile.Profile]]:
    """Execute and independently profile every concurrent worker task.

    A ``cProfile.Profile`` instance is confined to the worker task that owns it.
    Callers can safely merge the returned profiles with :class:`pstats.Stats`.
    """
    if workers < 2:
        raise ValueError("profiled worker execution requires at least two workers")
    responses: list[dict[str, Any] | None] = [None] * len(payloads)
    latencies: list[float] = [0.0] * len(payloads)
    profilers: list[cProfile.Profile | None] = [None] * len(payloads)
    started = time.perf_counter()
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {
            executor.submit(_call_profiled, service, payload): index
            for index, payload in enumerate(payloads)
        }
        for future in as_completed(futures):
            index = futures[future]
            responses[index], latencies[index], profilers[index] = future.result()
    elapsed = time.perf_counter() - started
    return (
        [response for response in responses if response is not None],
        latencies,
        elapsed,
        [profiler for profiler in profilers if profiler is not None],
    )


def run_measurement(
    data_path: Path,
    workload: str = "mixed",
    requests: int = 72,
    workers: int | None = None,
    audit_enabled: bool = True,
    cache_enabled: bool = True,
    audit_batch_size: int = 4,
    recorder: Callable[[dict[str, Any]], None] | None = None,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Run one fresh-service measurement, excluding service construction."""
    from searchapp import SearchService

    if workers is None:
        workers = 4 if workload == "concurrent" else 1
    if workers < 1:
        raise ValueError("workers must be positive")
    payloads = build_workload(workload, requests)
    service = SearchService(
        data_path,
        cache_enabled=cache_enabled,
        audit_enabled=audit_enabled,
        audit_batch_size=audit_batch_size,
        cache_capacity=64,
        recorder=recorder,
    )
    try:
        complete_responses, latencies, elapsed = execute_workload(service, payloads, workers)
    finally:
        service.close()

    summary = {
        "workload": workload,
        "requests": requests,
        "workers": workers,
        "auditEnabled": audit_enabled,
        "cacheEnabled": cache_enabled,
        "auditBatchSize": audit_batch_size,
        "elapsedSeconds": round(elapsed, 9),
        "p50RequestSeconds": round(percentile(latencies, 0.50), 9),
        "p95RequestSeconds": round(percentile(latencies, 0.95), 9),
        "requestLatenciesSeconds": [round(value, 9) for value in latencies],
        "rows": sum(len(response["rows"]) for response in complete_responses),
        "responseDigest": response_digest(complete_responses),
    }
    return summary, complete_responses


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
