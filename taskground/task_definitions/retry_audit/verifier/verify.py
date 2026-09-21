#!/usr/bin/env python3
"""Deterministic artifact verifier for the retry_audit Taskground task."""

from __future__ import annotations

import hashlib
import json
import os
import re
import traceback
from pathlib import Path
from typing import Any


SCHEMA_VERSION = 1
TASK = "retry_audit"
COMMIT = "ecfa5a139c35f365836c0f462029537023d0357e"
SIGNAL = re.compile(r"retry|retries|attempt|backoff|poll|waiter|reschedul|sleep|pending", re.I)
ALLOWED_CLASSIFICATIONS = {"correctness_defect", "migration_candidate"}
ALLOWED_SEVERITIES = {"critical", "high", "medium", "low"}
ALLOWED_CONFIDENCE = {"high", "medium", "low"}
ALLOWED_REJECTIONS = {
    "legitimate_polling",
    "shared_retry_helper",
    "sdk_managed_retry",
    "bounded_local_retry",
    "configuration_only",
}

# Each tuple is (path, start, end). A matched finding must cite every required
# evidence group. Alternatives within a group are separated into different tuples.
EXPECTED = {
    "ecs_delayed_queue": {
        "primary": ("airflow/providers/amazon/aws/executors/ecs/ecs_executor.py", 338, 354),
        "evidence": [
            [("airflow/providers/amazon/aws/executors/ecs/ecs_executor.py", 340, 349)],
            [("airflow/providers/amazon/aws/executors/ecs/utils.py", 55, 72)],
        ],
    },
    "ecs_terminal_lifecycle": {
        "primary": ("airflow/providers/amazon/aws/executors/ecs/ecs_executor.py", 239, 326),
        "evidence": [
            [("airflow/providers/amazon/aws/executors/ecs/ecs_executor.py", 245, 260)],
            [("airflow/providers/amazon/aws/executors/ecs/ecs_executor.py", 291, 326)],
            [("tests/providers/amazon/aws/executors/ecs/test_ecs_executor.py", 630, 691)],
        ],
    },
    "sensor_reschedule_backoff": {
        "primary": ("airflow/sensors/base.py", 208, 331),
        "evidence": [
            [("airflow/sensors/base.py", 211, 240)],
            [("airflow/sensors/base.py", 282, 293)],
            [("airflow/sensors/base.py", 305, 331)],
        ],
    },
    "batch_retry_default": {
        "primary": ("airflow/providers/amazon/aws/operators/batch.py", 202, 315),
        "evidence": [
            [("airflow/providers/amazon/aws/operators/batch.py", 202, 209)],
            [("airflow/providers/amazon/aws/operators/batch.py", 302, 315)],
            [("tests/providers/amazon/aws/operators/test_batch.py", 91, 100),
             ("tests/providers/amazon/aws/operators/test_batch.py", 143, 150)],
        ],
    },
}

OPTIONAL_EXPECTED = {
    "emr_deferred_bound": {
        "primary": ("airflow/providers/amazon/aws/triggers/emr.py", 169, 207),
        "evidence": [
            [("airflow/providers/amazon/aws/triggers/emr.py", 169, 207)],
            [("airflow/providers/amazon/aws/operators/emr.py", 603, 627)],
        ],
    }
}

# These are deliberate healthy counterexamples in this snapshot. Reporting their
# exact mechanism as an actionable finding is a strong blanket-report signal.
KNOWN_NEGATIVES = [
    ("airflow/providers/amazon/aws/executors/batch/batch_executor.py", 265, 305),
    ("airflow/providers/amazon/aws/utils/waiter_with_logging.py", 68, 82),
    ("airflow/providers/amazon/aws/utils/waiter_with_logging.py", 119, 133),
    ("airflow/providers/google/common/hooks/base_google.py", 425, 452),
    ("airflow/providers/http/hooks/http.py", 245, 269),
    ("airflow/providers/slack/hooks/slack.py", 145, 158),
    ("airflow/providers/amazon/aws/hooks/quicksight.py", 148, 171),
]


class DuplicateKey(ValueError):
    pass


def no_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise DuplicateKey(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=no_duplicate_keys)


def is_plain_dict(value: Any) -> bool:
    return type(value) is dict


def valid_id(value: Any) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[a-z][a-z0-9_-]{2,63}", value) is not None


def valid_text(value: Any, minimum: int = 20, maximum: int = 4000) -> bool:
    return isinstance(value, str) and minimum <= len(value.strip()) <= maximum


def corpus_path(corpus: Path, relative: Any) -> Path | None:
    if not isinstance(relative, str) or not relative or "\\" in relative:
        return None
    candidate = Path(relative)
    if candidate.is_absolute() or ".." in candidate.parts or candidate.as_posix() != relative:
        return None
    resolved = (corpus / candidate).resolve()
    try:
        resolved.relative_to(corpus.resolve())
    except ValueError:
        return None
    return resolved if resolved.is_file() else None


def line_count(path: Path) -> int:
    return len(path.read_text(encoding="utf-8").splitlines())


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def valid_location(corpus: Path, value: Any) -> bool:
    if not is_plain_dict(value) or set(value) != {"path", "line"}:
        return False
    path = corpus_path(corpus, value.get("path"))
    line = value.get("line")
    return path is not None and type(line) is int and 1 <= line <= line_count(path)


def valid_evidence(corpus: Path, value: Any) -> bool:
    if not is_plain_dict(value) or set(value) != {"path", "startLine", "endLine", "claim"}:
        return False
    path = corpus_path(corpus, value.get("path"))
    start, end = value.get("startLine"), value.get("endLine")
    return (
        path is not None
        and type(start) is int
        and type(end) is int
        and 1 <= start <= end <= line_count(path)
        and end - start + 1 <= 40
        and valid_text(value.get("claim"), 20, 1200)
    )


def intersects(evidence: dict[str, Any], anchor: tuple[str, int, int]) -> bool:
    path, start, end = anchor
    return evidence.get("path") == path and evidence.get("startLine", 0) <= end and evidence.get("endLine", 0) >= start


def primary_in(location: dict[str, Any], anchor: tuple[str, int, int]) -> bool:
    path, start, end = anchor
    return location.get("path") == path and start <= location.get("line", -1) <= end


def finding_shape(corpus: Path, finding: Any) -> bool:
    required = {
        "id", "classification", "severity", "confidence", "title", "primaryLocation",
        "evidence", "behavior", "recommendation",
    }
    if not is_plain_dict(finding) or set(finding) != required:
        return False
    behavior = finding.get("behavior")
    if not is_plain_dict(behavior) or set(behavior) != {"trigger", "actual", "expected", "impact"}:
        return False
    evidence = finding.get("evidence")
    return (
        valid_id(finding.get("id"))
        and finding.get("classification") in ALLOWED_CLASSIFICATIONS
        and finding.get("severity") in ALLOWED_SEVERITIES
        and finding.get("confidence") in ALLOWED_CONFIDENCE
        and valid_text(finding.get("title"), 12, 180)
        and valid_location(corpus, finding.get("primaryLocation"))
        and type(evidence) is list
        and 2 <= len(evidence) <= 8
        and all(valid_evidence(corpus, item) for item in evidence)
        and all(valid_text(behavior.get(field), 24, 1600) for field in behavior)
        and valid_text(finding.get("recommendation"), 30, 2400)
    )


def rejected_shape(corpus: Path, rejected: Any) -> bool:
    required = {"id", "path", "line", "category", "reason", "evidence"}
    if not is_plain_dict(rejected) or set(rejected) != required:
        return False
    location = {"path": rejected.get("path"), "line": rejected.get("line")}
    evidence = rejected.get("evidence")
    return (
        valid_id(rejected.get("id"))
        and valid_location(corpus, location)
        and rejected.get("category") in ALLOWED_REJECTIONS
        and valid_text(rejected.get("reason"), 30, 1600)
        and type(evidence) is list
        and 1 <= len(evidence) <= 4
        and all(valid_evidence(corpus, item) for item in evidence)
        and any(intersects(item, (rejected["path"], rejected["line"], rejected["line"])) for item in evidence)
    )


def unresolved_shape(corpus: Path, item: Any) -> bool:
    required = {"id", "path", "line", "question", "missingEvidence", "nextStep"}
    if not is_plain_dict(item) or set(item) != required:
        return False
    return (
        valid_id(item.get("id"))
        and valid_location(corpus, {"path": item.get("path"), "line": item.get("line")})
        and all(valid_text(item.get(key), 20, 1600) for key in ("question", "missingEvidence", "nextStep"))
    )


def find_matches(findings: list[dict[str, Any]], expected: dict[str, Any]) -> dict[str, str]:
    matches: dict[str, str] = {}
    used: set[str] = set()
    for name, spec in expected.items():
        for finding in findings:
            if finding["id"] in used or finding["classification"] != "correctness_defect":
                continue
            if not primary_in(finding["primaryLocation"], spec["primary"]):
                continue
            evidence = finding["evidence"]
            if all(any(intersects(item, anchor) for item in evidence for anchor in alternatives) for alternatives in spec["evidence"]):
                matches[name] = finding["id"]
                used.add(finding["id"])
                break
    return matches


def candidate_has_signal(corpus: Path, site: dict[str, Any]) -> bool:
    path = corpus_path(corpus, site.get("path"))
    line = site.get("line")
    if path is None or type(line) is not int:
        return False
    lines = path.read_text(encoding="utf-8").splitlines()
    if not 1 <= line <= len(lines):
        return False
    window = "\n".join(lines[max(0, line - 3): min(len(lines), line + 2)])
    return SIGNAL.search(window) is not None


def site_bound_to_record(site: dict[str, Any], records: dict[str, tuple[str, dict[str, Any]]]) -> bool:
    entry = records.get(site.get("recordId"))
    if entry is None or entry[0] != site.get("disposition"):
        return False
    kind, record = entry
    path, line = site.get("path"), site.get("line")
    if kind == "finding":
        location = record.get("primaryLocation", {})
        if location.get("path") == path and location.get("line") == line:
            return True
        return any(
            item.get("path") == path and item.get("startLine", 0) <= line <= item.get("endLine", -1)
            for item in record.get("evidence", []) if is_plain_dict(item)
        )
    if kind == "rejected":
        if record.get("path") == path and record.get("line") == line:
            return True
        return any(
            item.get("path") == path and item.get("startLine", 0) <= line <= item.get("endLine", -1)
            for item in record.get("evidence", []) if is_plain_dict(item)
        )
    return record.get("path") == path and record.get("line") == line


def check_artifacts(workspace: Path, corpus: Path) -> tuple[dict[str, bool], dict[str, Any], list[str]]:
    checks: dict[str, bool] = {}
    metrics: dict[str, Any] = {}
    details: list[str] = []
    findings_path = workspace / "work/findings.json"
    report_path = workspace / "work/report.md"
    data = load_json(findings_path)
    if not is_plain_dict(data):
        raise ValueError("findings.json root must be an object")
    checks["top_level_schema"] = set(data) == {"schemaVersion", "scope", "findings", "rejectedCandidates", "unresolved", "coverage"}
    scope = data.get("scope")
    checks["pinned_scope"] = is_plain_dict(scope) and scope == {"upstream": "apache/airflow", "commit": COMMIT}
    checks["schema_version"] = type(data.get("schemaVersion")) is int and data.get("schemaVersion") == 1

    findings = data.get("findings")
    rejected = data.get("rejectedCandidates")
    unresolved = data.get("unresolved")
    findings_list = findings if type(findings) is list else []
    rejected_list = rejected if type(rejected) is list else []
    unresolved_list = unresolved if type(unresolved) is list else []
    checks["finding_count"] = type(findings) is list and 4 <= len(findings_list) <= 16
    checks["finding_shapes"] = checks["finding_count"] and all(finding_shape(corpus, item) for item in findings_list)
    checks["rejected_count"] = type(rejected) is list and len(rejected_list) >= 8
    checks["rejected_shapes"] = checks["rejected_count"] and all(rejected_shape(corpus, item) for item in rejected_list)
    checks["unresolved_shapes"] = type(unresolved) is list and all(unresolved_shape(corpus, item) for item in unresolved_list)

    all_records = findings_list + rejected_list + unresolved_list
    ids = [item.get("id") for item in all_records if is_plain_dict(item)]
    primary_sites = [
        (item.get("primaryLocation", {}).get("path"), item.get("primaryLocation", {}).get("line"))
        for item in findings_list if is_plain_dict(item) and is_plain_dict(item.get("primaryLocation"))
    ]
    checks["unique_records"] = len(ids) == len(all_records) == len(set(ids)) and len(primary_sites) == len(set(primary_sites))

    if checks["finding_shapes"]:
        core_matches = find_matches(findings_list, EXPECTED)
        optional_matches = find_matches(findings_list, OPTIONAL_EXPECTED)
    else:
        core_matches, optional_matches = {}, {}
    checks["required_behavioral_findings"] = set(core_matches) == set(EXPECTED)
    checks["known_negatives_not_actionable"] = checks["finding_shapes"] and not any(
        primary_in(item["primaryLocation"], anchor) for item in findings_list for anchor in KNOWN_NEGATIVES
    )
    metrics["matchedRequired"] = core_matches
    metrics["matchedOptional"] = optional_matches
    matched_ids = set(core_matches.values()) | set(optional_matches.values())
    metrics["needsReview"] = [item["id"] for item in findings_list if is_plain_dict(item) and item.get("id") not in matched_ids]

    coverage = data.get("coverage")
    coverage_ok = is_plain_dict(coverage) and set(coverage) == {"areas", "reviewedPaths", "candidateSites", "searchNotes"}
    areas = coverage.get("areas", []) if is_plain_dict(coverage) else []
    reviewed = coverage.get("reviewedPaths", []) if is_plain_dict(coverage) else []
    sites = coverage.get("candidateSites", []) if is_plain_dict(coverage) else []
    checks["coverage_shape"] = (
        coverage_ok
        and type(areas) is list and len(set(areas)) >= 4 and all(valid_text(x, 3, 100) for x in areas)
        and type(reviewed) is list and len(set(reviewed)) >= 12
        and all(isinstance(x, str) and corpus_path(corpus, x) is not None for x in reviewed)
        and valid_text(coverage.get("searchNotes"), 80, 4000)
    )
    records = {item.get("id"): (kind, item) for kind, rows in (("finding", findings_list), ("rejected", rejected_list), ("unresolved", unresolved_list)) for item in rows if is_plain_dict(item)}
    site_shape = type(sites) is list and all(
        is_plain_dict(site)
        and set(site) == {"path", "line", "disposition", "recordId"}
        and valid_location(corpus, {"path": site.get("path"), "line": site.get("line")})
        and site.get("disposition") in {"finding", "rejected", "unresolved"}
        and site_bound_to_record(site, records)
        and candidate_has_signal(corpus, site)
        for site in sites
    )
    site_keys = [(site.get("path"), site.get("line")) for site in sites if is_plain_dict(site)]
    covered_ids = {site.get("recordId") for site in sites if is_plain_dict(site)}
    checks["candidate_inventory"] = (
        site_shape and len(sites) >= 30 and len(site_keys) == len(set(site_keys))
        and set(ids).issubset(covered_ids)
    )
    metrics.update({"findingCount": len(findings_list), "rejectedCount": len(rejected_list), "unresolvedCount": len(unresolved_list),
                    "candidateSiteCount": len(sites), "reviewedPathCount": len(set(reviewed)) if type(reviewed) is list else 0,
                    "areaCount": len(set(areas)) if type(areas) is list else 0})

    report = report_path.read_text(encoding="utf-8")
    report_ids = all(isinstance(item, str) and item in report for item in ids)
    path_mentions = sum(1 for path in set(reviewed) if isinstance(path, str) and path in report)
    checks["maintainer_report"] = len(report.strip()) >= 1200 and report_ids and path_mentions >= 6
    if optional_matches:
        details.append("optional calibrated finding matched: " + ", ".join(sorted(optional_matches)))
    return checks, metrics, details


def main() -> int:
    workspace = Path(os.environ["TASKGROUND_WORKSPACE"]).resolve()
    definition = Path(os.environ["TASKGROUND_DEFINITION"]).resolve()
    result_path = Path(os.environ["TASKGROUND_RESULT"]).resolve()
    checks: dict[str, bool]
    metrics: dict[str, Any]
    details: list[str]
    try:
        corpus = workspace / "corpus"
        manifest = load_json(corpus / "MANIFEST.json")
        frozen_manifest = load_json(definition / "workspace/corpus/MANIFEST.json")
        rows = manifest.get("files", []) if is_plain_dict(manifest) else []
        integrity = (
            manifest == frozen_manifest
            and type(rows) is list
            and len(rows) > 0
            and all(
                is_plain_dict(row)
                and (path := corpus_path(corpus, row.get("path"))) is not None
                and type(row.get("bytes")) is int
                and path.stat().st_size == row["bytes"]
                and isinstance(row.get("sha256"), str)
                and sha256(path) == row["sha256"]
                for row in rows
            )
        )
        checks, metrics, details = check_artifacts(workspace, corpus)
        checks = {"corpus_integrity": integrity, **checks}
    except (OSError, UnicodeError, json.JSONDecodeError, DuplicateKey, ValueError, TypeError, KeyError) as error:
        checks = {"valid_artifacts": False}
        metrics = {"errorType": type(error).__name__}
        details = [str(error)]
    except Exception as error:  # Leave a useful failure report for unexpected malformed input.
        checks = {"valid_artifacts": False}
        metrics = {"errorType": type(error).__name__, "traceback": traceback.format_exc(limit=6)}
        details = [str(error)]

    passed = bool(checks) and all(value is True for value in checks.values())
    output = {
        "schemaVersion": SCHEMA_VERSION,
        "task": TASK,
        "status": "passed" if passed else "failed",
        "checks": checks,
        "metrics": metrics,
        "details": details,
        "limitations": [
            "The verifier checks structure, bounded real-line evidence, coverage, known behavior anchors, duplicates, and calibrated negatives. It cannot fully judge explanatory semantics or whether the investigation process was independent; review the report and execution trace.",
            "Local folder separation is not a security sandbox.",
        ],
    }
    result_path.parent.mkdir(parents=True, exist_ok=True)
    result_path.write_text(json.dumps(output, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(output, sort_keys=True))
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
