#!/usr/bin/env bash
# CPU (and allocation) profile of the harness loop, rendered as text.
#
#   scripts/profile.sh                    # config plain, whole corpus
#   scripts/profile.sh gfm                # config gfm
#   scripts/profile.sh gfm gfm            # config gfm, only corpus/gfm.md
#   N=1000 scripts/profile.sh plain       # more iterations = more samples
#
# Writes to work/:
#   cpu-<config>.pprof         raw profile (open with `go tool pprof`)
#   cpu-<config>.goldmark.txt  top 60 goldmark functions by self time (runtime/GC frames hidden)
#   cpu-<config>.flat.txt      top 60 functions by self time, everything included
#   cpu-<config>.cum.txt       top 60 functions by cumulative time
#   mem-<config>.pprof         allocation profile (alloc_space)
#   mem-<config>.alloc.txt     top 40 allocating functions by bytes
#
# Drill into one function afterwards:
#   cd harness && go tool pprof -list 'parser\.\(\*parser\)\.parseBlocks' ../work/cpu-plain.pprof
source "$(dirname "$0")/_common.sh"
config="${1:-plain}"
corpus="$CORPUS"
[[ -n "${2:-}" ]] && corpus="$CORPUS/$2.md"
n="${N:-2000}"
cpu="$WORK/cpu-$config.pprof"
mem="$WORK/mem-$config.pprof"

echo "== profiling config=$config corpus=$corpus n=$n"
(cd "$HARNESS" && go run . -config "$config" -corpus "$corpus" -n "$n" -cpuprofile "$cpu" -memprofile "$mem")

cd "$HARNESS"
go tool pprof -top -nodecount=60 "$cpu" > "$WORK/cpu-$config.flat.txt" 2>/dev/null
go tool pprof -top -cum -nodecount=60 "$cpu" > "$WORK/cpu-$config.cum.txt" 2>/dev/null
go tool pprof -top -nodecount=60 -focus='goldmark' -hide='^runtime\.' "$cpu" > "$WORK/cpu-$config.goldmark.txt" 2>/dev/null
go tool pprof -sample_index=alloc_space -top -nodecount=40 "$mem" > "$WORK/mem-$config.alloc.txt" 2>/dev/null

echo
echo "== goldmark functions by self time (full list: work/cpu-$config.goldmark.txt)"
sed -n '1,30p' "$WORK/cpu-$config.goldmark.txt"
echo
echo "== everything incl. runtime/GC: work/cpu-$config.flat.txt"
echo "== top by cumulative time:      work/cpu-$config.cum.txt"
echo "== top allocators:         work/mem-$config.alloc.txt"
