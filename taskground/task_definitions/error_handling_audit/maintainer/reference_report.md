# Error Handling Audit

## Scope and search coverage

The audit reviewed all 12 primary files and all 35 broad exception handlers reported by `scripts/inventory.py`. It also traced two non-syntactic error boundaries: docker-py's high-level image pull implementation and CPython's `concurrent.futures` callback dispatch. Selected Prefect tests were used as contract evidence and to distinguish established success behavior from missing failure coverage. The five graded findings and representative negatives form a curated reference for this bounded fixture; they do not assert that every semantic issue in the retained files is known.

## Confirmed findings

Five harmful boundaries are confirmed. The async template renderer converts Jinja failures into strings; `JinjaTemplateAction._render` therefore returns normally, and the action consumer takes its success branch. The synchronous renderer performs the same conversion on a separate call path: `jinja_handler` returns the error string as hydrated data instead of creating `InvalidJinja`.

The Docker worker calls docker-py's high-level `ImageCollection.pull`. That implementation requests a streaming low-level pull, discards every record without checking its `error` member, and then retrieves the tag locally. A streamed daemon error can therefore leave an older local image to be used by container creation.

`_UnpicklingFuture.add_done_callback` deserializes before it invokes the supplied callback. Invalid pickle bytes or a wrapped-future exception escapes into `concurrent.futures`, whose callback dispatcher logs ordinary exceptions. Prefect's callback never sets the event on which `as_completed` waits, so completion can stall after the worker future is already done.

Finally, `SecureTaskConcurrencySlots.cleanup` owns reversal of V2 lease acquisition when an orchestration rule fizzles. Its broad handler logs failures from reading, decrementing, or revoking the lease and returns to `BaseOrchestrationRule.__aexit__`. The failed cleanup is therefore reported as complete while the acquired capacity may remain held.

## Rejected lookalikes

Three representative broad handlers are expected behavior. General event emission is optional and preserves the required oversized-event exception separately. Internal analytics explicitly uses a fire-and-forget contract and returns a boolean delivery signal. The open-file-limit helper is a platform capability probe with a documented conservative fallback. These handlers suppress errors, but their callers do not reinterpret a required operation as successful.

Other broad handlers were reviewed but are not promoted merely because they log, return, or continue. The deciding evidence is ownership of the outcome and the concrete downstream state, not syntax.

## Unresolved and dependency boundaries

`SecureFlowConcurrencySlots.cleanup` resembles the confirmed task-concurrency issue, but the retained snapshot also points to lease expiry and reaper recovery. Static evidence does not establish the duration of leaked capacity or whether immediate propagation is the promised behavior, so it remains unresolved. A focused integration test should inject both decrement and revoke failures and measure availability through reaper recovery.

Dependency behavior is version-specific. The Docker judgment uses the locked docker-py 7.1.0 source, and the callback judgment uses CPython 3.12.10 as a representative supported runtime. Other versions require rechecking those boundary implementations. Prose quality, actual search method, and additional unconfirmed candidates still require trace review beyond deterministic artifact verification.
