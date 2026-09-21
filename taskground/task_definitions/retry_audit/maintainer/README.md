# Maintainer notes

Run the deterministic fixture calibration with:

```sh
python3 taskground/task_definitions/retry_audit/maintainer/smoke.py
```

The smoke accepts the reference audit and rejects an empty submission, a wrong classification, a blanket report that promotes a known healthy implementation, malformed JSON, duplicate JSON keys, and a modified corpus file. It uses only the Python standard library and makes no network calls.

`import_sources.py` is the networked maintainer regeneration utility. It downloads every file from the commit pinned in that script and rewrites `workspace/corpus/MANIFEST.json`. After any intentional corpus change, update the counts and manifest digest in `SOURCE.json`, then rerun smoke. Prepared task workspaces do not run the importer.

The verifier's behavioral anchors are maintainer-only calibration. They require evidence spanning the defective control flow and a relevant helper, caller, or test; exact prose is not graded. The narrative quality and the independence of the investigation still require trace review, as recorded in verifier limitations.
