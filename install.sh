#!/bin/sh
# Install or update Jive from the latest main branch.
#
#   curl -fsSL https://raw.githubusercontent.com/merijjeyn/jive/main/install.sh | sh
#
# Clones the repository into $JIVE_HOME (default ~/.jive), installs its
# dependencies, and links the `jive` command into $JIVE_BIN (default ~/.local/bin).
# Running it again, or `jive update`, pulls the latest main and refreshes
# dependencies. No build step exists: `jive` runs the checkout's sources with Bun.
set -eu

repo_url=${JIVE_REPO:-https://github.com/merijjeyn/jive.git}
home=${JIVE_HOME:-$HOME/.jive}
bin_dir=${JIVE_BIN:-$HOME/.local/bin}
ref=${JIVE_REF:-main}

need() { command -v "$1" >/dev/null 2>&1 || { echo "install.sh: $1 is required" >&2; exit 1; }; }
need git

if [ -d "$home/.git" ]; then
  echo "Updating $home"
  git -C "$home" fetch --quiet origin "$ref"
  git -C "$home" checkout --quiet "$ref"
  git -C "$home" merge --quiet --ff-only "origin/$ref"
else
  echo "Cloning $repo_url into $home"
  git clone --quiet --branch "$ref" "$repo_url" "$home"
fi

cd "$home"
if command -v bun >/dev/null 2>&1; then
  bun install --production --silent
elif command -v npm >/dev/null 2>&1; then
  # The pinned `bun` npm package provides the runtime when Bun is not installed globally.
  npm install --omit=dev --no-audit --no-fund --no-package-lock --silent
else
  echo "install.sh: neither bun nor npm found. Install Bun (https://bun.sh) or Node.js, then rerun." >&2
  exit 1
fi

mkdir -p "$bin_dir"
ln -sf "$home/bin/jive" "$bin_dir/jive"
echo "Installed jive $(git -C "$home" rev-parse --short HEAD) -> $bin_dir/jive"

case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) echo "Add $bin_dir to your PATH, for example:  export PATH=\"$bin_dir:\$PATH\"" ;;
esac
echo "Next: put OPENROUTER_API_KEY (and JEV_API_TOKEN) in a .env file, then run 'jive'. Try 'jive --demo' without keys."
