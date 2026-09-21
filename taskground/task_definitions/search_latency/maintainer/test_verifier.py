"""Verify that independent workload and shifted-work gates cannot be bypassed."""
from __future__ import annotations

import copy
import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

DEFINITION = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("latency_verifier_tests", DEFINITION / "verifier/verify.py")
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)


class PerformanceGateTests(unittest.TestCase):
    def check_candidate(self, **overrides):
        original, candidate = object(), object()
        response = {"request_id": "r", "tenant": "absent", "rows": []}
        base = {"elapsedSeconds": 1., "loadSeconds": .1, "ingestSeconds": .001,
                "lifecycleSeconds": 1.1, "responseDigest": verify.digest_responses([response]),
                "auditMatches": True, "rows": 0}

        def sample(service, path, operations):
            result = dict(base)
            if service is candidate:
                result.update(elapsedSeconds=.1, lifecycleSeconds=.2)
                result.update(overrides)
            return result

        with tempfile.TemporaryDirectory() as directory:
            with patch.object(verify, "perf_records", return_value=[]), \
                 patch.object(verify, "perf_operations", return_value=[{"request_id": "r", "tenant": "absent", "query": {}}]), \
                 patch.object(verify, "run_perf_sample", side_effect=sample):
                return verify.check_performance(candidate, original, Path(directory))

    def test_fast_correct_candidate_passes_each_workload(self):
        passed, _, metrics = self.check_candidate()
        self.assertTrue(passed)
        self.assertEqual(set(metrics["workloads"]), {"dashboard", "exploratory", "mixed"})
        self.assertTrue(all(w["passed"] for w in metrics["workloads"].values()))

    def test_work_shifted_to_load_ingest_or_lifecycle_is_rejected(self):
        for cost in ({"loadSeconds": 10.}, {"ingestSeconds": 1.}, {"lifecycleSeconds": 10.}):
            with self.subTest(cost=cost):
                passed, _, metrics = self.check_candidate(**cost)
                self.assertFalse(passed)
                self.assertTrue(all(not w["costsPassed"] for w in metrics["workloads"].values()))

    def test_speed_does_not_excuse_wrong_responses_or_missing_audits(self):
        for result in ({"responseDigest": "incorrect"}, {"auditMatches": False}):
            with self.subTest(result=result):
                passed, _, metrics = self.check_candidate(**result)
                self.assertFalse(passed)
                self.assertTrue(all(not w["responsesMatch"] for w in metrics["workloads"].values()))

    def test_missing_exploratory_benchmark_is_rejected(self):
        # Exercise the evidence contract without depending on a measured fixture.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            work = root / "work"
            work.mkdir()
            for name in ("profile.pstats", "profile.txt", "report.md"):
                (work / name).write_text("present")
            benchmark = {"schemaVersion": 1, "command": "benchmark", "workload": "mixed",
                         "requestsPerSample": 72, "workers": 1, "auditEnabled": True, "cacheEnabled": True,
                         "samplesSeconds": [1., 1., 1.], "medianSeconds": 1.,
                         "p50RequestSeconds": .01, "p95RequestSeconds": .02,
                         "responseDigest": "0123456789abcdef", "responseDigests": ["0123456789abcdef"] * 3,
                         "parameters": {"query_reuse": 6, "window_width": 64, "ingest_every": 24, "ingest_batch_size": 24},
                         "loadSamplesSeconds": [.1] * 3, "lifecycleSamplesSeconds": [1.1] * 3}
            (work / "benchmark.json").write_text(verify.json.dumps(benchmark))
            dashboard = copy.deepcopy(benchmark)
            dashboard["workload"] = "dashboard"
            dashboard["parameters"]["ingest_every"] = 0
            (work / "dashboard").mkdir()
            (work / "dashboard/benchmark.json").write_text(verify.json.dumps(dashboard))
            with patch.object(verify.pstats, "Stats"):
                passed, detail, _ = verify.check_evidence(root)
            self.assertFalse(passed)
            self.assertIn("exploratory/benchmark.json", detail)


if __name__ == "__main__":
    unittest.main()
