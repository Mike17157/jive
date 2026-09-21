import { afterEach, expect, test } from "bun:test";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareRun, verifyRun } from "../src/taskground/runner";
import { capture } from "../src/taskground/process";
import { OPENROUTER_NOTE } from "../src/taskground/agents";

const temporary: string[] = [];
afterEach(async () => {
  for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true });
});

for (const task of ["async_blocking_audit", "error_handling_audit", "retry_audit"]) {
  test(`${task} prepares without answers and grades audit artifacts through the runner`, async () => {
    const root = await mkdtemp(join(tmpdir(), "taskground-audit-test-"));
    temporary.push(root);
    const run = await prepareRun({ task, agent: "jive", runsRoot: root });
    expect(run.status).toBe("ready");
    expect(await capture(["git", "status", "--porcelain"], run.workspace)).toBe("");
    expect(await readFile(join(run.workspace, "README.md"), "utf8")).toContain(OPENROUTER_NOTE);
    expect(await Bun.file(join(run.workspace, "maintainer/reference_findings.json")).exists()).toBe(false);
    expect(await Bun.file(join(run.workspace, "verifier/verify.py")).exists()).toBe(false);
    expect((await verifyRun(run.id, root)).grading.status).toBe("failed");

    await copyFile(join(run.definition, "maintainer/reference_findings.json"), join(run.workspace, "work/findings.json"));
    await copyFile(join(run.definition, "maintainer/reference_report.md"), join(run.workspace, "work/report.md"));
    const passed = await verifyRun(run.id, root);
    expect(passed.grading.status, await readFile(passed.grading.report!, "utf8")).toBe("passed");
    const report = JSON.parse(await readFile(passed.grading.report!, "utf8"));
    expect(report.task).toBe(task);
    expect(Array.isArray(report.checks)
      ? report.checks.every((check: { status: string }) => check.status === "passed")
      : Object.values(report.checks).every(value => value === true)).toBe(true);

    await writeFile(join(run.workspace, "work/findings.json"), "{invalid json");
    const failed = await verifyRun(run.id, root);
    expect(failed.grading.status).toBe("failed");
    expect(failed.grading.attempts).toHaveLength(3);

    const codex = await prepareRun({ task, agent: "codex", runsRoot: root });
    expect(await readFile(join(codex.workspace, "README.md"), "utf8")).toContain(OPENROUTER_NOTE);
    for (const file of ["README.md", "TASK.md"]) {
      expect(await readFile(join(codex.workspace, file), "utf8")).toBe(await readFile(join(run.workspace, file), "utf8"));
    }
    expect(await readFile(join(codex.directory, "prompt.txt"), "utf8")).toBe(await readFile(join(run.directory, "prompt.txt"), "utf8"));
    await copyFile(join(codex.definition, "maintainer/reference_findings.json"), join(codex.workspace, "work/findings.json"));
    await copyFile(join(codex.definition, "maintainer/reference_report.md"), join(codex.workspace, "work/report.md"));
    const codexResult = await verifyRun(codex.id, root);
    expect(codexResult.grading.status, await readFile(codexResult.grading.report!, "utf8")).toBe("passed");
  }, 20000);
}
