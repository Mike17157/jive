"""Stable public result formatting."""

from __future__ import annotations

from typing import Any

from .reader import field


def format_line(line: str) -> dict[str, Any]:
    """Build the documented result object from an encoded trace line."""
    return {
        "id": field(line, "id"),
        "timestamp": int(field(line, "timestamp")),
        "service": field(line, "service"),
        "level": field(line, "level"),
        "message": field(line, "message"),
        "tags": list(field(line, "tags")),
    }
