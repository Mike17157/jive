"""Batch request receipts into the store's audit collection."""


class AuditWriter:
    def __init__(self, store, telemetry, batch_size=4, enabled=True):
        if batch_size < 1:
            raise ValueError("audit_batch_size must be positive")
        self.store = store
        self.telemetry = telemetry
        self.batch_size = batch_size
        self.enabled = enabled
        self.pending = []

    def record(self, request_id, tenant, row_count):
        if not self.enabled:
            return
        self.pending.append({"request_id": request_id, "tenant": tenant,
                             "row_count": row_count})
        if len(self.pending) >= self.batch_size:
            self.flush(request_id)

    def flush(self, request_id=None):
        if self.pending:
            with self.telemetry.span("audit.flush", request_id=request_id):
                self.store.append_audit(self.pending)
                self.pending.clear()
