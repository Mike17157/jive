import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true }))); });

test("standalone replay resolves both graph and command paths from --cwd", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "jive-cli-replay-"));
  directories.push(cwd);
  const source = JSON.stringify({ version: 1, label: "standalone", nodes: { save: { type: "bash", script: "printf success > result.txt" } } });
  await writeFile(join(cwd, "workflow.json"), source);
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/cli.tsx"), "--cwd", cwd, "--run", "workflow.json", "--json"], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exitCode, stderr).toBe(0);
  expect(await readFile(join(cwd, "result.txt"), "utf8")).toBe("success");
  expect(await readFile(join(cwd, "workflow.json"), "utf8")).toBe(source);
  const events = stdout.trim().split("\n").map(line => JSON.parse(line));
  expect(events.at(-1).type).toBe("graph.finished");
  expect(events.at(-1).data.report.status).toBe("done");
});
