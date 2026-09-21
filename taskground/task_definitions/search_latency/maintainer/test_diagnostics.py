from __future__ import annotations

import argparse
import json
import io
import pstats
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

WORKSPACE = Path(__file__).resolve().parents[1] / "workspace"
sys.path.insert(0, str(WORKSPACE))

from scripts import diagnose
from scripts.support import build_workload, execute_workload, run_measurement
from searchapp import SearchService


class DiagnosticHarnessTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.data = self.root / "traces.jsonl"
        records = []
        for tenant in ("alpha", "beta", "gamma"):
            records.extend([
                {
                    "tenant": tenant, "id": f"{tenant}-api", "timestamp": 1_720_000_000,
                    "service": "api", "level": "info", "message": "needle café",
                    "tags": ["prod", "zone-0"],
                },
                {
                    "tenant": tenant, "id": f"{tenant}-worker", "timestamp": 1_720_000_211,
                    "service": "worker", "level": "warn", "message": "needle worker",
                    "tags": ["prod", "zone-1"],
                },
                {
                    "tenant": tenant, "id": f"{tenant}-search", "timestamp": 1_720_000_422,
                    "service": "search", "level": "error", "message": "needle search",
                    "tags": ["prod", "zone-2"],
                },
            ])
        with self.data.open("w", encoding="utf-8", newline="\n") as handle:
            for record in records:
                handle.write(json.dumps(record, ensure_ascii=False) + "\n")

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def args(self, **overrides) -> argparse.Namespace:
        values = {
            "workload": "concurrent",
            "query_reuse": 6, "window_width": 64, "ingest_every": None, "ingest_batch_size": 24,
            "requests": 4,
            "workers": 2,
            "audit": True,
            "cache": True,
            "audit_batch_size": 3,
            "output": self.root / "work",
            "data": self.data,
        }
        values.update(overrides)
        values["output"].mkdir(parents=True, exist_ok=True)
        return argparse.Namespace(**values)

    def test_threaded_profile_contains_worker_search_stack_and_provenance(self) -> None:
        args = self.args()
        diagnose.profile(args)

        artifact = json.loads((args.output / "profile.json").read_text(encoding="utf-8"))
        self.assertEqual(artifact["profileMode"], "per-request-worker-aggregate")
        self.assertEqual(artifact["profileSessionsMerged"], 4)
        self.assertTrue(artifact["auditEnabled"])
        self.assertTrue(artifact["cacheEnabled"])
        self.assertEqual(artifact["auditBatchSize"], 3)
        self.assertIn("summed across task profiles", artifact["profileTimingInterpretation"])

        stats = pstats.Stats(str(args.output / "profile.pstats"))
        functions = {(Path(filename).name, function) for filename, _, function in stats.stats}
        self.assertIn(("service.py", "handle"), functions)
        self.assertIn(("query.py", "select"), functions)

    def test_serial_profile_keeps_single_profile_session(self) -> None:
        args = self.args(workload="warm", requests=2, workers=1)
        diagnose.profile(args)
        artifact = json.loads((args.output / "profile.json").read_text(encoding="utf-8"))
        self.assertEqual(artifact["profileMode"], "serial-main-thread")
        self.assertEqual(artifact["profileSessionsMerged"], 1)

    def test_benchmark_rejects_inconsistent_response_digests(self) -> None:
        args = self.args(workload="mixed", workers=1)
        summaries = [
            ({
                "elapsedSeconds": 0.01,
                "requestLatenciesSeconds": [0.001],
                "responseDigest": digest,
            }, [])
            for digest in ("digest-a", "digest-b", "digest-a")
        ]
        with patch.object(diagnose, "run_measurement", side_effect=summaries):
            with self.assertRaisesRegex(RuntimeError, "response digests differ"):
                diagnose.benchmark(args)
        self.assertFalse((args.output / "benchmark.json").exists())

    def test_compare_runs_only_selected_control_and_retains_digests(self) -> None:
        args = self.args(workload="dashboard", workers=1, requests=12, vary="audit", values=["on", "off"])
        diagnose.compare(args)
        artifact = json.loads((args.output / "compare.json").read_text())
        self.assertEqual(artifact["variable"], "audit")
        self.assertEqual(set(artifact["configurations"]), {"on", "off"})
        self.assertTrue(artifact["sameResponseDigest"])
        self.assertTrue(artifact["configurations"]["on"]["auditEnabled"])
        self.assertFalse(artifact["configurations"]["off"]["auditEnabled"])
        for value in artifact["configurations"].values():
            self.assertEqual(value["groups"]["dashboard"]["requests"], 12)
            self.assertEqual(value["groups"]["dashboard"]["metrics"]["scans"], value["metrics"]["scans"])

    def test_selectivity_changes_only_window_width(self) -> None:
        narrow = build_workload("exploratory", 12, window_width=17)
        wide = build_workload("exploratory", 12, window_width=311)
        for left, right in zip(narrow, wide):
            self.assertEqual(left["tenant"], right["tenant"])
            self.assertEqual(left["query"]["min_timestamp"], right["query"]["min_timestamp"])
            self.assertEqual(right["query"]["max_timestamp"] - left["query"]["max_timestamp"], 294)
        self.assertEqual(len({json.dumps(p["query"], sort_keys=True) for p in narrow}), 12)

    def test_compare_requires_chosen_variable_and_distinct_values(self) -> None:
        with patch.object(sys, "argv", ["diagnose.py", "compare"]), patch.object(sys, "stderr", io.StringIO()):
            with self.assertRaises(SystemExit):
                diagnose.parse_args()
        for values in (["on"], ["on", "on"]):
            with self.assertRaisesRegex(ValueError, "distinct"):
                diagnose.compare(self.args(vary="audit", values=values))

    def test_ingestion_barriers_preserve_serial_and_concurrent_freshness(self) -> None:
        payloads = [{"request_id": str(i), "tenant": "beta", "query": {}} for i in range(6)]
        results = []
        for workers in (1, 3):
            service = SearchService(self.data)
            try:
                responses, _, _ = execute_workload(service, payloads, workers, 2, 4)
                self.assertEqual([len(r["rows"]) for r in responses], [3, 3, 7, 7, 7, 7])
                self.assertEqual(len(service.audit_records()), 6)
                results.append(responses)
            finally:
                service.close()
        self.assertEqual(results[0], results[1])

    def test_mixed_group_and_phase_totals_match_request_population(self) -> None:
        recorder = diagnose.EventRecorder()
        summary, _ = run_measurement(self.data, requests=12, ingest_every=4, recorder=recorder)
        self.assertEqual({k: v["requests"] for k, v in summary["groups"].items()},
                         {"dashboard": 6, "exploratory": 6})
        self.assertEqual([p["afterIngestion"] for p in summary["phases"]], [False, True, True])
        self.assertEqual(sum(g["requests"] for p in summary["phases"] for g in p["groups"].values()), 12)
        events = recorder.snapshot()
        self.assertEqual(sum(e.get("event") == "commit" and e.get("collection") == "traces" for e in events), 2)
        self.assertGreater(summary["lifecycleSeconds"], summary["elapsedSeconds"])

    def test_uninstrumented_benchmark_does_not_invent_zero_scan_counts(self) -> None:
        args = self.args(workload="mixed", workers=1, requests=6)
        diagnose.benchmark(args)
        artifact = json.loads((args.output / "benchmark.json").read_text())
        self.assertEqual(len(artifact["groupSamples"]), 3)
        for groups in artifact["groupSamples"]:
            self.assertEqual(sum(g["requests"] for g in groups.values()), 6)
            self.assertTrue(all(g["metrics"] is None for g in groups.values()))
        self.assertEqual(len(artifact["phaseSamples"]), 3)

    def test_request_count_must_be_positive(self) -> None:
        with self.assertRaises(argparse.ArgumentTypeError):
            diagnose.positive_integer("0")
        with self.assertRaises(argparse.ArgumentTypeError):
            diagnose.positive_integer("-2")
        self.assertEqual(diagnose.positive_integer("1"), 1)


if __name__ == "__main__":
    unittest.main()
