"""Trace predicates."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from .reader import field, normalize_text


def _normalized_set(values: Any) -> set[str]:
    return {normalize_text(value) for value in values}


def matches(line: str, query: Mapping[str, Any]) -> bool:
    """Return whether an encoded trace line satisfies *query*."""
    if "min_timestamp" in query and int(field(line, "timestamp")) < int(query["min_timestamp"]):
        return False
    if "max_timestamp" in query and int(field(line, "timestamp")) > int(query["max_timestamp"]):
        return False
    if query.get("levels") and field(line, "level") not in _normalized_set(query["levels"]):
        return False
    if query.get("services") and field(line, "service") not in _normalized_set(query["services"]):
        return False
    if query.get("tags"):
        record_tags = set(field(line, "tags"))
        if not _normalized_set(query["tags"]).issubset(record_tags):
            return False
    if query.get("terms"):
        message = field(line, "message")
        if not all(normalize_text(term) in message for term in query["terms"]):
            return False
    return True
