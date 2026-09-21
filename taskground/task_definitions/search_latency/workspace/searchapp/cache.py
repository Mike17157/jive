"""Bounded least-recently-used result cache, owned by a search service.

Access occurs under the store transaction so lookup and publication see the same
data view. Values are internal; the response layer copies them before returning.
"""

from collections import OrderedDict
from hashlib import sha256


class ResultCache:
    def __init__(self, capacity, enabled, telemetry):
        if capacity < 1:
            raise ValueError("cache_capacity must be positive")
        self.capacity = capacity
        self.enabled = enabled
        self.telemetry = telemetry
        self._items = OrderedDict()

    def get(self, tenant, token, query_key, request_id):
        key = (tenant, token, query_key)
        value = self._items.get(key) if self.enabled else None
        hit = value is not None
        if hit:
            self._items.move_to_end(key)
        if self.telemetry.recorder is not None:
            # Query fingerprint excludes the data version; traces can correlate
            # identical requests against different snapshots without query text.
            fingerprint = sha256(repr((tenant, query_key)).encode()).hexdigest()[:16]
            self.telemetry.emit("cache", request_id=request_id, tenant=tenant,
                                token=token, key=fingerprint, hit=hit)
        return value

    def put(self, tenant, token, query_key, rows):
        if not self.enabled:
            return
        key = (tenant, token, query_key)
        self._items[key] = rows
        self._items.move_to_end(key)
        while len(self._items) > self.capacity:
            self._items.popitem(last=False)
