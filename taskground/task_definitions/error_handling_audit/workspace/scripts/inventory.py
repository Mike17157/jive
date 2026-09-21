#!/usr/bin/env python3
"""Enumerate broad handlers in the fixed primary audit scope."""

from __future__ import annotations

import ast
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PATHS = (
    "prefect/src/prefect/server/utilities/user_templates.py",
    "prefect/src/prefect/server/events/actions.py",
    "prefect/src/prefect/server/events/models/automations.py",
    "prefect/src/prefect/server/orchestration/core_policy.py",
    "prefect/src/prefect/server/orchestration/rules.py",
    "prefect/src/prefect/utilities/schema_tools/hydration.py",
    "prefect/src/prefect/task_runners.py",
    "prefect/src/prefect/futures.py",
    "prefect/src/prefect/events/utilities.py",
    "prefect/src/prefect/_internal/analytics/client.py",
    "prefect/src/prefect/utilities/filesystem.py",
    "prefect/src/integrations/prefect-docker/prefect_docker/worker.py",
)


class Visitor(ast.NodeVisitor):
    def __init__(self, path: str) -> None:
        self.path = path
        self.stack: list[str] = []
        self.rows: list[dict[str, object]] = []

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        self.stack.append(node.name)
        self.generic_visit(node)
        self.stack.pop()

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self.stack.append(node.name)
        self.generic_visit(node)
        self.stack.pop()

    visit_AsyncFunctionDef = visit_FunctionDef

    def visit_ExceptHandler(self, node: ast.ExceptHandler) -> None:
        caught = ast.unparse(node.type) if node.type is not None else "bare"
        if caught == "bare" or "Exception" in caught:
            self.rows.append(
                {
                    "path": self.path,
                    "line": node.lineno,
                    "symbol": ".".join(self.stack) or "<module>",
                    "caught": caught,
                }
            )
        self.generic_visit(node)


def main() -> None:
    rows: list[dict[str, object]] = []
    for relative in PATHS:
        visitor = Visitor(relative)
        visitor.visit(ast.parse((ROOT / relative).read_text(encoding="utf-8")))
        rows.extend(visitor.rows)
    print(json.dumps({"files": len(PATHS), "broadHandlers": len(rows), "handlers": rows}, indent=2))


if __name__ == "__main__":
    main()
