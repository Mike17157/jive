"""Local contract illustrations for the audit; not Apache Airflow source.

These small examples are original task material. They demonstrate two invariants
used by POLICY.md and are not seeded scored findings.
"""

from collections import deque
from dataclasses import dataclass


@dataclass
class Pending:
    name: str
    ready_at: int


def visit_pending_once(queue: deque[Pending], now: int) -> list[str]:
    """Attempt ready work once while retaining ownership of delayed work."""
    attempted: list[str] = []
    for _ in range(len(queue)):
        item = queue.popleft()
        if item.ready_at > now:
            queue.append(item)
            continue
        attempted.append(item.name)
    return attempted


def total_attempts(retries_after_first: int) -> range:
    """Make the retry-count convention explicit at an API boundary."""
    if retries_after_first < 0:
        raise ValueError("retries_after_first must be non-negative")
    return range(1, retries_after_first + 2)
