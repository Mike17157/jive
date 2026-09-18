#!/usr/bin/env bash
# Correctness gate: upstream test suite + go vet + golden HTML for every
# corpus file and config. Exit 0 only if everything passes.
#
#   scripts/check.sh            # everything
#   scripts/check.sh golden     # golden diff only (fast, ~1s)
#   scripts/check.sh tests      # upstream tests only
source "$(dirname "$0")/_common.sh"
mode="${1:-all}"
status=0

if [[ "$mode" == "all" || "$mode" == "tests" ]]; then
  echo "== go vet (goldmark)"
  (cd "$GOLDMARK" && go vet ./...) || status=1
  echo "== upstream tests (goldmark: make test)"
  (cd "$GOLDMARK" && make test 2>&1 | grep -v '^\s*github.com.*coverage: 0.0%' | sed -E 's/coverage: .*//') || status=1
  rm -f "$GOLDMARK/coverage.out"
fi

if [[ "$mode" == "all" || "$mode" == "golden" ]]; then
  echo "== golden HTML (harness -check)"
  (cd "$HARNESS" && go run . -check "$GOLDEN") || status=1
fi

if [[ $status -eq 0 ]]; then echo "CHECK PASS"; else echo "CHECK FAIL"; fi
exit $status
