# Audit async paths for blocking work

Audit the supplied Home Assistant 2024.9.0 source snapshot for synchronous work
that can block the event loop. This is an investigation task: do not repair or
reformat the upstream code.

Treat these integration sources as the primary audit scope:

- `source/homeassistant/components/yale_smart_alarm/`
- `source/homeassistant/components/xiaomi_miio/__init__.py`
- `source/homeassistant/components/xiaomi_miio/config_flow.py`
- `source/homeassistant/components/xiaomi_miio/device.py`
- `source/homeassistant/components/media_source/`

The selected helper, test, manifest, and dependency sources are evidence for
following entry points, offload boundaries, constructors, and call chains.
Search broadly across the primary scope before settling on findings. Inspect at
least 30 plausible call sites or operations, including constructors and file,
network, and device operations. A name beginning with `async_` is not proof by
itself, and a synchronous-looking call is not necessarily unsafe when it is
protected by an executor or is only in-memory work.

Create `work/findings.json` using the exact schema and category meanings in
`README.md`. Report every confirmed blocker you can substantiate, a varied set
of rejected lookalikes, and at least one material boundary that cannot be
resolved from the supplied snapshot. Evidence must cite short, real line ranges
in the checked-in files. Record caller paths far enough to explain why the code
runs on the event loop or crosses an offload boundary. Do not rely on runtime
behavior you did not actually measure.

Create `work/report.md` for a maintainer. Explain search coverage, confirmed
findings and impact, rejected lookalikes, unresolved or dependency boundaries,
and limitations. Tie conclusions to finding IDs so the report and structured
artifact can be reviewed together. Unknown additional findings are welcome when
clearly labeled; uncertainty should remain `unresolved`, not be promoted to a
confirmed defect.
