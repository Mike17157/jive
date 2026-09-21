"""Read and normalize trace records."""

from __future__ import annotations

import json
import unicodedata
from collections.abc import Iterator
from pathlib import Path
from typing import Any


def normalize_text(value: Any) -> str:
    """Return the canonical representation used by search and output."""
    return unicodedata.normalize("NFKC", str(value)).casefold().strip()


def _normalize_value(value: Any) -> Any:
    """Normalize every string in a decoded JSON value.

    Trace payloads may contain nested context that is not part of search output.
    Normalizing it keeps record handling uniform.
    """
    if isinstance(value, str):
        return normalize_text(value)
    if isinstance(value, list):
        return [_normalize_value(item) for item in value]
    if isinstance(value, dict):
        return {key: _normalize_value(item) for key, item in value.items()}
    return value


def decode_line(line: str) -> dict[str, Any]:
    """Decode and normalize one JSONL record."""
    record = json.loads(line)
    return _normalize_value(record)


def field(line: str, name: str) -> Any:
    """Read one normalized field from an encoded line."""
    return decode_line(line)[name]


def iter_lines(path: str | Path) -> Iterator[str]:
    """Yield non-blank encoded records in file order."""
    with Path(path).open("r", encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                yield line
