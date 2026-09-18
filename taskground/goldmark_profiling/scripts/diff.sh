#!/usr/bin/env bash
# Show what has been changed in goldmark/ relative to the baseline commit.
source "$(dirname "$0")/_common.sh"
base="$(cat "$WORK/baseline/commit.txt" 2>/dev/null || echo HEAD)"
git -C "$GOLDMARK" --no-pager diff --stat "$base"
echo
git -C "$GOLDMARK" --no-pager diff "$base"
