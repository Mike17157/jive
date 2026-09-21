"""Request orchestration for a local, thread-safe trace search endpoint."""

from .audit import AuditWriter
from .cache import ResultCache
from .catalog import Catalog
from .query import QueryPlan
from .response import render
from .storage import DocumentStore
from .telemetry import Telemetry


class SearchService:
    def __init__(self, data_path, *, cache_enabled=True, audit_enabled=True,
                 audit_batch_size=4, cache_capacity=64, recorder=None):
        self.telemetry = Telemetry(recorder)
        self.store = DocumentStore(data_path, self.telemetry)
        self.catalog = Catalog(self.store)
        self.cache = ResultCache(cache_capacity, cache_enabled, self.telemetry)
        self.audit = AuditWriter(self.store, self.telemetry, audit_batch_size, audit_enabled)

    def handle(self, request):
        request_id = request["request_id"]
        tenant = request["tenant"]
        if not isinstance(request_id, str) or not request_id:
            raise ValueError("request_id must be a nonempty string")
        if not isinstance(tenant, str) or not tenant:
            raise ValueError("tenant must be a nonempty string")
        with self.telemetry.span("request", request_id=request_id, tenant=tenant):
            with self.telemetry.span("query.plan", request_id=request_id):
                plan = QueryPlan.compile(request.get("query", {}))
            with self.store.transaction(request_id):
                token = self.catalog.token(tenant)
                with self.telemetry.span("cache.lookup", request_id=request_id):
                    rows = self.cache.get(tenant, token, plan.cache_key, request_id)
                if rows is None:
                    with self.telemetry.span("filter", request_id=request_id):
                        records = self.store.scan(tenant, request_id)
                        try:
                            rows = plan.select(records)
                        finally:
                            records.close()
                    self.cache.put(tenant, token, plan.cache_key, rows)
                with self.telemetry.span("serialize", request_id=request_id):
                    response = render(request_id, tenant, rows)
                self.audit.record(request_id, tenant, len(rows))
                return response

    def ingest(self, tenant, records):
        if not isinstance(tenant, str) or not tenant:
            raise ValueError("tenant must be a nonempty string")
        with self.telemetry.span("ingest", tenant=tenant):
            with self.store.transaction():
                self.store.append(tenant, records)

    def flush_audit(self):
        with self.store.transaction():
            self.audit.flush()

    def audit_records(self):
        with self.store.transaction():
            return self.store.audit_records()

    def close(self):
        self.flush_audit()
