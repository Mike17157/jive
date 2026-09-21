# Retry audit policy

The central cleanup team uses these classifications:

- `correctness_defect`: the current control flow violates an observable contract. Examples include losing owned work, retrying the wrong state, exceeding or under-running a documented bound, or changing caller/service retry semantics. A defect needs a concrete trigger, actual behavior, expected behavior, impact, and code-path evidence.
- `migration_candidate`: behavior may be correct, but local retry machinery substantially duplicates a shared facility and can be migrated without changing exception selection, attempt accounting, timing, cancellation, state ownership, or observability. State the compatibility work; resemblance alone is insufficient.
- `rejected`: a reviewed retry-looking site is appropriate under this policy. Common reasons are legitimate status polling, a shared retry helper already in use, retry delegated to an SDK/waiter, a bounded local loop whose semantics are specific, or configuration rather than executable retry logic.
- `unresolved`: the supplied snapshot does not contain enough of an external dependency or runtime contract to decide safely. Record the missing fact and the next check.

Use source behavior as the authority. Tests show intended and covered behavior, but a test that merely encodes current output is not by itself proof that the output is correct. Treat retry counts carefully: state whether a number means total attempts or retries after the first attempt. Trace queue ownership before every `continue`, return, raise, and terminal transition. Compare synchronous and deferred paths when they implement the same public option.

Do not propose replacing all loops. Polling a long-running remote job is not automatically a transport retry, and SDK retry handlers or waiters may already own transient-failure policy. Recommendations must preserve the behavior you found or explicitly call out a deliberate policy change.
