# Maintainer validation

Run the offline smoke suite from any directory:

```sh
python3 taskground/task_definitions/error_handling_audit/maintainer/smoke.py
```

It verifies that the checked-in reference findings and report pass, while missing, malformed, semantically wrong, known-safe-as-defect, blanket, and source-tampered submissions fail. It uses only the Python standard library and a temporary workspace.
