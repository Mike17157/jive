# shellcheck shell=bash
# Sourced by every script. Resolves the task root regardless of cwd.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GOLDMARK="$ROOT/goldmark"
HARNESS="$ROOT/harness"
CORPUS="$ROOT/corpus"
GOLDEN="$ROOT/golden"
WORK="$ROOT/work"
mkdir -p "$WORK"
