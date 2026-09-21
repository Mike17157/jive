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
WORKLOADS = ("dashboard", "exploratory", "mixed", "warm", "concurrent")


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


def build_workload(name: str = "mixed", requests: int = 72, *,
                   query_reuse: int = 6, window_width: int = 64) -> list[dict[str, Any]]:
    """Prepare recurring queries and distinct, bounded exploratory windows.

    query_reuse is the number of recurring keys (larger means less reuse).
    Window positions are independent of width, permitting selectivity sweeps.
    """
    if name not in WORKLOADS or requests < 0 or query_reuse < 1 or window_width < 1:
        raise ValueError("invalid workload, request count, recurring key count, or window width")
    payloads = []
    for index in range(requests):
        group = "exploratory" if name == "exploratory" or (name == "mixed" and index % 2) else "dashboard"
        sequence = index // 2 if name == "mixed" else index
        if group == "exploratory":
            tenant_index = sequence % 3
            tenant = ("alpha", "beta", "gamma")[tenant_index]
            lower = BASE_TIMESTAMP + tenant_index * 100_000 + 200 + sequence * 37
            query = {"min_timestamp": lower, "max_timestamp": lower + window_width - 1,
                     "tags": ["prod"], "limit": 12}
        elif name == "warm":
            tenant, query = "alpha", {"terms": ["needle"], "limit": 12}
        else:
            key = sequence % query_reuse
            tenant, query = _mixed_query(key)
            query["limit"] = 12 + key // 6
        payloads.append({"request_id": f"{name}-{group}-{index:04d}",
                         "tenant": tenant, "query": query})
    return payloads


def ingest_before(service: Any, index: int, every: int, batch_size: int) -> None:
    """Deterministic out-of-order arrivals at barriers between request batches."""
    if not every or not index or index % every:
        return
    tenant_index = (index // every) % 3
    tenant = ("alpha", "beta", "gamma")[tenant_index]
    records = [{"id": f"arrival-{index}-{offset}",
                "timestamp": BASE_TIMESTAMP + tenant_index * 100_000 + 200 + (index * 37 + offset * 13) % 3000,
                "service": "api", "level": "warn", "message": "needle arrival café",
                "tags": ["prod", "zone-0"]} for offset in range(batch_size)]
    service.ingest(tenant, records)


def group_summaries(payloads: list[dict[str, Any]], latencies: list[float],
                    events: Iterable[dict[str, Any]] = ()) -> dict[str, Any]:
    events = list(events)
    result = {}
    for group in ("dashboard", "exploratory"):
        indexes = [i for i, payload in enumerate(payloads) if f"-{group}-" in payload["request_id"]]
        if not indexes:
            continue
        identities = {payloads[i]["request_id"] for i in indexes}
        values = [latencies[i] for i in indexes]
        result[group] = {"requests": len(values), "totalRequestSeconds": sum(values),
                         "p50RequestSeconds": percentile(values, .5),
                         "p95RequestSeconds": percentile(values, .95),
                         "metrics": summarize_events(e for e in events if e.get("request_id") in identities) if events else None}
    return result


def phase_summaries(payloads: list[dict[str, Any]], latencies: list[float],
                    events: Iterable[dict[str, Any]], ingest_every: int) -> list[dict[str, Any]]:
    events = list(events)
    stride = ingest_every or max(1, len(payloads))
    return [{"phase": start // stride, "startRequest": start,
             "afterIngestion": start > 0 and bool(ingest_every),
             "groups": group_summaries(payloads[start:start + stride], latencies[start:start + stride], events)}
            for start in range(0, len(payloads), stride)]


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
    ingest_every: int = 0,
    ingest_batch_size: int = 24,
) -> tuple[list[dict[str, Any]], list[float], float]:
    """Execute prepared payloads against an already-loaded service."""
    if workers < 1:
        raise ValueError("workers must be positive")
    responses: list[dict[str, Any] | None] = [None] * len(payloads)
    latencies: list[float] = [0.0] * len(payloads)
    started = time.perf_counter()
    # Concurrency happens within each batch; ingestion is an explicit barrier.
    stride = ingest_every or max(1, len(payloads))
    for start in range(0, len(payloads), stride):
        ingest_before(service, start, ingest_every, ingest_batch_size)
        batch = payloads[start:start + stride]
        if workers > 1:
            with ThreadPoolExecutor(max_workers=workers) as executor:
                futures = {executor.submit(_call_timed, service, payload): start + offset
                           for offset, payload in enumerate(batch)}
                for future in as_completed(futures):
                    index = futures[future]
                    responses[index], latencies[index] = future.result()
        else:
            for offset, payload in enumerate(batch):
                responses[start + offset], latencies[start + offset] = _call_timed(service, payload)
    service.flush_audit()
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


def _profiled_batch(
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


def execute_profiled_workers(service: Any, payloads: list[dict[str, Any]], workers: int,
                             ingest_every: int = 0, ingest_batch_size: int = 24):
    responses, latencies, profilers = [], [], []
    started = time.perf_counter()
    stride = ingest_every or max(1, len(payloads))
    for start in range(0, len(payloads), stride):
        ingest_before(service, start, ingest_every, ingest_batch_size)
        rows, times, _, profiles = _profiled_batch(service, payloads[start:start + stride], workers)
        responses.extend(rows)
        latencies.extend(times)
        profilers.extend(profiles)
    service.flush_audit()
    return responses, latencies, time.perf_counter() - started, profilers


def run_measurement(
    data_path: Path,
    workload: str = "mixed",
    requests: int = 72,
    workers: int | None = None,
    audit_enabled: bool = True,
    cache_enabled: bool = True,
    audit_batch_size: int = 4,
    recorder: Callable[[dict[str, Any]], None] | None = None,
    query_reuse: int = 6,
    window_width: int = 64,
    ingest_every: int | None = None,
    ingest_batch_size: int = 24,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Run one fresh-service measurement, excluding service construction."""
    from searchapp import SearchService

    if workers is None:
        workers = 4 if workload == "concurrent" else 1
    if workers < 1:
        raise ValueError("workers must be positive")
    ingest_every = (24 if workload == "mixed" else 0) if ingest_every is None else ingest_every
    payloads = build_workload(workload, requests, query_reuse=query_reuse, window_width=window_width)
    load_started = time.perf_counter()
    service = SearchService(
        data_path,
        cache_enabled=cache_enabled,
        audit_enabled=audit_enabled,
        audit_batch_size=audit_batch_size,
        cache_capacity=64,
        recorder=recorder,
    )
    load_seconds = time.perf_counter() - load_started
    try:
        complete_responses, latencies, elapsed = execute_workload(service, payloads, workers, ingest_every, ingest_batch_size)
    finally:
        service.close()

    summary = {
        "workload": workload,
        "queryReuse": query_reuse, "windowWidth": window_width,
        "ingestEvery": ingest_every, "ingestBatchSize": ingest_batch_size,
        "loadSeconds": load_seconds, "lifecycleSeconds": load_seconds + elapsed,
        "groups": group_summaries(payloads, latencies, recorder.snapshot() if isinstance(recorder, EventRecorder) else ()),
        "phases": phase_summaries(payloads, latencies, recorder.snapshot() if isinstance(recorder, EventRecorder) else (), ingest_every),
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
