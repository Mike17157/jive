"""Local policy examples; these are not Prefect source or scored defects."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any


def emit_optional_metric(send: Callable[[dict[str, Any]], None], metric: dict[str, Any]) -> bool:
    """EXPECTED: observability is explicitly best effort and reports non-delivery."""
    try:
        send(metric)
    except Exception:
        return False
    return True


def conservative_capacity(read_limit: Callable[[], int]) -> int:
    """EXPECTED: platform probing has a documented, conservative safe default."""
    try:
        return read_limit()
    except Exception:
        return 64
