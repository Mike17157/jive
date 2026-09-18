#!/bin/sh
# Put the `jive` command on PATH by symlinking it into a bin directory.
set -e
repo=$(cd -P "$(dirname "$0")/.." && pwd)
target=${1:-$HOME/.local/bin}
mkdir -p "$target"
ln -sf "$repo/bin/jive" "$target/jive"
echo "linked $target/jive -> $repo/bin/jive"
case ":$PATH:" in
  *":$target:"*) ;;
  *) echo "warning: $target is not on your PATH; add it to your shell profile." >&2 ;;
esac
