#!/usr/bin/env python3
"""End-to-end maintainer smoke for the search_latency fixture."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

DEFINITION = Path(__file__).resolve().parents[1]


def run(
    command: list[str],
    cwd: Path,
    *,
    env: dict[str, str] | None = None,
    expect: int = 0,
    timeout: int = 180,
) -> subprocess.CompletedProcess[str]:
    completed = subprocess.run(
        command,
        cwd=cwd,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=timeout,
    )
    if completed.returncode != expect:
        print(completed.stdout)
        raise RuntimeError(
            f"expected exit {expect}, got {completed.returncode}: {' '.join(command)}"
        )
    return completed


def verify(
    workspace: Path,
    result: Path,
    expected_status: str,
    expected_exit: int,
) -> dict[str, Any]:
    env = dict(os.environ)
    env.update({
        "TASKGROUND_WORKSPACE": str(workspace),
        "TASKGROUND_DEFINITION": str(DEFINITION),
        "TASKGROUND_RESULT": str(result),
    })
    run(
        [sys.executable, str(DEFINITION / "verifier/verify.py")],
        workspace,
        env=env,
        expect=expected_exit,
        timeout=300,
    )
    report = json.loads(result.read_text(encoding="utf-8"))
    if report.get("status") != expected_status:
        raise RuntimeError(
            f"expected verifier status {expected_status}, got {report.get('status')}"
        )
    return report


def public_tests(workspace: Path) -> None:
    run(
        [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-v"],
        workspace,
        timeout=60,
    )


def generate_evidence(workspace: Path, label: str) -> None:
    # All timing commands run serially; artifacts expose construction separately.
    run(
        [sys.executable, "scripts/diagnose.py", "profile", "--workload", "mixed", "--requests", "72", "--output", "work"],
        workspace,
        timeout=180,
    )
    run(
        [sys.executable, "scripts/diagnose.py", "trace", "--workload", "mixed", "--requests", "72", "--output", "work"],
        workspace,
        timeout=180,
    )
    run(
        [sys.executable, "scripts/diagnose.py", "benchmark", "--workload", "mixed", "--requests", "72", "--output", "work"],
        workspace,
        timeout=240,
    )
    for workload in ("dashboard", "exploratory"):
        run([sys.executable, "scripts/diagnose.py", "benchmark", "--workload", workload,
             "--output", f"work/{workload}"], workspace, timeout=240)
    benchmark = json.loads((workspace / "work/benchmark.json").read_text(encoding="utf-8"))
    (workspace / "work/report.md").write_text(
        "# Search latency investigation\n\n"
        f"This {label} run retained a CPU profile, event trace, and three-sample serial mixed-workload benchmark. "
        "The trace evidence includes cache outcomes, storage scans, and audit commits, while the profile shows "
        "where request time was spent. The controlled workload keeps caching and auditing enabled.\n\n"
        "Correctness was checked with the public unit suite and the held-out verifier. The benchmark excludes "
        "service construction, which is reported separately along with lifecycle costs.\n\n"
        f"The observed local benchmark median was {benchmark.get('medianSeconds')} seconds.\n",
        encoding="utf-8",
    )


def failed_check_names(report: dict[str, Any]) -> set[str]:
    return {
        item.get("name", "")
        for item in report.get("checks", [])
        if item.get("status") == "failed"
    }


def append_negative_wrapper(workspace: Path, source: str) -> None:
    init = workspace / "searchapp/__init__.py"
    init.write_text(init.read_text(encoding="utf-8") + source, encoding="utf-8")


def make_audit_disabled(workspace: Path) -> None:
    append_negative_wrapper(
        workspace,
        """

# Maintainer smoke mutation: silently disable the required audit path.
_SmokeRealSearchService = SearchService
class SearchService(_SmokeRealSearchService):
    def __init__(self, *args, **kwargs):
        kwargs["audit_enabled"] = False
        super().__init__(*args, **kwargs)
""",
    )


def make_ingest_stale(workspace: Path) -> None:
    catalog = workspace / "searchapp/catalog.py"
    source = catalog.read_text(encoding="utf-8")
    old = "return self.store.tenant_revision(tenant)"
    if source.count(old) != 1:
        raise RuntimeError("reference catalog no longer has the expected tenant revision token")
    catalog.write_text(source.replace(old, "return 0"), encoding="utf-8")


def assert_correctness_negative(report: dict[str, Any], label: str) -> None:
    failures = failed_check_names(report)
    if "held-out service correctness" not in failures:
        raise RuntimeError(f"{label} mutation was not rejected by held-out correctness: {sorted(failures)}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, help="retain full verifier reports as calibration evidence")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="search-latency-smoke-") as temporary_name:
        temporary = Path(temporary_name)
        workspace = temporary / "workspace"
        shutil.copytree(
            DEFINITION / "workspace",
            workspace,
            ignore=shutil.ignore_patterns("data", "work", "__pycache__", "*.pyc"),
        )
        run([sys.executable, "scripts/setup.py"], workspace, timeout=90)
        public_tests(workspace)
        generate_evidence(workspace, "seeded baseline")

        print("checking baseline", flush=True)
        baseline = verify(workspace, temporary / "baseline.json", "failed", 1)
        baseline_failures = failed_check_names(baseline)
        performance_checks = {f"performance: {name}" for name in ("dashboard", "exploratory", "mixed")}
        if baseline_failures != performance_checks:
            raise RuntimeError(f"baseline should fail only all performance gates: {sorted(baseline_failures)}")

        partials = {}
        for variant, required_failure, required_pass in (
            ("invalidation_only", "exploratory", "dashboard"),
            ("selective_only", "dashboard", "exploratory"),
        ):
            print(f"checking {variant}", flush=True)
            partial = temporary / variant
            shutil.copytree(workspace, partial, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
            run(["patch", "-p1", "-i", str(DEFINITION / f"maintainer/{variant}.patch")], partial)
            generate_evidence(partial, variant)
            report = verify(partial, temporary / f"{variant}.json", "failed", 1)
            failures = failed_check_names(report)
            if f"performance: {required_failure}" not in failures or failures - performance_checks:
                raise RuntimeError(f"{variant} rejected for wrong reasons: {sorted(failures)}")
            if f"performance: {required_pass}" in failures:
                raise RuntimeError(f"{variant} should pass its isolated workload: {sorted(failures)}")
            partials[variant] = report["metrics"]["workloads"]

        run(
            ["patch", "-p1", "-i", str(DEFINITION / "maintainer/reference_fix.patch")],
            workspace,
            timeout=30,
        )
        print("checking full reference and correctness mutations", flush=True)
        public_tests(workspace)
        generate_evidence(workspace, "reference-fixed")
        fixed = verify(workspace, temporary / "fixed.json", "passed", 0)

        audit_negative = temporary / "audit-disabled"
        shutil.copytree(workspace, audit_negative, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        make_audit_disabled(audit_negative)
        audit_report = verify(audit_negative, temporary / "audit-disabled.json", "failed", 1)
        assert_correctness_negative(audit_report, "audit-disabled")

        stale_negative = temporary / "stale-ingest"
        shutil.copytree(workspace, stale_negative, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        make_ingest_stale(stale_negative)
        stale_report = verify(stale_negative, temporary / "stale-ingest.json", "failed", 1)
        assert_correctness_negative(stale_report, "stale-ingest")

        index_negatives = {}
        for label, old, new in (
            ("timestamp-order", "positions = sorted(position for _, position in entries[lower:upper])",
             "positions = [position for _, position in entries[lower:upper]]"),
            ("stale-index", "self._time_index[tenant] = updated_index", "pass  # do not publish index changes"),
        ):
            negative = temporary / label
            shutil.copytree(workspace, negative, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
            storage = negative / "searchapp/storage.py"
            source = storage.read_text()
            if source.count(old) != 1:
                raise RuntimeError(f"reference changed: cannot apply {label} mutation")
            storage.write_text(source.replace(old, new))
            report = verify(negative, temporary / f"{label}.json", "failed", 1)
            assert_correctness_negative(report, label)
            index_negatives[label] = report["status"]

        if args.output:
            args.output.mkdir(parents=True, exist_ok=True)
            for path in temporary.glob("*.json"):
                shutil.copy2(path, args.output / path.name)

        print(json.dumps({
            "baselineStatus": baseline["status"],
            "baselineFailures": sorted(baseline_failures),
            "referenceStatus": fixed["status"],
            "referenceSpeedups": {k: v["speedup"] for k, v in fixed["metrics"]["workloads"].items()},
            "partialSpeedups": {name: {k: v["speedup"] for k, v in workloads.items()} for name, workloads in partials.items()},
            "indexNegativeStatuses": index_negatives,
            "auditNegativeStatus": audit_report["status"],
            "staleIngestNegativeStatus": stale_report["status"],
        }, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
