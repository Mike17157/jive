#!/usr/bin/env bun
// `jive` launcher: runs the agent from this checkout's TypeScript sources, in the
// caller's working directory. Bun executes the sources directly, so every run picks
// up the latest changes without a separate build step.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");

// Bun auto-loads .env from the current working directory only. Fill in whatever is
// still unset from .env files up the tree, then from the jive checkout, so credentials
// keep working when the agent is launched from a taskground folder.
async function loadEnvFallbacks() {
  const directories: string[] = [];
  for (let dir = process.cwd(); ; dir = dirname(dir)) { directories.push(dir); if (dirname(dir) === dir) break; }
  directories.push(repoRoot);
  const seen = new Set<string>();
  for (const directory of directories) {
    const path = join(directory, ".env");
    if (seen.has(path) || !existsSync(path)) continue;
    seen.add(path);
    for (const line of (await readFile(path, "utf8")).split("\n")) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      const raw = match[2]!.trim();
      const quoted = /^(["'])([\s\S]*)\1$/.exec(raw);
      const value = quoted ? quoted[2]! : raw.replace(/\s+#.*$/, "").trim();
      if (process.env[match[1]!] === undefined) process.env[match[1]!] = value;
    }
  }
}

await loadEnvFallbacks();
await import(join(repoRoot, "src", "cli.tsx"));
