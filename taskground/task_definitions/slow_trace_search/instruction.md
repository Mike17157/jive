# Speed up trace search

The small trace-query engine in this workspace returns the right answers, but a routine search over the generated fixture takes far too long. Profile the workload, identify the hot path, and optimize it substantially while preserving the documented behavior and public API.

Aim for at least a 3× reduction in median search time on the supplied benchmark. Use only the Python standard library and keep the implementation easy to maintain.

Run the public tests and the supplied workload, profiling, and benchmark commands. Record your evidence and reasoning in `work/report.md`; retain the generated profiler and benchmark artifacts under `work/`. Do not change the fixture generator, generated inputs, public tests, or command harnesses.
