/**
 * jive's `.env` resolution: the working directory, then its ancestors, then the
 * jive checkout. `bin/jive` uses this order to fill in credentials that are not
 * already set; `jive auth` uses it to decide which file to write a token into.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** `.env` candidates in read precedence: closest to `cwd` first, checkout last. */
export function envSearchPaths(cwd: string, repoRoot: string): string[] {
  const directories: string[] = [];
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    directories.push(dir);
    if (dirname(dir) === dir) break;
  }
  directories.push(resolve(repoRoot));
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const directory of directories) {
    const path = join(directory, ".env");
    if (seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  return paths;
}

/**
 * The `.env` jive would write a credential into: the closest one that already
 * exists in `envSearchPaths`, or the jive checkout's own `.env` as the fallback
 * when none exist yet.
 */
export function resolveEnvFileForWrite(cwd: string, repoRoot: string): string {
  const paths = envSearchPaths(cwd, repoRoot);
  return paths.find(existsSync) ?? paths[paths.length - 1]!;
}

/**
 * Sets `KEY=value` in dotenv-formatted content: replaces an existing `KEY=` line
 * in place, or appends a new one. Every other line is left untouched.
 */
export function upsertEnvVariable(content: string, key: string, value: string): string {
  const endsWithNewline = content.length === 0 || content.endsWith("\n");
  const lines = content.split("\n");
  if (endsWithNewline) lines.pop();
  const pattern = new RegExp(`^\\s*${key}\\s*=`);
  const index = lines.findIndex(line => pattern.test(line));
  const newLine = `${key}=${value}`;
  if (index === -1) lines.push(newLine);
  else lines[index] = newLine;
  return lines.join("\n") + "\n";
}
