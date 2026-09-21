from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from tracequery import search


class SearchTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.path = Path(self.temporary.name) / "small.jsonl"
        records = [
            {"id": " A ", "timestamp": 10, "service": " API ", "level": "INFO", "message": " Café READY ", "tags": ["Prod", "Blue"], "ignored": {"owner": "ALICE"}},
            {"id": "B", "timestamp": 11, "service": "worker", "level": "WARN", "message": "retry later", "tags": ["prod", "batch"]},
            {"id": "B", "timestamp": 11, "service": "worker", "level": "WARN", "message": "retry later", "tags": ["prod", "batch"]},
            {"id": "Ｃ", "timestamp": 12, "service": "API", "level": "ERROR", "message": "CAFÉ failed", "tags": ["prod", "Blue", "Blue"]},
        ]
        with self.path.open("w", encoding="utf-8") as handle:
            handle.write("\n")
            for record in records:
                handle.write(json.dumps(record, ensure_ascii=False) + "\n")

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_filters_normalizes_unicode_and_text(self) -> None:
        rows = search(self.path, {"services": ["ａｐｉ"], "tags": [" BLUE "], "terms": ["cafe\u0301"]})
        self.assertEqual([row["id"] for row in rows], ["a", "c"])
        self.assertEqual(rows[0], {
            "id": "a", "timestamp": 10, "service": "api", "level": "info",
            "message": "café ready", "tags": ["prod", "blue"],
        })
        self.assertEqual(rows[1]["tags"], ["prod", "blue", "blue"])

    def test_preserves_duplicate_rows_and_order(self) -> None:
        rows = search(self.path, {"levels": ["warn"]})
        self.assertEqual([row["id"] for row in rows], ["b", "b"])

    def test_bounds_all_terms_and_limit(self) -> None:
        rows = search(self.path, {
            "min_timestamp": 10, "max_timestamp": 12,
            "levels": ["info", "error"], "terms": ["café", "a"], "limit": 1,
        })
        self.assertEqual([row["id"] for row in rows], ["a"])
        self.assertEqual(search(self.path, {"limit": 0}), [])
        with self.assertRaises(ValueError):
            search(self.path, {"limit": -1})


if __name__ == "__main__":
    unittest.main()
