from __future__ import annotations

import json
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from searchapp import SearchService


class SearchServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.path = Path(self.temporary.name) / "records.jsonl"
        self.records = [
            {
                "tenant": "alpha", "id": " A ", "timestamp": 10,
                "service": " API ", "level": "INFO", "message": " Café READY ",
                "tags": ["Prod", "Blue"], "context": {"owner": "ignored"},
            },
            {
                "tenant": "alpha", "id": "B", "timestamp": 11,
                "service": "worker", "level": "WARN", "message": "retry café later",
                "tags": ["prod", "batch"],
            },
            {
                "tenant": "alpha", "id": "B", "timestamp": 11,
                "service": "worker", "level": "WARN", "message": "retry café later",
                "tags": ["prod", "batch"],
            },
            {
                "tenant": "alpha", "id": "Ｃ", "timestamp": 12,
                "service": "API", "level": "ERROR", "message": "CAFÉ failed ready",
                "tags": ["prod", "Blue", "Blue"],
            },
            {
                "tenant": "beta", "id": "private", "timestamp": 10,
                "service": "api", "level": "info", "message": "café ready",
                "tags": ["prod", "blue"],
            },
        ]
        with self.path.open("w", encoding="utf-8", newline="\n") as handle:
            handle.write("\n")
            for record in self.records:
                handle.write(json.dumps(record, ensure_ascii=False) + "\n")
        self.services: list[SearchService] = []

    def tearDown(self) -> None:
        for service in self.services:
            service.close()
        self.temporary.cleanup()

    def service(self, **options) -> SearchService:
        instance = SearchService(self.path, **options)
        self.services.append(instance)
        return instance

    @staticmethod
    def request(request_id: str, tenant: str = "alpha", query=None) -> dict:
        return {"request_id": request_id, "tenant": tenant, "query": query or {}}

    def test_query_semantics_and_exact_response_shape(self) -> None:
        service = self.service(audit_enabled=False)
        response = service.handle(self.request("normalized", query={
            "services": [" ａｐｉ "],
            "levels": ["info", "ERROR"],
            "tags": [" BLUE "],
            "terms": ["cafe\u0301", "ready"],
            "min_timestamp": 10,
            "max_timestamp": 12,
            "unused": "ignored",
        }))

        self.assertEqual(list(response), ["request_id", "tenant", "rows"])
        self.assertEqual(response["request_id"], "normalized")
        self.assertEqual(response["tenant"], "alpha")
        self.assertEqual([row["id"] for row in response["rows"]], ["a", "c"])
        self.assertEqual(list(response["rows"][0]), [
            "id", "timestamp", "service", "level", "message", "tags",
        ])
        self.assertEqual(response["rows"][0], {
            "id": "a", "timestamp": 10, "service": "api", "level": "info",
            "message": "café ready", "tags": ["prod", "blue"],
        })
        self.assertEqual(response["rows"][1]["tags"], ["prod", "blue", "blue"])

    def test_order_duplicates_bounds_limit_and_tenant_isolation(self) -> None:
        service = self.service(audit_enabled=False)
        duplicate_rows = service.handle(self.request("duplicates", query={
            "levels": ["warn"], "terms": ["retry", "café"],
        }))["rows"]
        self.assertEqual([row["id"] for row in duplicate_rows], ["b", "b"])

        limited = service.handle(self.request("limited", query={
            "min_timestamp": 10, "max_timestamp": 12, "limit": 1,
        }))["rows"]
        self.assertEqual([row["id"] for row in limited], ["a"])
        self.assertEqual(service.handle(self.request("zero", query={"limit": 0}))["rows"], [])
        with self.assertRaises(ValueError):
            service.handle(self.request("negative", query={"limit": -1}))

        beta = service.handle(self.request("beta", tenant="beta"))["rows"]
        missing = service.handle(self.request("missing", tenant="absent"))["rows"]
        self.assertEqual([row["id"] for row in beta], ["private"])
        self.assertEqual(missing, [])

    def test_cache_hits_are_audited_and_flush_does_not_duplicate(self) -> None:
        events: list[dict] = []
        event_lock = threading.Lock()

        def record(event: dict) -> None:
            with event_lock:
                events.append(dict(event))

        service = self.service(audit_batch_size=2, recorder=record)
        query = {"terms": ["café"], "limit": 2}
        first = service.handle(self.request("first", query=query))
        second = service.handle(self.request("second", query=query))
        self.assertEqual(first["rows"], second["rows"])
        self.assertEqual(
            [event["hit"] for event in events if event.get("event") == "cache"],
            [False, True],
        )
        self.assertEqual(service.audit_records(), [
            {"request_id": "first", "tenant": "alpha", "row_count": 2},
            {"request_id": "second", "tenant": "alpha", "row_count": 2},
        ])
        service.handle(self.request("pending", query=query))
        self.assertEqual(len(service.audit_records()), 2)
        service.flush_audit()
        self.assertEqual(service.audit_records()[-1], {
            "request_id": "pending", "tenant": "alpha", "row_count": 2,
        })
        service.flush_audit()
        self.assertEqual(len(service.audit_records()), 3)

    def test_ingestion_is_tenant_scoped_and_invalidates_cached_results(self) -> None:
        service = self.service(audit_enabled=False)
        query = {"terms": ["fresh marker"]}
        self.assertEqual(service.handle(self.request("before", query=query))["rows"], [])
        service.ingest("alpha", [{
            "id": "new", "timestamp": 20, "service": "search", "level": "info",
            "message": "fresh marker arrived", "tags": ["prod", "zone-1"],
        }])
        after = service.handle(self.request("after", query=query))["rows"]
        self.assertEqual([row["id"] for row in after], ["new"])
        self.assertEqual(
            service.handle(self.request("beta-after", tenant="beta", query=query))["rows"],
            [],
        )

    def test_responses_are_independent_mutable_copies(self) -> None:
        service = self.service(audit_enabled=False)
        query = {"services": ["api"]}
        first = service.handle(self.request("copy-one", query=query))
        first["rows"][0]["message"] = "changed"
        first["rows"][0]["tags"].append("changed")
        first["rows"].append({"id": "invented"})

        second = service.handle(self.request("copy-two", query=query))
        self.assertEqual(second["request_id"], "copy-two")
        self.assertEqual([row["id"] for row in second["rows"]], ["a", "c"])
        self.assertEqual(second["rows"][0]["message"], "café ready")
        self.assertEqual(second["rows"][0]["tags"], ["prod", "blue"])

    def test_concurrent_calls_on_one_service_are_complete_and_audited(self) -> None:
        service = self.service(audit_batch_size=4)
        requests = [
            self.request(f"parallel-{index}", query={"levels": ["warn"]})
            for index in range(32)
        ]
        with ThreadPoolExecutor(max_workers=8) as executor:
            responses = list(executor.map(service.handle, requests))

        self.assertEqual(len(responses), 32)
        for index, response in enumerate(responses):
            self.assertEqual(response["request_id"], f"parallel-{index}")
            self.assertEqual([row["id"] for row in response["rows"]], ["b", "b"])
        service.flush_audit()
        audit = service.audit_records()
        self.assertEqual(len(audit), 32)
        self.assertEqual({entry["request_id"] for entry in audit}, {
            f"parallel-{index}" for index in range(32)
        })


if __name__ == "__main__":
    unittest.main()
