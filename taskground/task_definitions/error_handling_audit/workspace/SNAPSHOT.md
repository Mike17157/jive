# Snapshot and retained context

- Prefect source and tests: `PrefectHQ/prefect` commit `d1d0f4d663f4b421fccaa78fda0cd1fd70da7f0f`, dated 2026-03-09. The retained source files are exact copies; the Apache-2.0 license is in `prefect/LICENSE`.
- docker-py dependency: release `7.1.0`, the version locked by that Prefect commit. `third_party/docker_py_7_1_0/docker/models/images.py` and its Apache-2.0 license are retained.
- CPython callback contract: release `v3.12.10`. `third_party/cpython_3_12_10/Lib/concurrent/futures/_base.py` and the PSF license are retained. Prefect supports Python 3.10 through 3.13 at this snapshot; this representative supported implementation makes callback behavior auditable offline.

The fixture contains selected source and tests, not a runnable Prefect checkout. Tests are evidence of established contracts and missing failure coverage. The Taskground authors added only the audit instructions, inventory helper, expected-behavior examples, and empty `work/` area.
