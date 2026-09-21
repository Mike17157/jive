#!/usr/bin/env python3
"""End-to-end maintainer smoke for the retry_audit fixture."""

from __future__ import annotations

import copy
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any


DEFINITION = Path(__file__).resolve().parents[1]
REFERENCE = DEFINITION / "maintainer/reference_findings.json"
REFERENCE_REPORT = DEFINITION / "maintainer/reference_report.md"


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
    wanted_exit = 0 if expected == "passed" else 1
    if completed.returncode != wanted_exit or report.get("status") != expected:
        print(completed.stdout)
        raise RuntimeError(f"expected {expected}/{wanted_exit}, got {report.get('status')}/{completed.returncode}")
    if report.get("task") != "retry_audit":
        raise RuntimeError("verifier returned wrong task id")
    return report


def fresh(root: Path, name: str) -> Path:
    workspace = root / name
    shutil.copytree(DEFINITION / "workspace", workspace)
    (workspace / "work").mkdir()
    return workspace


def install_reference(workspace: Path) -> dict[str, Any]:
    data = json.loads(REFERENCE.read_text(encoding="utf-8"))
    (workspace / "work/findings.json").write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    shutil.copy2(REFERENCE_REPORT, workspace / "work/report.md")
    return data


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="retry-audit-smoke-") as name:
        root = Path(name)

        empty = fresh(root, "empty")
        empty_report = run_verify(empty, root / "empty-result.json", "failed")

        reference = fresh(root, "reference")
        install_reference(reference)
        reference_report = run_verify(reference, root / "reference-result.json", "passed")
        if not all(reference_report.get("checks", {}).values()):
            raise RuntimeError("reference has a false verifier check")

        wrong = fresh(root, "wrong")
        wrong_data = install_reference(wrong)
        wrong_data["findings"][2]["classification"] = "migration_candidate"
        (wrong / "work/findings.json").write_text(json.dumps(wrong_data, indent=2) + "\n", encoding="utf-8")
        wrong_report = run_verify(wrong, root / "wrong-result.json", "failed")

        blanket = fresh(root, "blanket")
        blanket_data = install_reference(blanket)
        blanket_finding = copy.deepcopy(blanket_data["findings"][0])
        blanket_finding.update({
            "id": "everything-retry-is-actionable",
            "classification": "migration_candidate",
            "severity": "low",
            "confidence": "low",
            "title": "Healthy Batch queue retry is incorrectly reported actionable",
            "primaryLocation": {
                "path": "airflow/providers/amazon/aws/executors/batch/batch_executor.py",
                "line": 294,
            },
            "evidence": copy.deepcopy(blanket_data["rejectedCandidates"][0]["evidence"]),
        })
        blanket_data["findings"].append(blanket_finding)
        for site in blanket_data["coverage"]["candidateSites"]:
            if site["path"].endswith("batch_executor.py") and site["line"] == 294:
                site["disposition"] = "finding"
                site["recordId"] = blanket_finding["id"]
        (blanket / "work/findings.json").write_text(json.dumps(blanket_data, indent=2) + "\n", encoding="utf-8")
        blanket_report = run_verify(blanket, root / "blanket-result.json", "failed")

        malformed = fresh(root, "malformed")
        shutil.copy2(REFERENCE_REPORT, malformed / "work/report.md")
        (malformed / "work/findings.json").write_text('{"schemaVersion": 1, "findings": [}\n', encoding="utf-8")
        malformed_report = run_verify(malformed, root / "malformed-result.json", "failed")

        duplicate = fresh(root, "duplicate")
        shutil.copy2(REFERENCE_REPORT, duplicate / "work/report.md")
        duplicate_text = REFERENCE.read_text(encoding="utf-8").replace(
            '"schemaVersion": 1,', '"schemaVersion": 1,\n  "schemaVersion": 1,', 1
        )
        (duplicate / "work/findings.json").write_text(duplicate_text, encoding="utf-8")
        duplicate_report = run_verify(duplicate, root / "duplicate-result.json", "failed")

        tampered = fresh(root, "tampered")
        install_reference(tampered)
        target = tampered / "corpus/airflow/sensors/base.py"
        target.write_text(target.read_text(encoding="utf-8") + "\n# smoke tamper\n", encoding="utf-8")
        tampered_report = run_verify(tampered, root / "tampered-result.json", "failed")

        if wrong_report["checks"].get("required_behavioral_findings") is not False:
            raise RuntimeError("wrong classification did not fail behavioral recall")
        if blanket_report["checks"].get("known_negatives_not_actionable") is not False:
            raise RuntimeError("blanket report did not fail known-negative check")
        if malformed_report["checks"] != {"valid_artifacts": False}:
            raise RuntimeError("malformed JSON did not fail safely")
        if duplicate_report["checks"] != {"valid_artifacts": False}:
            raise RuntimeError("duplicate JSON keys did not fail safely")
        if tampered_report["checks"].get("corpus_integrity") is not False:
            raise RuntimeError("source modification did not fail corpus integrity")

        print(json.dumps({
            "empty": empty_report["status"],
            "reference": reference_report["status"],
            "wrong": wrong_report["status"],
            "blanket": blanket_report["status"],
            "malformed": malformed_report["status"],
            "duplicate": duplicate_report["status"],
            "tampered": tampered_report["status"],
            "referenceMetrics": reference_report["metrics"],
        }, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
