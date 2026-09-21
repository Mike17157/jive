#!/usr/bin/env python3
"""Deterministic artifact verifier for the Prefect error-handling audit."""

from __future__ import annotations

import ast
import json
import os
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 1
SEVERITIES = {"critical", "high", "medium", "low"}
CONFIDENCES = {"high", "medium", "low"}
MECHANISMS = {
    "exception-returned-as-data",
    "dependency-stream-discard",
    "callback-notification-lost",
    "cleanup-failure-suppressed",
    "other",
}
FAILURE_MODES = {
    "false-success",
    "invalid-value-propagation",
    "stale-resource-use",
    "stalled-completion",
    "leaked-capacity",
    "other",
}
ROLES = {"boundary", "caller", "observer", "contract"}


class SubmissionError(ValueError):
    pass


def duplicate_safe_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    answer: dict[str, Any] = {}
    for key, value in pairs:
        if key in answer:
            raise SubmissionError(f"duplicate JSON key: {key}")
        answer[key] = value
    return answer


def read_json(path: Path, maximum: int) -> Any:
    if not path.is_file():
        raise SubmissionError(f"missing {path.name}")
    if path.stat().st_size > maximum:
        raise SubmissionError(f"{path.name} is too large")
    try:
        return json.loads(
            path.read_text(encoding="utf-8"), object_pairs_hook=duplicate_safe_object
        )
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise SubmissionError(f"invalid JSON in {path.name}: {exc}") from exc


def require_dict(value: Any, name: str) -> dict[str, Any]:
    if type(value) is not dict:
        raise SubmissionError(f"{name} must be an object")
    return value


def require_list(value: Any, name: str, minimum: int, maximum: int) -> list[Any]:
    if type(value) is not list or not minimum <= len(value) <= maximum:
        raise SubmissionError(f"{name} must contain {minimum}..{maximum} items")
    return value


def require_string(value: Any, name: str, minimum: int = 1, maximum: int = 500) -> str:
    if type(value) is not str or not minimum <= len(value.strip()) <= maximum:
        raise SubmissionError(f"{name} must be a string of length {minimum}..{maximum}")
    return value.strip()


def require_int(value: Any, name: str, minimum: int = 1) -> int:
    if type(value) is not int or value < minimum:
        raise SubmissionError(f"{name} must be an integer >= {minimum}")
    return value


def safe_path(workspace: Path, relative: Any, name: str) -> tuple[str, Path]:
    text = require_string(relative, name, 1, 300)
    candidate = Path(text)
    if candidate.is_absolute() or ".." in candidate.parts or candidate.as_posix() != text:
        raise SubmissionError(f"{name} must be a normalized relative path")
    if not (text.startswith("prefect/") or text.startswith("third_party/")):
        raise SubmissionError(f"{name} must cite retained source, tests, or dependency code")
    resolved = workspace / candidate
    try:
        resolved_target = resolved.resolve(strict=True)
        resolved_target.relative_to(workspace.resolve())
    except (FileNotFoundError, RuntimeError, ValueError) as exc:
        raise SubmissionError(f"{name} escapes the workspace or is missing: {text}") from exc
    current = workspace
    has_internal_symlink = False
    for part in candidate.parts[:-1]:
        current = current / part
        has_internal_symlink = has_internal_symlink or current.is_symlink()
    if not resolved.is_file() or resolved.is_symlink() or has_internal_symlink:
        raise SubmissionError(f"{name} does not name a retained file: {text}")
    return text, resolved


def source_line(workspace: Path, relative: Any, line: Any, name: str) -> tuple[str, int]:
    path_text, path = safe_path(workspace, relative, f"{name}.path")
    number = require_int(line, f"{name}.line")
    lines = path.read_text(encoding="utf-8").splitlines()
    if number > len(lines) or not lines[number - 1].strip():
        raise SubmissionError(f"{name} must cite a nonblank real line")
    return path_text, number


class DefinitionVisitor(ast.NodeVisitor):
    def __init__(self) -> None:
        self.stack: list[str] = []
        self.definitions: list[tuple[str, int, int]] = []
        self.handlers: list[tuple[str, int]] = []

    def _definition(self, node: ast.ClassDef | ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        self.stack.append(node.name)
        self.definitions.append(
            (".".join(self.stack), node.lineno, getattr(node, "end_lineno", node.lineno))
        )
        self.generic_visit(node)
        self.stack.pop()

    visit_ClassDef = _definition
    visit_FunctionDef = _definition
    visit_AsyncFunctionDef = _definition

    def visit_ExceptHandler(self, node: ast.ExceptHandler) -> None:
        caught = ast.unparse(node.type) if node.type is not None else "bare"
        if caught == "bare" or "Exception" in caught:
            self.handlers.append((".".join(self.stack) or "<module>", node.lineno))
        self.generic_visit(node)


def inspect_python(path: Path) -> DefinitionVisitor:
    visitor = DefinitionVisitor()
    visitor.visit(ast.parse(path.read_text(encoding="utf-8")))
    return visitor


def symbol_contains(workspace: Path, relative: str, symbol: str, line: int) -> bool:
    path = workspace / relative
    if path.suffix != ".py":
        return False
    try:
        visitor = inspect_python(path)
    except (SyntaxError, UnicodeDecodeError):
        return False
    return any(name == symbol and start <= line <= end for name, start, end in visitor.definitions)


def fixture_unchanged(workspace: Path, definition: Path) -> tuple[bool, list[str]]:
    baseline = definition / "workspace"
    differences: list[str] = []
    def comparable(root: Path) -> dict[str, Path]:
        answer: dict[str, Path] = {}
        for path in root.rglob("*"):
            if not path.is_file():
                continue
            relative = path.relative_to(root)
            if (
                relative.parts[0] in {"work", ".git"}
                or "__pycache__" in relative.parts
                or path.suffix == ".pyc"
                or relative.as_posix() in {"README.md", "TASK.md", ".env", ".gitignore"}
            ):
                continue
            answer[relative.as_posix()] = path
        return answer

    expected_files = comparable(baseline)
    actual_files = comparable(workspace)
    for relative in sorted(set(expected_files) | set(actual_files)):
        expected = expected_files.get(relative)
        actual = actual_files.get(relative)
        if expected is None or actual is None or actual.is_symlink() or actual.read_bytes() != expected.read_bytes():
            differences.append(relative)
    return not differences, differences


def validate_step(workspace: Path, raw: Any, name: str, with_role: bool) -> tuple[str, str, int]:
    step = require_dict(raw, name)
    path, line = source_line(workspace, step.get("path"), step.get("line"), name)
    symbol = require_string(step.get("symbol"), f"{name}.symbol", 1, 180)
    if not symbol_contains(workspace, path, symbol, line):
        raise SubmissionError(f"{name} line is outside the named symbol")
    if with_role and step.get("role") not in ROLES:
        raise SubmissionError(f"{name}.role is invalid")
    return path, symbol, line


def validate_submission(workspace: Path, reference: dict[str, Any], payload: Any) -> dict[str, Any]:
    root = require_dict(payload, "root")
    if type(root.get("schemaVersion")) is not int or root.get("schemaVersion") != SCHEMA_VERSION or root.get("task") != reference["task"]:
        raise SubmissionError("schemaVersion or task is incorrect")

    scope = require_dict(root.get("scope"), "scope")
    reviewed = require_list(scope.get("reviewedFiles"), "scope.reviewedFiles", 1, 50)
    if any(type(item) is not str for item in reviewed) or len(set(reviewed)) != len(reviewed):
        raise SubmissionError("scope.reviewedFiles must contain unique strings")
    if not set(reference["primaryScope"]).issubset(reviewed):
        raise SubmissionError("scope.reviewedFiles omits primary-scope files")
    broad_reviewed = require_int(scope.get("broadHandlersReviewed"), "scope.broadHandlersReviewed")
    boundary_reviewed = require_int(scope.get("boundaryApisReviewed"), "scope.boundaryApisReviewed")

    findings = require_list(root.get("findings"), "findings", 0, reference["maxFindings"])
    ids: set[str] = set()
    boundaries: set[tuple[str, str]] = set()
    normalized_findings: list[dict[str, Any]] = []
    for index, raw in enumerate(findings):
        name = f"findings[{index}]"
        finding = require_dict(raw, name)
        finding_id = require_string(finding.get("id"), f"{name}.id", 2, 80)
        if finding_id in ids:
            raise SubmissionError("finding IDs must be unique")
        ids.add(finding_id)
        require_string(finding.get("title"), f"{name}.title", 12, 180)
        if finding.get("severity") not in SEVERITIES or finding.get("confidence") not in CONFIDENCES:
            raise SubmissionError(f"{name} severity or confidence is invalid")
        if finding.get("mechanism") not in MECHANISMS or finding.get("failureMode") not in FAILURE_MODES:
            raise SubmissionError(f"{name} mechanism or failureMode is invalid")
        for field in ("trigger", "observedBehavior", "impact", "recommendation"):
            require_string(finding.get(field), f"{name}.{field}", 24, 1200)

        boundary = require_dict(finding.get("boundary"), f"{name}.boundary")
        path, path_obj = safe_path(workspace, boundary.get("path"), f"{name}.boundary.path")
        symbol = require_string(boundary.get("symbol"), f"{name}.boundary.symbol", 1, 180)
        start = require_int(boundary.get("startLine"), f"{name}.boundary.startLine")
        end = require_int(boundary.get("endLine"), f"{name}.boundary.endLine")
        lines = path_obj.read_text(encoding="utf-8").splitlines()
        if end < start or end - start + 1 > 12 or end > len(lines):
            raise SubmissionError(f"{name}.boundary must be a real span of at most 12 lines")
        if not any(line.strip() for line in lines[start - 1 : end]):
            raise SubmissionError(f"{name}.boundary span is blank")
        if not symbol_contains(workspace, path, symbol, start):
            raise SubmissionError(f"{name}.boundary start is outside the named symbol")
        key = (path, symbol)
        if key in boundaries:
            raise SubmissionError("finding boundary locations must be unique")
        boundaries.add(key)

        call_path = require_list(finding.get("callPath"), f"{name}.callPath", 2, 6)
        call_facts = [validate_step(workspace, step, f"{name}.callPath[{i}]", True) for i, step in enumerate(call_path)]
        if len({fact[:2] for fact in call_facts}) != len(call_facts):
            raise SubmissionError(f"{name}.callPath contains duplicate locations")
        evidence = require_list(finding.get("evidence"), f"{name}.evidence", 2, 6)
        evidence_facts: list[tuple[str, int]] = []
        for i, raw_evidence in enumerate(evidence):
            item_name = f"{name}.evidence[{i}]"
            item = require_dict(raw_evidence, item_name)
            evidence_path, evidence_line = source_line(workspace, item.get("path"), item.get("line"), item_name)
            require_string(item.get("description"), f"{item_name}.description", 16, 500)
            evidence_facts.append((evidence_path, evidence_line))
        if len(set(evidence_facts)) != len(evidence_facts):
            raise SubmissionError(f"{name}.evidence contains duplicate citations")
        normalized_findings.append(
            {
                "id": finding_id,
                "path": path,
                "symbol": symbol,
                "start": start,
                "end": end,
                "mechanism": finding["mechanism"],
                "failureMode": finding["failureMode"],
                "callFacts": {(fact[0], fact[1]) for fact in call_facts},
            }
        )

    rejected = require_list(root.get("rejectedLookalikes"), "rejectedLookalikes", 3, 12)
    rejected_locations: set[tuple[str, str]] = set()
    primary_handlers: set[tuple[str, str, int]] = set()
    for path in reference["primaryScope"]:
        for symbol, line in inspect_python(workspace / path).handlers:
            primary_handlers.add((path, symbol, line))
    for index, raw in enumerate(rejected):
        name = f"rejectedLookalikes[{index}]"
        item = require_dict(raw, name)
        path, line = source_line(workspace, item.get("path"), item.get("line"), name)
        symbol = require_string(item.get("symbol"), f"{name}.symbol", 1, 180)
        require_string(item.get("reason"), f"{name}.reason", 24, 800)
        if not any(p == path and s == symbol and abs(handler_line - line) <= 3 for p, s, handler_line in primary_handlers):
            raise SubmissionError(f"{name} must identify a broad handler in primary scope")
        location = (path, symbol)
        if location in rejected_locations or location in boundaries:
            raise SubmissionError("rejected locations must be unique and cannot also be findings")
        rejected_locations.add(location)

    unresolved = require_list(root.get("unresolvedBoundaries"), "unresolvedBoundaries", 1, 12)
    unresolved_locations: set[tuple[str, str]] = set()
    for index, raw in enumerate(unresolved):
        name = f"unresolvedBoundaries[{index}]"
        item = require_dict(raw, name)
        path, line = source_line(workspace, item.get("path"), item.get("line"), name)
        symbol = require_string(item.get("symbol"), f"{name}.symbol", 1, 180)
        if not symbol_contains(workspace, path, symbol, line):
            raise SubmissionError(f"{name} line is outside the named symbol")
        require_string(item.get("reason"), f"{name}.reason", 24, 800)
        require_string(item.get("recommendedNextStep"), f"{name}.recommendedNextStep", 24, 800)
        location = (path, symbol)
        if location in unresolved_locations or location in boundaries or location in rejected_locations:
            raise SubmissionError("unresolved locations must be unique and separately classified")
        unresolved_locations.add(location)

    return {
        "reviewedFiles": reviewed,
        "broadHandlersReviewed": broad_reviewed,
        "boundaryApisReviewed": boundary_reviewed,
        "findings": normalized_findings,
        "rejectedCount": len(rejected),
        "unresolvedCount": len(unresolved),
    }


def score(reference: dict[str, Any], normalized: dict[str, Any]) -> dict[str, Any]:
    matched: list[str] = []
    semantic_mismatches: list[str] = []
    finding_matches: dict[str, str] = {}
    for expected in reference["expected"]:
        candidates = [
            finding
            for finding in normalized["findings"]
            if finding["path"] == expected["path"]
            and finding["symbol"] == expected["symbol"]
            and finding["start"] <= expected["lineMax"]
            and finding["end"] >= expected["lineMin"]
        ]
        if not candidates:
            continue
        finding = candidates[0]
        required_facts = {tuple(item) for item in expected["requiredCallPath"]}
        semantics_ok = (
            finding["mechanism"] == expected["mechanism"]
            and finding["failureMode"] == expected["failureMode"]
            and required_facts.issubset(finding["callFacts"])
        )
        if semantics_ok:
            matched.append(expected["key"])
            finding_matches[finding["id"]] = expected["key"]
        else:
            semantic_mismatches.append(expected["key"])

    known_expected = {tuple(item) for item in reference["knownExpectedBehavior"]}
    contradicted = sorted(
        finding["id"]
        for finding in normalized["findings"]
        if (finding["path"], finding["symbol"]) in known_expected
    )
    unknown = sorted(
        finding["id"]
        for finding in normalized["findings"]
        if finding["id"] not in finding_matches and finding["id"] not in contradicted
    )
    return {
        "matched": sorted(matched),
        "missing": sorted(set(item["key"] for item in reference["expected"]) - set(matched)),
        "semanticMismatches": sorted(semantic_mismatches),
        "contradictedExpectedBehavior": contradicted,
        "needsReview": unknown,
    }


def validate_report(path: Path) -> tuple[bool, str]:
    if not path.is_file() or not 500 <= path.stat().st_size <= 256_000:
        return False, "report.md must be 500..256000 bytes"
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return False, "report.md must be UTF-8"
    headings = [
        "# Error Handling Audit",
        "## Scope and search coverage",
        "## Confirmed findings",
        "## Rejected lookalikes",
        "## Unresolved and dependency boundaries",
    ]
    positions = [text.find(heading) for heading in headings]
    valid = all(position >= 0 for position in positions) and positions == sorted(positions)
    return valid, "required headings present in order" if valid else "required headings missing or out of order"


def verify(workspace: Path, definition: Path, output: Path) -> dict[str, Any]:
    checks = {
        "valid_submission": False,
        "fixture_integrity": False,
        "audit_scope": False,
        "findings_quality": False,
        "confirmed_coverage": False,
        "known_safe_not_flagged": False,
        "rejected_lookalikes": False,
        "report": False,
    }
    metrics: dict[str, Any] = {}
    error: str | None = None
    try:
        reference = read_json(definition / "verifier/reference.json", 256_000)
        unchanged, differences = fixture_unchanged(workspace, definition)
        checks["fixture_integrity"] = unchanged
        metrics["fixtureDifferences"] = differences

        payload = read_json(workspace / "work/findings.json", 512_000)
        normalized = validate_submission(workspace, reference, payload)
        checks["valid_submission"] = True
        checks["audit_scope"] = (
            normalized["broadHandlersReviewed"] >= reference["broadHandlerCount"]
            and normalized["boundaryApisReviewed"] >= reference["boundaryApiMinimum"]
        )
        checks["findings_quality"] = True
        result = score(reference, normalized)
        metrics.update(result)
        metrics.update(
            {
                "findingCount": len(normalized["findings"]),
                "expectedCount": len(reference["expected"]),
                "rejectedCount": normalized["rejectedCount"],
                "unresolvedCount": normalized["unresolvedCount"],
                "broadHandlersReviewed": normalized["broadHandlersReviewed"],
                "boundaryApisReviewed": normalized["boundaryApisReviewed"],
            }
        )
        checks["confirmed_coverage"] = len(result["matched"]) == len(reference["expected"])
        checks["known_safe_not_flagged"] = not result["contradictedExpectedBehavior"]
        checks["rejected_lookalikes"] = normalized["rejectedCount"] >= 3
        checks["report"], metrics["reportDetail"] = validate_report(workspace / "work/report.md")
    except (SubmissionError, OSError, SyntaxError, TypeError, ValueError) as exc:
        error = str(exc)

    status = "passed" if all(checks.values()) else "failed"
    report = {
        "schemaVersion": SCHEMA_VERSION,
        "task": "error_handling_audit",
        "status": status,
        "checks": checks,
        "metrics": metrics,
        "error": error,
        "limitations": [
            "The verifier checks structured classifications, exact call-path facts, bounded real citations, inventory coverage, and known expected-behavior boundaries; prose semantics and investigation quality still require trace review.",
            "Additional plausible findings are marked needsReview rather than treated as confirmed or false. The held-out labels are a curated reference for this bounded fixture, not an exhaustive claim about the Prefect repository.",
            "Local task folder separation is not a security sandbox.",
        ],
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return report


def main() -> int:
    workspace = Path(os.environ["TASKGROUND_WORKSPACE"])
    definition = Path(os.environ["TASKGROUND_DEFINITION"])
    output = Path(os.environ["TASKGROUND_RESULT"])
    report = verify(workspace, definition, output)
    print(json.dumps(report, sort_keys=True))
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
