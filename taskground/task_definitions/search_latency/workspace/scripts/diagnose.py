#!/usr/bin/env python3
"""Collect repeatable performance diagnostics for the in-process search service."""

from __future__ import annotations

import argparse
import cProfile
import io
import json
import pstats
import statistics
import sys
from pathlib import Path
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
ROOT = SCRIPT_DIR.parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from support import (  # noqa: E402
    EventRecorder,
    group_summaries,
    phase_summaries,
    WORKLOADS,
    build_workload,
    execute_profiled_workers,
    execute_workload,
    percentile,
    response_digest,
    run_measurement,
    summarize_events,
    write_json,
)


def on_off(value: str) -> bool:
    if value == "on":
        return True
    if value == "off":
        return False
    raise argparse.ArgumentTypeError("expected 'on' or 'off'")


def positive_integer(value: str) -> int:
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("expected a positive integer")
    return parsed


def add_common_options(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--workload", choices=WORKLOADS, default="mixed")
    parser.add_argument("--requests", type=positive_integer, default=72)
    parser.add_argument("--workers", type=int, default=None)
    parser.add_argument("--audit", type=on_off, default=True, metavar="on|off")
    parser.add_argument("--cache", type=on_off, default=True, metavar="on|off")
    parser.add_argument("--audit-batch-size", type=int, default=4)
    parser.add_argument("--output", type=Path, default=ROOT / "work")
    parser.add_argument("--data", type=Path, default=ROOT / "data" / "traces.jsonl")
    parser.add_argument("--query-reuse", type=positive_integer, default=6, help="number of recurring dashboard keys")
    parser.add_argument("--window-width", type=positive_integer, default=64, help="inclusive exploratory window width")
    parser.add_argument("--ingest-every", type=int, default=None, help="request interval; 0 disables (default: mixed 24, others 0)")
    parser.add_argument("--ingest-batch-size", type=positive_integer, default=24)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    for command in ("overview", "profile", "trace", "compare", "benchmark"):
        child = subparsers.add_parser(command)
        add_common_options(child)
        if command == "compare":
            child.add_argument("--vary", required=True, choices=("audit", "cache", "audit-batch-size", "query-reuse", "window-width", "ingest-every", "ingest-batch-size"))
            child.add_argument("--values", nargs="+", required=True, help="two or more values for the chosen variable")
    return parser.parse_args()


def resolved_workers(args: argparse.Namespace, workload: str | None = None) -> int:
    selected = workload or args.workload
    return args.workers if args.workers is not None else (4 if selected == "concurrent" else 1)


def validate_args(args: argparse.Namespace) -> None:
    if args.requests < 1:
        raise SystemExit("--requests must be positive")
    if args.workers is not None and args.workers < 1:
        raise SystemExit("--workers must be positive")
    if args.audit_batch_size < 1:
        raise SystemExit("--audit-batch-size must be positive")
    if args.ingest_every is not None and args.ingest_every < 0:
        raise SystemExit("--ingest-every must be nonnegative")
    if not args.data.is_file():
        raise SystemExit(f"data file not found: {args.data}")
    args.output.mkdir(parents=True, exist_ok=True)


def workload_options(args: argparse.Namespace) -> dict[str, Any]:
    return {key: getattr(args, key) for key in ("query_reuse", "window_width", "ingest_every", "ingest_batch_size")}


def ingestion_interval(args: argparse.Namespace) -> int:
    return (24 if args.workload == "mixed" else 0) if args.ingest_every is None else args.ingest_every


def measured(args: argparse.Namespace, workload: str | None = None) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    selected = workload or args.workload
    recorder = EventRecorder()
    summary, _ = run_measurement(
        args.data,
        workload=selected,
        requests=args.requests,
        workers=resolved_workers(args, selected),
        audit_enabled=args.audit,
        cache_enabled=args.cache,
        audit_batch_size=args.audit_batch_size,
        recorder=recorder,
        **workload_options(args),
    )
    events = recorder.snapshot()
    summary["metrics"] = summarize_events(events)
    return summary, events


def overview(args: argparse.Namespace) -> dict[str, Any]:
    results: dict[str, Any] = {}
    for workload in WORKLOADS:
        result, _ = measured(args, workload)
        results[workload] = result
    artifact = {"schemaVersion": 1, "command": "overview", "workloads": results}
    write_json(args.output / "overview.json", artifact)
    return {"artifact": str(args.output / "overview.json"), "workloads": {
        name: round(result["elapsedSeconds"], 6) for name, result in results.items()
    }}


def trace(args: argparse.Namespace) -> dict[str, Any]:
    result, events = measured(args)
    events_path = args.output / "trace.jsonl"
    with events_path.open("w", encoding="utf-8", newline="\n") as handle:
        for event in events:
            handle.write(json.dumps(event, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n")
    artifact = {
        "schemaVersion": 1,
        "command": "trace",
        "measurement": result,
        "eventsFile": events_path.name,
    }
    write_json(args.output / "trace.json", artifact)
    return {
        "artifact": str(args.output / "trace.json"),
        "events": len(events),
        "responseDigest": result["responseDigest"],
    }


def compare(args: argparse.Namespace) -> dict[str, Any]:
    if len(args.values) < 2 or len(set(args.values)) != len(args.values):
        raise ValueError("compare requires at least two distinct values")
    results = {}
    field = args.vary.replace("-", "_")
    for value in args.values:
        selected = argparse.Namespace(**vars(args))
        parsed = on_off(value) if field in ("audit", "cache") else int(value)
        if field not in ("audit", "cache") and (parsed < 0 or (parsed == 0 and field != "ingest_every")):
            raise ValueError("comparison values must be positive (ingest-every also accepts 0)")
        setattr(selected, field, parsed)
        result, _ = measured(selected)
        results[value] = result
    artifact = {"schemaVersion": 1, "command": "compare", "variable": args.vary,
                "configurations": results,
                "sameResponseDigest": len({r["responseDigest"] for r in results.values()}) == 1}
    write_json(args.output / "compare.json", artifact)
    return {"artifact": str(args.output / "compare.json"), "variable": args.vary,
            "elapsedSeconds": {name: value["elapsedSeconds"] for name, value in results.items()},
            "sameResponseDigest": artifact["sameResponseDigest"]}


def benchmark(args: argparse.Namespace) -> dict[str, Any]:
    sample_results: list[dict[str, Any]] = []
    for _ in range(3):
        summary, _ = run_measurement(
            args.data,
            workload=args.workload,
            requests=args.requests,
            workers=resolved_workers(args),
            audit_enabled=args.audit,
            cache_enabled=args.cache,
            audit_batch_size=args.audit_batch_size,
            recorder=None,
            **workload_options(args),
        )
        sample_results.append(summary)
    samples = [sample["elapsedSeconds"] for sample in sample_results]
    request_latencies = [
        latency
        for sample in sample_results
        for latency in sample["requestLatenciesSeconds"]
    ]
    digests = [sample["responseDigest"] for sample in sample_results]
    if len(set(digests)) != 1:
        joined = ", ".join(f"sample {index + 1}={digest}" for index, digest in enumerate(digests))
        raise RuntimeError(f"benchmark response digests differ across samples: {joined}")
    artifact = {
        "schemaVersion": 1,
        "command": "benchmark",
        "workload": args.workload,
        "requestsPerSample": args.requests,
        "parameters": {**workload_options(args), "ingest_every": ingestion_interval(args)},
        "loadSamplesSeconds": [s["loadSeconds"] for s in sample_results],
        "lifecycleSamplesSeconds": [s["lifecycleSeconds"] for s in sample_results],
        "groupSamples": [s["groups"] for s in sample_results],
        "phaseSamples": [s["phases"] for s in sample_results],
        "workers": resolved_workers(args),
        "auditEnabled": args.audit,
        "cacheEnabled": args.cache,
        "auditBatchSize": args.audit_batch_size,
        "samplesSeconds": samples,
        "medianSeconds": round(statistics.median(samples), 9),
        "p50RequestSeconds": round(percentile(request_latencies, 0.50), 9),
        "p95RequestSeconds": round(percentile(request_latencies, 0.95), 9),
        "responseDigest": digests[0],
        "responseDigests": digests,
    }
    write_json(args.output / "benchmark.json", artifact)
    return {
        "artifact": str(args.output / "benchmark.json"),
        "medianSeconds": artifact["medianSeconds"],
        "responseDigest": artifact["responseDigest"],
    }


def profile(args: argparse.Namespace) -> dict[str, Any]:
    from searchapp import SearchService

    recorder = EventRecorder()
    service = SearchService(
        args.data,
        cache_enabled=args.cache,
        audit_enabled=args.audit,
        audit_batch_size=args.audit_batch_size,
        cache_capacity=64,
        recorder=recorder,
    )
    payloads = build_workload(args.workload, args.requests, query_reuse=args.query_reuse, window_width=args.window_width)
    workers = resolved_workers(args)
    try:
        if workers == 1:
            profiler = cProfile.Profile()
            responses, latencies, elapsed = profiler.runcall(
                execute_workload, service, payloads, workers, ingestion_interval(args), args.ingest_batch_size
            )
            profilers = [profiler]
            profile_mode = "serial-main-thread"
            timing_explanation = (
                "One profile covers serial workload orchestration and request execution; "
                "profile function times use the same single-thread timeline."
            )
        else:
            responses, latencies, elapsed, profilers = execute_profiled_workers(
                service, payloads, workers, ingestion_interval(args), args.ingest_batch_size
            )
            profile_mode = "per-request-worker-aggregate"
            timing_explanation = (
                "Each request task is profiled in its executing worker thread. Function "
                "times in profile.pstats are summed across task profiles and can exceed "
                "wall elapsed time when worker execution overlaps. Ingestion at batch barriers is included "
                "in wall time and telemetry but not worker CPU profiles."
            )
    finally:
        service.close()
    stats_path = args.output / "profile.pstats"
    stats = pstats.Stats(profilers[0])
    for worker_profiler in profilers[1:]:
        stats.add(worker_profiler)
    stats.dump_stats(stats_path)
    aggregate_internal_seconds = stats.total_tt
    report = io.StringIO()
    pstats.Stats(str(stats_path), stream=report).strip_dirs().sort_stats("cumulative").print_stats(40)
    report.write(f"\nprofile mode: {profile_mode}\n")
    report.write(f"profile sessions merged: {len(profilers)}\n")
    report.write(f"timing interpretation: {timing_explanation}\n")
    report.write(f"\nrequests: {len(responses)}\n")
    report.write(f"rows: {sum(len(response['rows']) for response in responses)}\n")
    report.write(f"response digest: {response_digest(responses)}\n")
    report_path = args.output / "profile.txt"
    report_path.write_text(report.getvalue(), encoding="utf-8")
    events = recorder.snapshot()
    artifact = {
        "schemaVersion": 1,
        "command": "profile",
        "workload": args.workload,
        "requests": args.requests,
        "parameters": {**workload_options(args), "ingest_every": ingestion_interval(args)},
        "groups": group_summaries(payloads, latencies, events),
        "phases": phase_summaries(payloads, latencies, events, ingestion_interval(args)),
        "workers": workers,
        "auditEnabled": args.audit,
        "cacheEnabled": args.cache,
        "auditBatchSize": args.audit_batch_size,
        "elapsedSeconds": round(elapsed, 9),
        "p50RequestSeconds": round(percentile(latencies, 0.50), 9),
        "p95RequestSeconds": round(percentile(latencies, 0.95), 9),
        "responseDigest": response_digest(responses),
        "metrics": summarize_events(events),
        "profileMode": profile_mode,
        "profileSessionsMerged": len(profilers),
        "aggregateProfileSeconds": round(aggregate_internal_seconds, 9),
        "profileTimingInterpretation": timing_explanation,
        "statsFile": stats_path.name,
        "textFile": report_path.name,
    }
    write_json(args.output / "profile.json", artifact)
    return {
        "artifact": str(args.output / "profile.json"),
        "stats": str(stats_path),
        "responseDigest": artifact["responseDigest"],
    }


COMMANDS = {
    "overview": overview,
    "profile": profile,
    "trace": trace,
    "compare": compare,
    "benchmark": benchmark,
}


def main() -> None:
    args = parse_args()
    validate_args(args)
    result = COMMANDS[args.command](args)
    print(json.dumps({"command": args.command, **result}, sort_keys=True, separators=(",", ":")))


if __name__ == "__main__":
    main()
