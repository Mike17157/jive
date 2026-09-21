#!/usr/bin/env python3
"""Prove that the seeded baseline fails and the reference optimization passes."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

DEFINITION = Path(__file__).resolve().parents[1]


def run(command: list[str], cwd: Path, *, env: dict[str, str] | None = None, expect: int = 0) -> subprocess.CompletedProcess[str]:
    completed = subprocess.run(command, cwd=cwd, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if completed.returncode != expect:
        print(completed.stdout)
        raise RuntimeError(f"expected exit {expect}, got {completed.returncode}: {' '.join(command)}")
    return completed


def verify(workspace: Path, result: Path, expected_status: str, expected_exit: int) -> dict[str, object]:
    env = dict(os.environ)
    env.update({
        "TASKGROUND_WORKSPACE": str(workspace),
        "TASKGROUND_DEFINITION": str(DEFINITION),
        "TASKGROUND_RESULT": str(result),
    })
    run([sys.executable, str(DEFINITION / "verifier/verify.py")], workspace, env=env, expect=expected_exit)
    report = json.loads(result.read_text(encoding="utf-8"))
    if report.get("status") != expected_status:
        raise RuntimeError(f"expected verifier status {expected_status}, got {report.get('status')}")
    return report


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="slow-trace-smoke-") as temporary_name:
        temporary = Path(temporary_name)
        workspace = temporary / "workspace"
        shutil.copytree(DEFINITION / "workspace", workspace, ignore=shutil.ignore_patterns("data", "work", "__pycache__"))
        run([sys.executable, "scripts/setup.py"], workspace)

        baseline = verify(workspace, temporary / "baseline.json", "failed", 1)
        failed_names = {item["name"] for item in baseline["checks"] if item["status"] == "failed"}
        if "calibrated speedup" not in failed_names:
            raise RuntimeError("baseline unexpectedly met the speed target")

        run(["patch", "-p1", "-i", str(DEFINITION / "maintainer/reference_fix.patch")], workspace)
        run([sys.executable, "scripts/profile.py"], workspace)
        run([sys.executable, "scripts/benchmark.py"], workspace)
        benchmark = json.loads((workspace / "work/benchmark.json").read_text(encoding="utf-8"))
        (workspace / "work/report.md").write_text(
            "# Optimization report\n\n"
            "The profile showed repeated JSON decoding and Unicode normalization in filtering and formatting. "
            "I changed the pipeline to decode each line once and pre-normalize query constants once.\n\n"
            "Correctness was checked with `python3 -m unittest discover -s tests -v` and the quick workload. "
            "Profiler evidence was generated with `python3 scripts/profile.py`; benchmark evidence was generated "
            "with `python3 scripts/benchmark.py`.\n\n"
            f"The optimized local benchmark median was {benchmark['medianSeconds']} seconds over three serial samples.\n",
            encoding="utf-8",
        )
        run([sys.executable, "-m", "unittest", "discover", "-s", "tests", "-v"], workspace)
        passed = verify(workspace, temporary / "reference.json", "passed", 0)
        print(json.dumps({
            "baselineStatus": baseline["status"],
            "referenceStatus": passed["status"],
            "referenceSpeedup": passed["metrics"]["speedup"],
            "originalMedianSeconds": passed["metrics"]["originalMedianSeconds"],
            "candidateMedianSeconds": passed["metrics"]["candidateMedianSeconds"],
        }, indent=2))


if __name__ == "__main__":
    main()
