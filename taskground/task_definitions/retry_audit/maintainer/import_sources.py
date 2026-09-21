#!/usr/bin/env python3
"""Import the pinned Apache Airflow audit corpus and write its checksum manifest.

This maintainer utility requires network access. Prepared task workspaces do not.
"""

from __future__ import annotations

import hashlib
import json
import urllib.request
from pathlib import Path


COMMIT = "ecfa5a139c35f365836c0f462029537023d0357e"
RAW_ROOT = f"https://raw.githubusercontent.com/apache/airflow/{COMMIT}/"
DEFINITION = Path(__file__).resolve().parents[1]
CORPUS = DEFINITION / "workspace" / "corpus"

PATHS = """
LICENSE
NOTICE
airflow/sensors/base.py
tests/sensors/test_base.py
airflow/providers/amazon/aws/executors/ecs/ecs_executor.py
airflow/providers/amazon/aws/executors/ecs/utils.py
airflow/providers/amazon/aws/executors/utils/exponential_backoff_retry.py
tests/providers/amazon/aws/executors/ecs/test_ecs_executor.py
tests/providers/amazon/aws/executors/utils/test_exponential_backoff_retry.py
airflow/providers/amazon/aws/executors/batch/batch_executor.py
airflow/providers/amazon/aws/executors/batch/utils.py
tests/providers/amazon/aws/executors/batch/test_batch_executor.py
airflow/providers/amazon/aws/operators/batch.py
tests/providers/amazon/aws/operators/test_batch.py
airflow/providers/amazon/aws/operators/emr.py
airflow/providers/amazon/aws/triggers/emr.py
airflow/providers/amazon/aws/sensors/emr.py
airflow/providers/amazon/aws/hooks/emr.py
tests/providers/amazon/aws/hooks/test_emr.py
tests/providers/amazon/aws/hooks/test_emr_containers.py
tests/providers/amazon/aws/operators/test_emr_containers.py
tests/providers/amazon/aws/sensors/test_emr_containers.py
tests/providers/amazon/aws/triggers/test_serialization.py
airflow/providers/amazon/aws/hooks/batch_client.py
tests/providers/amazon/aws/hooks/test_batch_client.py
airflow/providers/amazon/aws/hooks/base_aws.py
tests/providers/amazon/aws/hooks/test_base_aws.py
airflow/providers/amazon/aws/utils/waiter.py
airflow/providers/amazon/aws/utils/waiter_with_logging.py
tests/providers/amazon/aws/utils/test_waiter_with_logging.py
airflow/providers/amazon/aws/operators/ecs.py
airflow/providers/amazon/aws/triggers/ecs.py
tests/providers/amazon/aws/operators/test_ecs.py
tests/providers/amazon/aws/triggers/test_ecs.py
airflow/providers/amazon/aws/hooks/quicksight.py
airflow/providers/amazon/aws/hooks/glue.py
airflow/providers/amazon/aws/hooks/athena.py
airflow/providers/google/common/hooks/base_google.py
tests/providers/google/common/hooks/test_base_google.py
airflow/providers/google/cloud/hooks/bigquery.py
tests/providers/google/cloud/hooks/test_bigquery.py
airflow/providers/google/cloud/hooks/gcs.py
airflow/providers/google/cloud/hooks/compute.py
airflow/providers/http/hooks/http.py
airflow/providers/http/triggers/http.py
tests/providers/http/hooks/test_http.py
tests/providers/http/triggers/test_http.py
airflow/providers/databricks/hooks/databricks_base.py
airflow/providers/databricks/hooks/databricks.py
airflow/providers/databricks/triggers/databricks.py
tests/providers/databricks/hooks/test_databricks.py
tests/providers/databricks/triggers/test_databricks.py
airflow/providers/apache/livy/hooks/livy.py
airflow/providers/apache/livy/triggers/livy.py
tests/providers/apache/livy/hooks/test_livy.py
tests/providers/apache/livy/triggers/test_livy.py
airflow/providers/cncf/kubernetes/utils/pod_manager.py
airflow/providers/cncf/kubernetes/operators/pod.py
tests/providers/cncf/kubernetes/utils/test_pod_manager.py
airflow/providers/sftp/hooks/sftp.py
tests/providers/sftp/hooks/test_sftp.py
airflow/providers/slack/hooks/slack.py
airflow/providers/slack/hooks/slack_webhook.py
tests/providers/slack/hooks/test_slack.py
tests/providers/slack/hooks/test_slack_webhook.py
""".strip().splitlines()


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def main() -> None:
    records = []
    for relative in PATHS:
        with urllib.request.urlopen(RAW_ROOT + relative, timeout=60) as response:
            data = response.read()
        destination = CORPUS / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
        records.append(
            {
                "path": relative,
                "bytes": len(data),
                "sha256": sha256(data),
                "source": RAW_ROOT + relative,
            }
        )

    manifest = {
        "schemaVersion": 1,
        "upstream": "apache/airflow",
        "commit": COMMIT,
        "license": "Apache-2.0",
        "files": records,
    }
    encoded = (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode()
    (CORPUS / "MANIFEST.json").write_bytes(encoded)
    print(json.dumps({"files": len(records), "bytes": sum(r["bytes"] for r in records), "manifestSha256": sha256(encoded)}))


if __name__ == "__main__":
    main()
