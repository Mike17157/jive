"""Public search orchestration."""

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path
from typing import Any

from .filters import matches
from .formatter import format_line
from .reader import iter_lines


def search(path: str | Path, query: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Search *path* and return normalized matching records in file order."""
    limit = query.get("limit")
    if limit is not None:
        limit = int(limit)
        if limit < 0:
            raise ValueError("limit must be non-negative")
        if limit == 0:
            return []

    results: list[dict[str, Any]] = []
    for line in iter_lines(path):
        if matches(line, query):
            results.append(format_line(line))
            if limit is not None and len(results) >= limit:
                break
    return results
