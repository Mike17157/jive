#!/usr/bin/env python3
"""Held-out verifier for the async_blocking_audit task."""

from __future__ import annotations

import hashlib
import json
import os
import re
import traceback
from collections import Counter
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 1
TASK_ID = "async_blocking_audit"
SNAPSHOT = {
    "project": "home-assistant/core",
    "version": "2024.9.0",
    "commit": "36ec1b33fe0039d838586730768730c2ea4e054c",
}
CATEGORIES = {
    "confirmed_blocking",
    "executor_protected",
    "native_async",
    "safe_sync",
    "unresolved",
}
REQUIRED_BLOCKERS = {
    ("source/homeassistant/components/yale_smart_alarm/coordinator.py", 39),
    ("source/homeassistant/components/xiaomi_miio/config_flow.py", 240),
    ("source/homeassistant/components/media_source/local_source.py", 228),
}
PRIMARY_MARKERS = (
    "source/homeassistant/components/yale_smart_alarm/",
    "source/homeassistant/components/xiaomi_miio/",
    "source/homeassistant/components/media_source/",
)
ID_RE = re.compile(r"^[a-z][a-z0-9-]{2,79}$")


class ValidationError(ValueError):
    """A candidate artifact is malformed or unsupported."""


def strict_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValidationError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=strict_object)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def text(value: Any, name: str, minimum: int = 1, maximum: int = 1000) -> str:
    if not isinstance(value, str) or not minimum <= len(value.strip()) <= maximum:
        raise ValidationError(f"{name} must be a string of {minimum}..{maximum} characters")
    return value.strip()


def integer(value: Any, name: str, minimum: int = 1, maximum: int = 1_000_000) -> int:
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValidationError(f"{name} must be an integer in {minimum}..{maximum}")
    return value


def sequence(value: Any, name: str, minimum: int = 1, maximum: int = 1000) -> list[Any]:
    if not isinstance(value, list) or not minimum <= len(value) <= maximum:
        raise ValidationError(f"{name} must be a list with {minimum}..{maximum} entries")
    return value


def workspace_file(workspace: Path, relative: Any, name: str) -> tuple[str, Path]:
    value = text(relative, name, maximum=300)
    path = Path(value)
    if path.is_absolute() or ".." in path.parts or not value.startswith("source/"):
        raise ValidationError(f"{name} must be a workspace-relative path under source/")
    resolved = (workspace / path).resolve()
    source_root = (workspace / "source").resolve()
    if resolved == source_root or source_root not in resolved.parents or not resolved.is_file():
        raise ValidationError(f"{name} does not name a supplied regular source file: {value}")
    return value, resolved


def line_count(path: Path) -> int:
    return len(path.read_text(encoding="utf-8", errors="replace").splitlines())


def validate_pointer(workspace: Path, value: Any, name: str) -> tuple[str, int, str]:
    if not isinstance(value, dict):
        raise ValidationError(f"{name} must be an object")
    path_name, path = workspace_file(workspace, value.get("path"), f"{name}.path")
    line = integer(value.get("line"), f"{name}.line", maximum=line_count(path))
    symbol = text(value.get("symbol"), f"{name}.symbol", minimum=3, maximum=160)
    return path_name, line, symbol


def check_integrity(workspace: Path, definition: Path) -> tuple[bool, str, dict[str, Any]]:
    try:
        manifest = load_json(definition / "SOURCE.json")
        expected = manifest.get("files")
        if not isinstance(expected, dict) or not expected:
            raise ValidationError("SOURCE.json files map is missing")
        actual_paths = {
            path.relative_to(workspace).as_posix()
            for path in (workspace / "source").rglob("*")
            if path.is_file()
        }
        if actual_paths != set(expected):
            missing = sorted(set(expected) - actual_paths)[:4]
            extra = sorted(actual_paths - set(expected))[:4]
            raise ValidationError(f"source file set changed; missing={missing}, extra={extra}")
        for relative, digest in expected.items():
            if not isinstance(digest, str) or len(digest) != 64:
                raise ValidationError(f"bad manifest digest for {relative}")
            candidate = workspace / relative
            frozen = definition / "workspace" / relative
            if sha256(candidate) != digest or sha256(frozen) != digest:
                raise ValidationError(f"source differs from the pinned fixture: {relative}")
        return True, f"{len(expected)} pinned source files match SOURCE.json", {"sourceFiles": len(expected)}
    except (OSError, TypeError, ValueError, json.JSONDecodeError) as error:
        return False, str(error), {}


def load_known_sites(definition: Path) -> dict[tuple[str, int], str]:
    payload = load_json(definition / "verifier/reference_sites.json")
    sites = sequence(payload.get("sites"), "reference sites")
    result: dict[tuple[str, int], str] = {}
    for site in sites:
        if not isinstance(site, dict):
            raise ValidationError("reference site must be an object")
        key = (text(site.get("path"), "reference path"), integer(site.get("line"), "reference line"))
        category = text(site.get("classification"), "reference classification")
        if category not in CATEGORIES or key in result:
            raise ValidationError(f"invalid or duplicate reference site: {key}")
        result[key] = category
    return result


def component(path: str) -> str:
    for marker in PRIMARY_MARKERS:
        if marker in path:
            return marker.rstrip("/").rsplit("/", 1)[-1]
    return "support"


def validate_artifact(
    workspace: Path, definition: Path
) -> tuple[dict[str, Any], dict[str, Any]]:
    artifact_path = workspace / "work/findings.json"
    if not artifact_path.is_file():
        raise ValidationError("work/findings.json is missing")
    artifact = load_json(artifact_path)
    if not isinstance(artifact, dict):
        raise ValidationError("findings.json root must be an object")
    if type(artifact.get("schemaVersion")) is not int or artifact.get("schemaVersion") != SCHEMA_VERSION:
        raise ValidationError("schemaVersion must be 1")
    if artifact.get("snapshot") != SNAPSHOT:
        raise ValidationError("snapshot must exactly identify the supplied Home Assistant revision")

    scope = artifact.get("scope")
    if not isinstance(scope, dict):
        raise ValidationError("scope must be an object")
    candidate_count = integer(scope.get("candidateCount"), "scope.candidateCount", 30, 10000)
    reviewed = sequence(scope.get("filesReviewed"), "scope.filesReviewed", 10, 200)
    reviewed_paths: list[str] = []
    for index, value in enumerate(reviewed):
        path_name, _ = workspace_file(workspace, value, f"filesReviewed[{index}]")
        reviewed_paths.append(path_name)
    if len(reviewed_paths) != len(set(reviewed_paths)):
        raise ValidationError("filesReviewed contains duplicates")
    for marker in PRIMARY_MARKERS:
        if not any(path.startswith(marker) for path in reviewed_paths):
            raise ValidationError(f"filesReviewed does not cover {marker}")
    if not any(path.startswith("source/dependencies/") for path in reviewed_paths):
        raise ValidationError("filesReviewed must include dependency source used in the audit")
    searches = sequence(scope.get("searches"), "scope.searches", 3, 20)
    for index, search in enumerate(searches):
        if not isinstance(search, dict):
            raise ValidationError(f"searches[{index}] must be an object")
        text(search.get("query"), f"searches[{index}].query", 3, 300)
        text(search.get("reason"), f"searches[{index}].reason", 15, 500)
        integer(search.get("filesMatched"), f"searches[{index}].filesMatched", 0, 500)

    known = load_known_sites(definition)
    findings = sequence(artifact.get("findings"), "findings", 1, 100)
    ids: set[str] = set()
    locations: set[tuple[str, int]] = set()
    credited: dict[tuple[str, int], dict[str, Any]] = {}
    contradictions: list[str] = []
    unknown: list[str] = []
    for index, finding in enumerate(findings):
        name = f"findings[{index}]"
        if not isinstance(finding, dict):
            raise ValidationError(f"{name} must be an object")
        finding_id = text(finding.get("id"), f"{name}.id", 3, 80)
        if not ID_RE.fullmatch(finding_id) or finding_id in ids:
            raise ValidationError(f"{name}.id must be unique lower-case kebab-case")
        ids.add(finding_id)
        category = text(finding.get("classification"), f"{name}.classification")
        if category not in CATEGORIES:
            raise ValidationError(f"{name}.classification is not a supported category")
        location = finding.get("location")
        if not isinstance(location, dict):
            raise ValidationError(f"{name}.location must be an object")
        path_name, path = workspace_file(workspace, location.get("path"), f"{name}.location.path")
        line = integer(location.get("line"), f"{name}.location.line", maximum=line_count(path))
        key = (path_name, line)
        if key in locations:
            raise ValidationError(f"duplicate finding location: {path_name}:{line}")
        locations.add(key)
        text(finding.get("symbol"), f"{name}.symbol", 3, 180)
        expression = text(finding.get("expression"), f"{name}.expression", 3, 300)
        reason = text(finding.get("reason"), f"{name}.reason", 40, 1500)

        source_lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        nearby = " ".join(source_lines[max(0, line - 3):min(len(source_lines), line + 2)]).lower()
        anchors = [token.lower() for token in re.findall(r"[A-Za-z_][A-Za-z0-9_]{3,}", expression)]
        if not anchors or not any(token in nearby for token in anchors):
            raise ValidationError(f"{name}.expression is not anchored near its source line")

        caller_path = sequence(finding.get("callerPath"), f"{name}.callerPath", 1, 12)
        for caller_index, pointer in enumerate(caller_path):
            validate_pointer(workspace, pointer, f"{name}.callerPath[{caller_index}]")

        evidence = sequence(finding.get("evidence"), f"{name}.evidence", 1, 8)
        local_coverage = False
        evidence_paths: list[tuple[str, int, int]] = []
        for evidence_index, citation in enumerate(evidence):
            citation_name = f"{name}.evidence[{evidence_index}]"
            if not isinstance(citation, dict):
                raise ValidationError(f"{citation_name} must be an object")
            cited_name, cited_path = workspace_file(workspace, citation.get("path"), f"{citation_name}.path")
            maximum = line_count(cited_path)
            start = integer(citation.get("startLine"), f"{citation_name}.startLine", maximum=maximum)
            end = integer(citation.get("endLine"), f"{citation_name}.endLine", start, maximum)
            if end - start + 1 > 12:
                raise ValidationError(f"{citation_name} spans more than 12 lines")
            text(citation.get("note"), f"{citation_name}.note", 20, 800)
            if cited_name == path_name and start <= line <= end:
                local_coverage = True
            evidence_paths.append((cited_name, start, end))
        if not local_coverage:
            raise ValidationError(f"{name} lacks local evidence covering its finding line")

        expected = known.get(key)
        if expected is None:
            unknown.append(finding_id)
        elif expected != category:
            contradictions.append(f"{finding_id} labels {path_name}:{line} {category}, expected {expected}")
        else:
            credited[key] = {
                "id": finding_id,
                "classification": category,
                "component": component(path_name),
                "evidence": evidence_paths,
                "reason": reason,
            }

    if contradictions:
        raise ValidationError("known-site classification contradictions: " + "; ".join(contradictions[:5]))
    missing_blockers = REQUIRED_BLOCKERS - set(credited)
    if missing_blockers:
        formatted = [f"{path}:{line}" for path, line in sorted(missing_blockers)]
        raise ValidationError(f"confirmed blockers missing or unsupported: {formatted}")

    # The two constructor findings need dependency evidence, not a same-line assertion.
    yale = credited[("source/homeassistant/components/yale_smart_alarm/coordinator.py", 39)]
    if not any("yalesmartalarmclient-0.4.0/yalesmartalarmclient/auth.py" in path and start <= 214 <= end for path, start, end in yale["evidence"]):
        raise ValidationError("Yale constructor finding must cite the synchronous authorization request")
    xiaomi = credited[("source/homeassistant/components/xiaomi_miio/config_flow.py", 240)]
    xiaomi_paths = {path for path, _, _ in xiaomi["evidence"]}
    if not any("dependencies/micloud-0.5/" in path for path in xiaomi_paths) or not any("dependencies/tzlocal-5.2/" in path for path in xiaomi_paths):
        raise ValidationError("Xiaomi constructor finding must trace both MiCloud and tzlocal source")

    category_sites: dict[str, list[dict[str, Any]]] = {category: [] for category in CATEGORIES}
    for value in credited.values():
        category_sites[value["classification"]].append(value)
    requirements = {"executor_protected": 4, "native_async": 2, "safe_sync": 2, "unresolved": 1}
    for category, minimum in requirements.items():
        if len(category_sites[category]) < minimum:
            raise ValidationError(f"need at least {minimum} independently supported {category} findings")
    for category in ("executor_protected", "native_async", "safe_sync"):
        components = {item["component"] for item in category_sites[category]}
        if len(components - {"support"}) < 2:
            raise ValidationError(f"{category} findings must cover at least two integrations")

    limitations = sequence(artifact.get("limitations"), "limitations", 1, 12)
    for index, limitation in enumerate(limitations):
        text(limitation, f"limitations[{index}]", 25, 600)

    metrics = {
        "candidateCount": candidate_count,
        "filesReviewed": len(reviewed_paths),
        "findings": len(findings),
        "creditedFindings": len(credited),
        "creditedByCategory": dict(sorted(Counter(item["classification"] for item in credited.values()).items())),
        "manualReviewFindingIds": unknown,
        "creditedIds": [item["id"] for item in credited.values()],
        "requiredIds": [credited[key]["id"] for key in sorted(REQUIRED_BLOCKERS)],
        "rejectedIds": [item["id"] for item in credited.values() if item["classification"] in {"executor_protected", "native_async", "safe_sync"}],
        "unresolvedIds": [item["id"] for item in credited.values() if item["classification"] == "unresolved"],
    }
    return artifact, metrics


def check_report(workspace: Path, artifact_metrics: dict[str, Any]) -> tuple[bool, str]:
    try:
        path = workspace / "work/report.md"
        if not path.is_file():
            raise ValidationError("work/report.md is missing")
        report = path.read_text(encoding="utf-8")
        if not 900 <= len(report) <= 30_000:
            raise ValidationError("report.md must contain 900..30000 characters")
        required = artifact_metrics["requiredIds"]
        rejected = artifact_metrics["rejectedIds"]
        unresolved = artifact_metrics["unresolvedIds"]
        if not all(f"`{finding_id}`" in report or finding_id in report for finding_id in required):
            raise ValidationError("report must discuss every confirmed blocker by finding ID")
        if sum(1 for finding_id in rejected if finding_id in report) < 4:
            raise ValidationError("report must discuss at least four credited rejected candidates by ID")
        if not any(finding_id in report for finding_id in unresolved):
            raise ValidationError("report must discuss a credited unresolved boundary by ID")
        return True, "report is substantive and cross-references confirmed, rejected, and unresolved findings"
    except (OSError, TypeError, ValueError) as error:
        return False, str(error)


def main() -> int:
    workspace = Path(os.environ["TASKGROUND_WORKSPACE"]).resolve()
    definition = Path(os.environ["TASKGROUND_DEFINITION"]).resolve()
    output = Path(os.environ["TASKGROUND_RESULT"]).resolve()
    checks: list[dict[str, str]] = []
    metrics: dict[str, Any] = {}

    def add(name: str, passed: bool, detail: str) -> None:
        checks.append({"name": name, "status": "passed" if passed else "failed", "detail": detail})

    try:
        integrity_ok, integrity_detail, integrity_metrics = check_integrity(workspace, definition)
        add("pinned source integrity", integrity_ok, integrity_detail)
        metrics.update(integrity_metrics)

        artifact_metrics: dict[str, Any] | None = None
        try:
            _, artifact_metrics = validate_artifact(workspace, definition)
            add("structured audit and evidence", True, "schema, coverage, citations, caller paths, and held-out classifications are valid")
            metrics.update({key: value for key, value in artifact_metrics.items() if key not in {"creditedIds", "requiredIds", "rejectedIds", "unresolvedIds"}})
        except (OSError, TypeError, ValueError, json.JSONDecodeError) as error:
            add("structured audit and evidence", False, str(error))

        if artifact_metrics is None:
            add("maintainer report", False, "not checked because findings.json did not validate")
        else:
            report_ok, report_detail = check_report(workspace, artifact_metrics)
            add("maintainer report", report_ok, report_detail)
    except Exception as error:  # Always emit a Taskground report.
        add("verifier execution", False, f"{type(error).__name__}: {error}")
        metrics["traceback"] = traceback.format_exc(limit=8)

    passed = bool(checks) and all(check["status"] == "passed" for check in checks)
    report = {
        "schemaVersion": SCHEMA_VERSION,
        "task": TASK_ID,
        "status": "passed" if passed else "failed",
        "checks": checks,
        "metrics": metrics,
        "limitations": [
            "Static source and evidence validation only; prose semantics and unknown extra findings still require maintainer review.",
            "The verifier recognizes a broad audited catalog of supplied sites but does not claim the selected snapshot is exhaustive of Home Assistant.",
        ],
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(report, sort_keys=True))
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
