"""Optional structured observations; instrumentation is disabled by default."""

from contextlib import contextmanager
from time import perf_counter_ns


class Telemetry:
    def __init__(self, recorder=None):
        self.recorder = recorder

    def emit(self, event, **fields):
        if self.recorder is not None:
            self.recorder({"event": event, "time_ns": perf_counter_ns(), **fields})

    @contextmanager
    def span(self, operation, **fields):
        if self.recorder is None:
            yield
            return
        started = perf_counter_ns()
        try:
            yield
        finally:
            self.emit("span", operation=operation,
                      duration_ns=perf_counter_ns() - started, **fields)
