#!/usr/bin/env python3
"""End-to-end maintainer smoke for the search_latency fixture."""

from __future__ import annotations

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
    # These commands intentionally run serially. Benchmark fixture load is
    # outside the scripts' measurements by contract.
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
    benchmark = json.loads((workspace / "work/benchmark.json").read_text(encoding="utf-8"))
    (workspace / "work/report.md").write_text(
        "# Search latency investigation\n\n"
        f"This {label} run retained a CPU profile, event trace, and three-sample serial mixed-workload benchmark. "
        "The trace evidence includes cache outcomes, storage scans, and audit commits, while the profile shows "
        "where request time was spent. The controlled workload keeps caching and auditing enabled.\n\n"
        "Correctness was checked with the public unit suite and the held-out verifier. The benchmark excludes "
        "service construction and fixture loading.\n\n"
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

        baseline = verify(workspace, temporary / "baseline.json", "failed", 1)
        baseline_failures = failed_check_names(baseline)
        if "calibrated mixed-workload speedup" not in baseline_failures:
            raise RuntimeError(
                "seeded baseline unexpectedly met the performance target: "
                + repr(sorted(baseline_failures))
            )
        forbidden = baseline_failures - {"calibrated mixed-workload speedup"}
        if forbidden:
            raise RuntimeError(
                "seeded baseline should pass correctness, integrity, and evidence checks; also failed: "
                + repr(sorted(forbidden))
            )

        run(
            ["patch", "-p1", "-i", str(DEFINITION / "maintainer/reference_fix.patch")],
            workspace,
            timeout=30,
        )
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

        print(json.dumps({
            "baselineStatus": baseline["status"],
            "baselineFailures": sorted(baseline_failures),
            "referenceStatus": fixed["status"],
            "referenceSpeedup": fixed["metrics"]["speedup"],
            "auditNegativeStatus": audit_report["status"],
            "staleIngestNegativeStatus": stale_report["status"],
        }, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
