import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { primarySource, snapshotSource } from "../taskground/app/source";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function git(cwd: string, ...args: string[]) {
  const child = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code) throw new Error(err); return out.trim();
}
async function repository() {
  const root = await mkdtemp(join(tmpdir(), "taskground-source-")); roots.push(root);
  const repo = join(root, "repo"); await mkdir(repo);
  await git(repo, "init", "-q"); await git(repo, "config", "user.name", "Test"); await git(repo, "config", "user.email", "test@localhost");
  await writeFile(join(repo, "code.txt"), "first"); await writeFile(join(repo, "deleted.txt"), "original");
  await writeFile(join(repo, ".gitignore"), "ignored\n.env\n");
  await git(repo, "add", "."); await git(repo, "-c", "commit.gpgsign=false", "commit", "-qm", "first");
  return { root, repo };
}

test("working snapshots include edits, deletions and untracked files without secrets; commits remain exact", async () => {
  const { root, repo } = await repository();
  const first = await git(repo, "rev-parse", "HEAD");
  await writeFile(join(repo, "code.txt"), "second");
  await git(repo, "add", "."); await git(repo, "-c", "commit.gpgsign=false", "commit", "-qm", "second");
  await writeFile(join(repo, "code.txt"), "working");
  await writeFile(join(repo, "new.txt"), "untracked"); await writeFile(join(repo, ".env"), "secret");
  await writeFile(join(repo, "ignored"), "ignored"); await rm(join(repo, "deleted.txt"));
  const before = await git(repo, "status", "--porcelain");
  const working = await snapshotSource(join(root, "working"), "working", undefined, repo);
  const head = await snapshotSource(join(root, "head"), "head", undefined, repo);
  const old = await snapshotSource(join(root, "old"), "commit", first, repo);
  expect(await readFile(join(working.snapshot!, "code.txt"), "utf8")).toBe("working");
  expect(await readFile(join(working.snapshot!, "new.txt"), "utf8")).toBe("untracked");
  for (const file of ["deleted.txt", ".env", "ignored"]) expect(await Bun.file(join(working.snapshot!, file)).exists()).toBe(false);
  expect(await readFile(join(head.snapshot!, "code.txt"), "utf8")).toBe("second");
  expect(await readFile(join(old.snapshot!, "code.txt"), "utf8")).toBe("first");
  expect(working.dirty).toBe(true); expect(head.dirty).toBe(false); expect(old.revision).toBe(first);
  await writeFile(join(repo, "code.txt"), "changed after launch");
  expect(await readFile(join(working.snapshot!, "code.txt"), "utf8")).toBe("working");
  expect(await git(repo, "status", "--porcelain")).toBe(before);
});

test("source selection always resolves the primary worktree even from a linked checkout", async () => {
  const { root, repo } = await repository();
  const other = join(root, "linked");
  await git(repo, "worktree", "add", "-qb", "other", other);
  await writeFile(join(repo, "code.txt"), "primary edits");
  await writeFile(join(other, "code.txt"), "other edits");
  expect((await primarySource(other)).directory).toBe(await Bun.$`realpath ${repo}`.text().then(v => v.trim()));
  const snapshot = await snapshotSource(join(root, "snapshot"), "working", undefined, other);
  expect(await readFile(join(snapshot.snapshot!, "code.txt"), "utf8")).toBe("primary edits");
});

test("invalid source revisions fail without interpreting shell fragments or changing branches", async () => {
  const { root, repo } = await repository();
  const before = await git(repo, "rev-parse", "HEAD");
  await expect(snapshotSource(join(root, "bad"), "commit", "HEAD; touch injected", repo)).rejects.toThrow();
  await expect(snapshotSource(join(root, "option"), "commit", "--help", repo)).rejects.toThrow();
  expect(await git(repo, "rev-parse", "HEAD")).toBe(before);
  expect(await Bun.file(join(repo, "injected")).exists()).toBe(false);
});
