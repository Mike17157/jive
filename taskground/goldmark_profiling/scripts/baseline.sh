#!/usr/bin/env bash
# Freeze the reference point: golden HTML + baseline timings for the current
# goldmark commit. Run once before any edits (already done for the initial
# commit; re-run only if you deliberately move the goldmark checkout).
# Refuses to run while goldmark/ has uncommitted changes, since golden output
# must come from the untouched tree.
source "$(dirname "$0")/_common.sh"

if [[ -n "$(git -C "$GOLDMARK" status --porcelain)" ]]; then
  echo "goldmark/ has uncommitted changes; baseline must be taken from a clean tree." >&2
  echo "Run 'git -C goldmark stash' (or commit) first, or pass FORCE=1." >&2
  [[ "${FORCE:-}" == "1" ]] || exit 1
fi

mkdir -p "$WORK/baseline"
git -C "$GOLDMARK" rev-parse HEAD > "$WORK/baseline/commit.txt"
echo "== goldmark commit $(cat "$WORK/baseline/commit.txt")"

echo "== writing golden HTML -> $GOLDEN"
rm -rf "$GOLDEN"
(cd "$HARNESS" && go run . -write-golden "$GOLDEN")

echo "== baseline timings"
"$ROOT/scripts/bench.sh" baseline
mv "$WORK/bench-baseline.txt" "$WORK/baseline/bench.txt"
echo "baseline stored in work/baseline/"
