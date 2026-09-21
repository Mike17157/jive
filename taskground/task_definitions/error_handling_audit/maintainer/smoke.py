#!/usr/bin/env python3
"""Maintainer-only smoke checks for the error_handling_audit verifier."""

from __future__ import annotations

import copy
import importlib.util
import json
import shutil
import sys
import tempfile
from pathlib import Path

sys.dont_write_bytecode = True

DEFINITION = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "error_handling_audit_verifier", DEFINITION / "verifier/verify.py"
)
assert SPEC and SPEC.loader
VERIFIER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VERIFIER)


def fresh_workspace(root: Path, name: str) -> Path:
    workspace = root / name
    shutil.copytree(DEFINITION / "workspace", workspace)
    return workspace


def run(workspace: Path, root: Path, name: str) -> dict:
    return VERIFIER.verify(workspace, DEFINITION, root / f"{name}.json")


def write_reference(workspace: Path, payload: dict) -> None:
    work = workspace / "work"
    work.mkdir(exist_ok=True)
    (work / "findings.json").write_text(
        json.dumps(payload, indent=2) + "\n", encoding="utf-8"
    )
    shutil.copyfile(DEFINITION / "maintainer/reference_report.md", work / "report.md")


def main() -> None:
    reference = json.loads(
        (DEFINITION / "maintainer/reference_findings.json").read_text(encoding="utf-8")
    )
    with tempfile.TemporaryDirectory(prefix="taskground-error-audit-") as directory:
        root = Path(directory)

        accepted = fresh_workspace(root, "accepted")
        write_reference(accepted, reference)
        accepted_report = run(accepted, root, "accepted")
        assert accepted_report["status"] == "passed", json.dumps(accepted_report, indent=2)
        assert all(accepted_report["checks"].values())

        # Real agent runs create session state after preparation. It is not corpus data.
        logged = fresh_workspace(root, "logged")
        write_reference(logged, reference)
        for relative in (
            ".jev/openrouter-models.json",
            ".jev/sessions/example/session.jsonl",
            ".jev/runs/example/command-read.stdout",
            ".context/session.json",
            ".cache/tool-cache.json",
        ):
            artifact = logged / relative
            artifact.parent.mkdir(parents=True, exist_ok=True)
            artifact.write_text("runtime state\n", encoding="utf-8")
        logged_report = run(logged, root, "logged")
        assert logged_report["status"] == "passed", json.dumps(logged_report, indent=2)
        assert logged_report["metrics"]["fixtureDifferences"] == []

        # Ignore runtime directories only at the root; preserve strict source integrity.
        unexpected = logged / "prefect/.jev/added_source.py"
        unexpected.parent.mkdir(parents=True)
        unexpected.write_text("unexpected = True\n", encoding="utf-8")
        added_report = run(logged, root, "added-source")
        assert added_report["status"] == "failed"
        assert "prefect/.jev/added_source.py" in added_report["metrics"]["fixtureDifferences"]

        empty = fresh_workspace(root, "empty")
        assert run(empty, root, "empty")["status"] == "failed"

        malformed = fresh_workspace(root, "malformed")
        (malformed / "work/findings.json").write_text(
            '{"schemaVersion": 1, "schemaVersion": 1}\n', encoding="utf-8"
        )
        shutil.copyfile(DEFINITION / "maintainer/reference_report.md", malformed / "work/report.md")
        malformed_report = run(malformed, root, "malformed")
        assert malformed_report["status"] == "failed"
        assert "duplicate JSON key" in (malformed_report["error"] or "")

        wrong = fresh_workspace(root, "wrong")
        wrong_payload = copy.deepcopy(reference)
        wrong_payload["findings"][0]["mechanism"] = "other"
        write_reference(wrong, wrong_payload)
        wrong_report = run(wrong, root, "wrong")
        assert wrong_report["status"] == "failed"
        assert "async-template-false-success" in wrong_report["metrics"]["semanticMismatches"]

        known_safe = fresh_workspace(root, "known-safe")
        safe_payload = copy.deepcopy(reference)
        safe_payload["findings"].append(
            {
                "id": "blanket-analytics-false-positive",
                "title": "Internal analytics delivery errors are suppressed",
                "severity": "medium",
                "confidence": "low",
                "boundary": {
                    "path": "prefect/src/prefect/_internal/analytics/client.py",
                    "symbol": "track_event",
                    "startLine": 116,
                    "endLine": 123
                },
                "mechanism": "other",
                "failureMode": "false-success",
                "trigger": "The optional analytics transport raises while tracking an internal SDK event.",
                "observedBehavior": "The analytics adapter catches the transport error and returns a false delivery status.",
                "impact": "A speculative submission labels missing anonymous product analytics as workflow failure.",
                "recommendation": "Preserve the documented fire-and-forget contract and inspect the boolean only for diagnostics.",
                "callPath": [
                    {
                        "path": "prefect/src/prefect/_internal/analytics/client.py",
                        "symbol": "track_event",
                        "line": 122,
                        "role": "boundary"
                    },
                    {
                        "path": "prefect/src/prefect/_internal/analytics/client.py",
                        "symbol": "_initialize_client",
                        "line": 75,
                        "role": "contract"
                    }
                ],
                "evidence": [
                    {
                        "path": "prefect/src/prefect/_internal/analytics/client.py",
                        "line": 4,
                        "description": "The module documents silent fire-and-forget failure handling."
                    },
                    {
                        "path": "prefect/src/prefect/_internal/analytics/client.py",
                        "line": 123,
                        "description": "The caller receives false rather than a false workflow success signal."
                    }
                ]
            }
        )
        write_reference(known_safe, safe_payload)
        known_safe_report = run(known_safe, root, "known-safe")
        assert known_safe_report["status"] == "failed"
        assert known_safe_report["checks"]["known_safe_not_flagged"] is False

        blanket = fresh_workspace(root, "blanket")
        blanket_payload = copy.deepcopy(reference)
        while len(blanket_payload["findings"]) < 9:
            extra = copy.deepcopy(blanket_payload["findings"][0])
            extra["id"] = f"blanket-{len(blanket_payload['findings'])}"
            blanket_payload["findings"].append(extra)
        write_reference(blanket, blanket_payload)
        blanket_report = run(blanket, root, "blanket")
        assert blanket_report["status"] == "failed"
        assert "findings must contain" in (blanket_report["error"] or "")

        tampered = fresh_workspace(root, "tampered")
        write_reference(tampered, reference)
        source = tampered / "prefect/src/prefect/events/utilities.py"
        source.write_text(source.read_text(encoding="utf-8") + "\n# tampered\n", encoding="utf-8")
        tampered_report = run(tampered, root, "tampered")
        assert tampered_report["status"] == "failed"
        assert tampered_report["checks"]["fixture_integrity"] is False

        print(
            json.dumps(
                {
                    "reference": accepted_report["status"],
                    "runtimeArtifacts": logged_report["status"],
                    "addedSource": added_report["status"],
                    "empty": run(empty, root, "empty-again")["status"],
                    "malformed": malformed_report["status"],
                    "wrong": wrong_report["status"],
                    "knownSafe": known_safe_report["status"],
                    "blanket": blanket_report["status"],
                    "tampered": tampered_report["status"],
                    "matched": accepted_report["metrics"]["matched"],
                },
                sort_keys=True,
            )
        )


if __name__ == "__main__":
    main()
