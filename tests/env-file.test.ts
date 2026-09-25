import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envSearchPaths, resolveEnvFileForWrite, upsertEnvVariable } from "../src/core/env-file";

const directories: string[] = [];
afterAll(async () => { await Promise.all(directories.map(path => rm(path, { recursive: true, force: true }))); });

async function scratch(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "jive-env-file-"));
  directories.push(path);
  return path;
}

test("envSearchPaths walks from cwd up to the root, then appends the checkout, without duplicates", () => {
  const paths = envSearchPaths("/a/b/c", "/a/b");
  expect(paths).toEqual(["/a/b/c/.env", "/a/b/.env", "/a/.env", "/.env"]);
});

test("resolveEnvFileForWrite picks the closest existing .env", async () => {
  const repoRoot = await scratch();
  const project = join(repoRoot, "project");
  await mkdir(project, { recursive: true });
  await writeFile(join(repoRoot, ".env"), "OPENROUTER_API_KEY=repo\n");
  expect(resolveEnvFileForWrite(project, repoRoot)).toBe(join(repoRoot, ".env"));

  await writeFile(join(project, ".env"), "OPENROUTER_API_KEY=project\n");
  expect(resolveEnvFileForWrite(project, repoRoot)).toBe(join(project, ".env"));
});

test("resolveEnvFileForWrite falls back to the jive checkout when no .env exists anywhere", async () => {
  // A separate root, like the real jive checkout is separate from any project's cwd —
  // not a project nested inside it, which would make the checkout part of the upward walk.
  const root = await scratch();
  const repoRoot = join(root, "jive-checkout");
  const project = join(root, "unrelated", "project");
  await mkdir(repoRoot, { recursive: true });
  await mkdir(project, { recursive: true });
  expect(resolveEnvFileForWrite(project, repoRoot)).toBe(join(repoRoot, ".env"));
});

test("upsertEnvVariable appends a new key and preserves existing lines", () => {
  const result = upsertEnvVariable("OPENROUTER_API_KEY=abc\nJEV_API_TOKEN=def\n", "ANTHROPIC_OAUTH_TOKEN", "sk-ant-oat01-xyz");
  expect(result).toBe("OPENROUTER_API_KEY=abc\nJEV_API_TOKEN=def\nANTHROPIC_OAUTH_TOKEN=sk-ant-oat01-xyz\n");
});

test("upsertEnvVariable replaces an existing key in place, touching no other line", () => {
  const result = upsertEnvVariable(
    "OPENROUTER_API_KEY=abc\nANTHROPIC_OAUTH_TOKEN=old\nJEV_API_TOKEN=def\n",
    "ANTHROPIC_OAUTH_TOKEN",
    "sk-ant-oat01-new",
  );
  expect(result).toBe("OPENROUTER_API_KEY=abc\nANTHROPIC_OAUTH_TOKEN=sk-ant-oat01-new\nJEV_API_TOKEN=def\n");
});

test("upsertEnvVariable handles empty content and content missing a trailing newline", () => {
  expect(upsertEnvVariable("", "ANTHROPIC_OAUTH_TOKEN", "sk-ant-oat01-xyz")).toBe("ANTHROPIC_OAUTH_TOKEN=sk-ant-oat01-xyz\n");
  expect(upsertEnvVariable("OPENROUTER_API_KEY=abc", "ANTHROPIC_OAUTH_TOKEN", "sk-ant-oat01-xyz"))
    .toBe("OPENROUTER_API_KEY=abc\nANTHROPIC_OAUTH_TOKEN=sk-ant-oat01-xyz\n");
});
