# Maintainer validation

Run the offline smoke suite from any directory:

```sh
python3 taskground/task_definitions/error_handling_audit/maintainer/smoke.py
```

It verifies that the checked-in reference findings and report pass, including after agent session artifacts appear under the workspace's `.jev/`, `.context/`, and `.cache/` directories. Missing, malformed, semantically wrong, known-safe-as-defect, blanket, source-tampered, and added-source submissions fail. Runtime directory exclusions apply only at the workspace root. It uses only the Python standard library and a temporary workspace.
