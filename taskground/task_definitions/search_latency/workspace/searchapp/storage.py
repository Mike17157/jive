"""A local document store with atomic reads, appends, and commit revisions.

Documents remain encoded until read, matching a serialized storage boundary.
Trace and audit collections share the transaction coordinator. A service owns
its store; modifications live for that service's lifetime, not in the seed file.
"""

import json
from contextlib import contextmanager
from pathlib import Path
from threading import RLock


class DocumentStore:
    def __init__(self, path, telemetry):
        self.telemetry = telemetry
        self._lock = RLock()
        self._traces = {}
        self._audit = []
        self._revision = 0
        self._tenant_revisions = {}
        with Path(path).open(encoding="utf-8") as source:
            for line in source:
                if not line.strip():
                    continue
                record = json.loads(line)
                tenant = record["tenant"]
                self._traces.setdefault(tenant, []).append(line)
                self._tenant_revisions.setdefault(tenant, 0)

    @contextmanager
    def transaction(self, request_id=None):
        with self.telemetry.span("lock.wait", request_id=request_id):
            self._lock.acquire()
        try:
            yield
        finally:
            self._lock.release()

    @property
    def revision(self):
        return self._revision

    def tenant_revision(self, tenant):
        return self._tenant_revisions.get(tenant, 0)

    def scan(self, tenant, request_id):
        # The caller holds a transaction while consuming the iterator.
        decoded = 0
        try:
            with self.telemetry.span("storage.scan", tenant=tenant, request_id=request_id):
                for line in self._traces.get(tenant, ()):
                    record = json.loads(line)
                    decoded += 1
                    yield record
        finally:
            self.telemetry.emit("scan", tenant=tenant, request_id=request_id,
                                records=decoded)

    def append(self, tenant, records):
        # Encode before modifying the store so an encoding error is atomic.
        encoded = [json.dumps({**record, "tenant": tenant}, ensure_ascii=False)
                   for record in records]
        if encoded:
            self._traces.setdefault(tenant, []).extend(encoded)
            self._tenant_revisions[tenant] = self.tenant_revision(tenant) + 1
            self._commit("traces", tenant)

    def append_audit(self, entries):
        if entries:
            self._audit.extend(dict(entry) for entry in entries)
            self._commit("audit", None)

    def audit_records(self):
        return [dict(entry) for entry in self._audit]

    def _commit(self, collection, tenant):
        self._revision += 1
        self.telemetry.emit("commit", collection=collection, tenant=tenant,
                            revision=self._revision)
