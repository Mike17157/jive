# Upstream validation record

The required confirmed findings were cross-checked against fixes merged after
the pinned 2024.9.0 snapshot:

- Home Assistant PR 125255, head `906bfbfecd1c0e3a6325fe2019ab45a50f8d470c`,
  moved Yale client construction into `async_add_executor_job`.
- Home Assistant PR 126871, head `40fb4cbb201cf5d345a518aa84fe850fb621a2c9`,
  moved MiCloud construction into `async_add_executor_job` while login was
  already offloaded.
- Home Assistant PR 127587, head `bce248137bba0711e08f9474134768d306be088d`,
  attempted to offload local media `Path.is_file`. The patch omitted `await`, so
  the reference classification relies on the pinned source and blocking `stat`
  semantics rather than treating that patch as a correct implementation model.

Those upstream changes calibrate the three positives. The rejected and
unresolved catalog was separately read against the pinned fixture; it is not
derived only from changed lines in those pull requests. No runtime reproduction
was performed for this task preparation.
