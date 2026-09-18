#!/usr/bin/env bash
# Authoritative timing via `go test -bench` + benchstat.
#
#   scripts/bench.sh                 # label "current"; compares against work/baseline/bench.txt
#   scripts/bench.sh mylabel         # writes work/bench-mylabel.txt
#   COUNT=20 scripts/bench.sh        # more repetitions (default 8) for tighter confidence intervals
#   BENCH='BenchmarkRender/plain' scripts/bench.sh   # subset (regex passed to -bench)
#
# Output: work/bench-<label>.txt (raw) and a benchstat table on stdout.
# Read the benchstat table: "sec/op" is the wall time per render; the "vs base"
# column gives the % change and a p-value. Treat |change| < ~3% or p > 0.05 as noise.
source "$(dirname "$0")/_common.sh"
label="${1:-current}"
count="${COUNT:-8}"
bench="${BENCH:-.}"
out="$WORK/bench-$label.txt"

echo "== benchmarking ($count runs each) -> $out"
(cd "$HARNESS" && go test -run '^$' -bench "$bench" -benchmem -count "$count" > "$out" 2>&1) \
  || { echo "bench failed:"; tail -20 "$out"; exit 1; }

base="$WORK/baseline/bench.txt"
if [[ -f "$base" && "$label" != "baseline" ]]; then
  echo
  echo "== benchstat baseline vs $label"
  (cd "$HARNESS" && go tool benchstat -filter '.unit:(sec/op OR B/op)' "../work/baseline/bench.txt" "../work/bench-$label.txt")
else
  echo
  (cd "$HARNESS" && go tool benchstat -filter '.unit:(sec/op OR B/op)' "../work/bench-$label.txt")
fi
