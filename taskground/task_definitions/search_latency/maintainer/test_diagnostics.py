from __future__ import annotations

import argparse
import json
import pstats
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

WORKSPACE = Path(__file__).resolve().parents[1] / "workspace"
sys.path.insert(0, str(WORKSPACE))

from scripts import diagnose


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

    def test_request_count_must_be_positive(self) -> None:
        with self.assertRaises(argparse.ArgumentTypeError):
            diagnose.positive_integer("0")
        with self.assertRaises(argparse.ArgumentTypeError):
            diagnose.positive_integer("-2")
        self.assertEqual(diagnose.positive_integer("1"), 1)


if __name__ == "__main__":
    unittest.main()
