#!/usr/bin/env python3
"""Exercise positive and adversarial verifier cases for async_blocking_audit."""

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


def run_verify(workspace: Path, result: Path, expected: str) -> dict[str, Any]:
    env = dict(os.environ)
    env.update({
        "TASKGROUND_WORKSPACE": str(workspace),
        "TASKGROUND_DEFINITION": str(DEFINITION),
        "TASKGROUND_RESULT": str(result),
    })
    completed = subprocess.run(
        [sys.executable, str(DEFINITION / "verifier/verify.py")],
        cwd=workspace,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=30,
    )
    report = json.loads(result.read_text(encoding="utf-8"))
    expected_exit = 0 if expected == "passed" else 1
    if completed.returncode != expected_exit or report.get("status") != expected:
        print(completed.stdout)
        raise RuntimeError(
            f"expected {expected}/{expected_exit}, got {report.get('status')}/{completed.returncode}"
        )
    return report


def fresh(root: Path, name: str) -> Path:
    workspace = root / name
    shutil.copytree(DEFINITION / "workspace", workspace)
    (workspace / "work").mkdir()
    return workspace


def install_reference(workspace: Path) -> dict[str, Any]:
    findings = json.loads(
        (DEFINITION / "maintainer/reference_findings.json").read_text(encoding="utf-8")
    )
    (workspace / "work/findings.json").write_text(
        json.dumps(findings, indent=2) + "\n", encoding="utf-8"
    )
    shutil.copy2(
        DEFINITION / "maintainer/reference_report.md", workspace / "work/report.md"
    )
    return findings


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="async-blocking-audit-smoke-") as name:
        root = Path(name)

        reference = fresh(root, "reference")
        install_reference(reference)
        passed = run_verify(reference, root / "reference.json", "passed")

        empty = fresh(root, "empty")
        run_verify(empty, root / "empty.json", "failed")

        blanket = fresh(root, "blanket")
        blanket_answer = install_reference(blanket)
        for finding in blanket_answer["findings"]:
            finding["classification"] = "confirmed_blocking"
        (blanket / "work/findings.json").write_text(
            json.dumps(blanket_answer) + "\n", encoding="utf-8"
        )
        run_verify(blanket, root / "blanket.json", "failed")

        wrong = fresh(root, "wrong")
        wrong_answer = install_reference(wrong)
        wrong_answer["findings"][0]["location"]["line"] = 50
        wrong_answer["findings"][0]["evidence"][0].update(
            {"startLine": 50, "endLine": 50}
        )
        (wrong / "work/findings.json").write_text(
            json.dumps(wrong_answer) + "\n", encoding="utf-8"
        )
        run_verify(wrong, root / "wrong.json", "failed")

        malformed = fresh(root, "malformed")
        (malformed / "work/findings.json").write_text(
            '{"schemaVersion": [], "scope": "wide", "findings": {}}\n',
            encoding="utf-8",
        )
        (malformed / "work/report.md").write_text("placeholder\n", encoding="utf-8")
        run_verify(malformed, root / "malformed.json", "failed")

        tampered = fresh(root, "tampered")
        install_reference(tampered)
        source = tampered / "source/homeassistant/components/media_source/local_source.py"
        source.write_text(source.read_text(encoding="utf-8") + "\n# changed\n", encoding="utf-8")
        run_verify(tampered, root / "tampered.json", "failed")

        print(json.dumps({
            "reference": passed["status"],
            "negativeCases": ["empty", "blanket", "wrong", "malformed", "tampered"],
        }, indent=2))


if __name__ == "__main__":
    main()
