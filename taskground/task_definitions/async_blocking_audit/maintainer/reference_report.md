# Async blocking audit

## Search coverage

I reviewed 74 plausible operations across 18 files, starting at config-entry,
config-flow, HTTP, websocket, and coordinator entry points. I searched direct
calls in async functions, constructors, filesystem methods, synchronous network
libraries, and every `async_add_executor_job` boundary in the primary scope.
Tests and the coordinator helper were used to check reachability; the preserved
dependency sources were used to trace constructors. The structured evidence is
in `work/findings.json`.

## Confirmed findings

`yale-setup-client-constructor` is the clearest blocker. First refresh awaits
the coordinator's `_async_setup`, which directly creates the Yale client. The
client creates `YaleAuth`, and that constructor immediately reaches synchronous
`requests.post`. This can block config-entry setup for the network timeout.

`xiaomi-cloud-cold-constructor` is conditional but actionable. The config flow
constructs `MiCloud` directly before correctly offloading `login`. Construction
calls `tzlocal.get_localzone`; on a cold cache, the representative tzlocal 5.2
implementation probes and reads timezone files. A warm tzlocal cache avoids
that discovery, so this is not described as unconditional per-construction I/O.

`local-media-file-check` runs `Path.is_file()` directly in an async HTTP GET
handler. That synchronous filesystem stat can stall other event-loop work when
the media path is slow.

## Rejected lookalikes

The same Yale constructor is handled correctly by the reauthentication flow in
`yale-reauth-client-offloaded`. `xiaomi-cloud-login-offloaded`,
`local-media-browse-offloaded`, and `local-media-move-offloaded` pass their
potentially blocking callables through an executor. `xiaomi-reauth-task-scheduling`
and `media-upload-parse-native` are awaited async APIs. The direct calls in
`xiaomi-zeroconf-regex` and `media-uri-parser` are source-confirmed in-memory
work. These comparisons show that the audit did not classify calls from naming
or synchronous syntax alone.

## Unresolved boundaries

`xiaomi-device-constructor-boundary` constructs `miio.Device` directly, then
offloads the subsequent `info` call. The pinned manifest names python-miio, but
its implementation is outside this selected snapshot. I would read that exact
constructor or capture an event-loop detector trace before changing the label.
Other extra dependency and stdlib candidates are listed only when the supplied
source supports a conclusion.

## Limitations

This was static source inspection. I did not install or execute Home Assistant,
measure event-loop latency, or reproduce detector warnings. The fixture is a
selected slice rather than the full repository. MiCloud's tzlocal dependency is
unbounded by its package metadata; the included 5.2 source represents the
compatible version current at the snapshot date, not a universal environment.
