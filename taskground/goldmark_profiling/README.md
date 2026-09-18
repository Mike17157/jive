# goldmark_profiling

A self-contained loop for one job: **profile [goldmark](https://github.com/yuin/goldmark)
(a CommonMark/GFM Markdown parser and HTML renderer written in Go), make a chosen
component faster, and prove it** — same output bytes, tests green, measurable speedup.
Everything you need is in this folder; nothing is fetched from the network after setup.

The task prompt you were given names the component to optimise (a package, a
function, or a symptom such as "allocations in the table extension"). This README
is the environment: where things are, how to measure, what counts as done.

```
goldmark_profiling/
  goldmark/      upstream clone (git). THE ONLY PLACE YOU EDIT. Module github.com/yuin/goldmark/v2
  harness/       Go module that imports ../goldmark via `replace`: timing CLI, benchmarks, golden check
  corpus/        fixed inputs: commonmark.md (goldmark's own 200 KB benchmark file), gfm.md (generated, exercises extensions)
  golden/        expected HTML per <config>/<corpus file>, rendered from the untouched baseline commit. Read-only.
  work/          your outputs: profiles, bench results. work/baseline/ = reference commit + timings. Read-only.
  scripts/       the loop (all runnable from any cwd, all print a short summary and write details to work/)
```

## The loop

```sh
scripts/profile.sh plain        # ~10 s. CPU + alloc profile -> work/cpu-plain.*.txt, work/mem-plain.alloc.txt
scripts/profile.sh gfm gfm      # profile the gfm pipeline on corpus/gfm.md only
#   ... edit files under goldmark/ ...
scripts/check.sh golden         # ~2 s.  output byte-identical to golden for all 4 config×corpus pairs?
scripts/check.sh                # ~15 s. go vet + full upstream test suite (make test) + golden
scripts/bench.sh                # ~2 min. go test -bench (8 runs each) + benchstat vs baseline
scripts/diff.sh                 # what you changed relative to the baseline commit
```

Faster iteration on timing while you work:

```sh
BENCH='BenchmarkRender/plain' COUNT=4 scripts/bench.sh try1   # subset, fewer runs, ~20 s
BENCH='BenchmarkParse/gfm/gfm' scripts/bench.sh try2           # one sub-benchmark
```

Reset goldmark to the baseline at any time:

```sh
git -C goldmark checkout -- . && git -C goldmark clean -fd
```

## Two pipelines, two corpora

| config  | parser                                                             | renderer                              |
| ------- | ------------------------------------------------------------------ | ------------------------------------- |
| `plain` | CommonMark only (`parser.New()`)                                   | `html.New(WithXHTML, WithUnsafe)`     |
| `gfm`   | plain + GFM (table, strikethrough, tasklist, linkify) + footnote + typographer + heading attributes | plain + GFM + footnote HTML renderers |

`plain` is exactly what goldmark's own `_benchmark/` measures. `gfm` is there so the
`extension` package shows up in profiles. Both run over both corpus files; benchmark
names are `<Benchmark>/<config>/<corpus>`: `BenchmarkRender` (parse + render, the
headline number), `BenchmarkParse`, `BenchmarkRenderOnly`.

## Definition of done

1. `scripts/check.sh` prints `CHECK PASS`. That means: `go vet` clean, upstream
   `make test` green (the CommonMark spec suite plus goldmark's extras), and rendered
   HTML byte-identical to `golden/` for every config × corpus.
2. `scripts/bench.sh` shows an improvement on the benchmark(s) the task names, with
   benchstat's p-value ≤ 0.05. Changes under ~3% are noise on this machine; ±5% run
   to run is normal for `Render/plain/commonmark`. Use `COUNT=15` for a final number.
3. Diff limited to `goldmark/`. Do not edit `harness/`, `corpus/`, `golden/`, or
   `work/baseline/`; the grader regenerates none of them. A change that makes the
   golden check pass by editing the golden is a failure.
4. No behaviour change beyond speed: no new public API, no option that is off by
   default, no dropped CommonMark edge cases. If the tests don't cover a path you
   changed, add a test in the upstream style (`testdata/*.txt` or `_test.go`).

Report back with: the benchstat table (baseline vs final), the profile lines that
motivated the change, and `scripts/diff.sh` output.

## Where the time goes at baseline

Machine: Apple M3 Pro, Go 1.26. Baseline commit is in `work/baseline/commit.txt`.

| benchmark                    | sec/op  | B/op    |
| ---------------------------- | ------- | ------- |
| Render/plain/commonmark      | 1.62 ms | 1.88 MiB |
| Render/plain/gfm             | 1.38 ms | 1.70 MiB |
| Render/gfm/commonmark        | 2.35 ms | 2.21 MiB |
| Render/gfm/gfm               | 3.28 ms | 4.04 MiB |
| Parse/plain/commonmark       | 1.17 ms | 1.88 MiB |
| RenderOnly/plain/commonmark  | 0.47 ms | 558 B   |
| RenderOnly/gfm/gfm           | 1.10 ms | 136 KiB |

What the profiles say (full text in `work/cpu-*.txt` after running `profile.sh`):

- **Parsing is ~70% of Render time, and almost all allocation happens in the parser**
  (RenderOnly allocates almost nothing on `plain`). Runtime/GC frames dominate the raw
  profile, which is why `cpu-<config>.goldmark.txt` hides them: the lever is usually
  fewer or smaller allocations (`ast.NewText`, segment slices, `parseBlock` temporaries),
  visible in `mem-<config>.alloc.txt` and the B/op column.
- Hot goldmark frames on `plain`: `parser.(*parser).parseBlock` / `parseBlocks`,
  `ast.walkHelper` (the render walk), `renderer.(*Helper).renderFn`, `text.(*blockReader).Advance`,
  `bytes.IndexByte` from line scanning.
- On `gfm/gfm` the extension package appears: `extension.(*tableHTMLRendererExtension).renderTableCell`,
  `extension.(*linkifyParser).Parse`, `ast.(*BaseNode).SetAttribute`, and `fmt` calls
  from the table/footnote renderers. `RenderOnly/gfm/gfm` allocating 136 KiB where
  `plain` allocates 558 B is a concrete place to start.

Drill in with pprof (run from `harness/`, where the module is):

```sh
cd harness
go tool pprof -list 'parser\.\(\*parser\)\.parseBlock$' ../work/cpu-plain.pprof   # per-line cost
go tool pprof -peek 'ast\.NewText' ../work/cpu-plain.pprof                        # callers/callees
go tool pprof -sample_index=alloc_objects -top ../work/mem-gfm.pprof              # allocation count instead of bytes
go tool pprof -top -focus 'extension\.' ../work/cpu-gfm.pprof                     # only stacks through the extension package
```

## Working in goldmark/

- Packages: `parser/` (block + inline parsers, `parser.go` is the driver), `renderer/`
  and `renderer/html/` (node renderers), `extension/` (GFM, footnote, typographer, ...),
  `ast/` (node types, `Walk`), `text/` (readers, segments), `util/` (byte helpers,
  CommonMark character classes).
- Read `goldmark/AGENTS.md`: conventions such as `util.StringToReadOnlyBytes` /
  `util.ReadOnlyBytesToString` for zero-copy conversions, `util.IsPunct` instead of
  `unicode.IsPunct`, tabs expanding to 1-4 columns depending on position, and that
  inline elements can span lines (`text.MultiLineValue`).
- `make lint` in goldmark needs `golangci-lint` and `gopls`, which may not be installed.
  `scripts/check.sh` runs `go vet` instead; run the linter if it is available.
- Tests take ~10 s. The spec cases live in `testdata/spec.json` and `testdata/*.txt`;
  extension tests are `extension/*_test.go` with `extension/_test/*.txt`.
- Commit style if you commit inside `goldmark/`: Conventional Commits with the package
  as scope, e.g. `perf(parser): reuse segment buffer in parseBlock`. Committing is
  optional; `scripts/diff.sh` diffs against the baseline commit either way.

## Notes for a graph/bash-node agent

- Every script writes its detail to `work/` and keeps stdout short. Read the files,
  don't cat whole profiles into context: `sed -n '1,40p' work/cpu-plain.goldmark.txt`.
- `check.sh golden` is the cheap gate; run it after every edit. Run the full `check.sh`
  before any bench you intend to report.
- Benchmarks are CPU-bound and single-process; running two `bench.sh` at once corrupts
  both. Profiles (`profile.sh`) and golden checks can run in parallel with each other.
- Candidate patches can be tried in parallel using git worktrees of `goldmark/`, but the
  harness `replace` points at `../goldmark`, so measure each candidate by checking it
  into `goldmark/` in turn (or copy the folder and point a copy of `harness/go.mod` at it).

## Example task statement

> Reduce `BenchmarkRender/gfm/gfm` by at least 15% on sec/op, or cut its B/op by
> 30%, without changing rendered output. Start from `scripts/profile.sh gfm gfm`.
> Definition of done as in README. Report benchstat and the diff.

## Regenerating the reference (maintainers only)

`scripts/baseline.sh` rewrites `golden/` and `work/baseline/` from the current
goldmark commit. It refuses to run on a dirty tree. `corpus/gfm.md` is produced by
`python3 corpus/gen_gfm.py` and is deterministic; `corpus/commonmark.md` is a copy of
goldmark's `_benchmark/go/_data.md`. Regenerate the baseline whenever either changes.
