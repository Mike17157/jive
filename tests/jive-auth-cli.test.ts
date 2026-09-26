import { expect, test } from "bun:test";
import { resolve } from "node:path";

const cliPath = resolve(import.meta.dir, "../src/cli.tsx");

async function run(...args: string[]) {
  const child = Bun.spawn([process.execPath, cliPath, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

test("`jive auth` with no provider prints usage naming both providers and fails", async () => {
  const { stderr, exitCode } = await run("auth");
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("jive auth claude");
  expect(stderr).toContain("jive auth openrouter");
});

test("`jive auth` with an unrecognized provider prints usage naming both providers and fails", async () => {
  const { stderr, exitCode } = await run("auth", "bogus");
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("jive auth claude");
  expect(stderr).toContain("jive auth openrouter");
});

test("`jive --help` documents both auth providers", async () => {
  const { stdout, exitCode } = await run("--help");
  expect(exitCode).toBe(0);
  expect(stdout).toContain("jive auth claude");
  expect(stdout).toContain("jive auth openrouter");
});
