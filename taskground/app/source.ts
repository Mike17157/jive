import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, lstat, readFile, writeFile, chmod, cp } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { REPO_ROOT, fingerprint } from "./tasks";

export type SourceMode = "working" | "head" | "commit";
export interface SourceRecord {
  directory: string; revision: string | null; dirty: boolean; codeHash: string;
  branch?: string; mode?: SourceMode; snapshot?: string;
}

async function git(directory: string, args: string[]): Promise<Buffer> {
  const child = Bun.spawn(["git", "-C", directory, ...args], { stdout: "pipe", stderr: "pipe" });
  const [bytes, error, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text(), child.exited]);
  if (code) throw new Error(error.trim() || "Git command failed");
  return Buffer.from(bytes);
}

export async function primarySource(directory = REPO_ROOT) {
  const common = (await git(directory, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).toString().trim();
  const root = dirname(common);
  const revision = (await git(root, ["rev-parse", "HEAD"])).toString().trim();
  const branch = (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).toString().trim();
  return { directory: root, revision, branch };
}

function included(path: string) {
  const parts = path.split("/");
  return !parts.some(p => [".git", "node_modules", ".jev", ".context", ".cache", "__pycache__", ".DS_Store"].includes(p) || p === ".env" || p.startsWith(".env.") && p !== ".env.example") &&
    !/^(taskground\/task_runs|demos\/(source|edits))\//.test(path) &&
    !/\.(mp4|mov|cast)$/i.test(path);
}

/** Copy actual files, never checking out or changing the user's branch or index. */
export async function snapshotSource(destination: string, mode: SourceMode = "working", commit?: string, origin = REPO_ROOT): Promise<SourceRecord> {
  if (!["working", "head", "commit"].includes(mode)) throw new Error("Source must be working, head, or commit");
  if (mode === "commit" && (!commit || commit.startsWith("-"))) throw new Error("Provide a commit SHA or revision for --source commit");
  if (mode !== "commit" && commit) throw new Error("--commit requires --source commit");
  const source = await primarySource(origin);
  const revision = (await git(source.directory, ["rev-parse", "--verify", "--end-of-options", `${mode === "commit" ? commit : "HEAD"}^{commit}`])).toString().trim();
  await mkdir(destination, { recursive: true });
  let dirty = false;
  if (mode === "working") {
    const list = async () => [...new Set((await git(source.directory, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])).toString().split("\0").filter(p => p && included(p)))].sort();
    const files = await list();
    const stamps = new Map<string, string>();
    const stamp = async (path: string) => {
      try { const s = await lstat(join(source.directory, path)); return `${s.size}:${s.mtimeMs}:${s.mode}`; }
      catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return "missing"; throw e; }
    };
    for (const path of files) {
      const full = join(source.directory, path);
      stamps.set(path, await stamp(path));
      if (stamps.get(path) === "missing") continue;
      const info = await lstat(full);
      if (info.isSymbolicLink()) throw new Error(`Source snapshot cannot include symlink: ${path}`);
      if (!info.isFile()) continue;
      await mkdir(dirname(join(destination, path)), { recursive: true });
      await copyFile(full, join(destination, path));
      await chmod(join(destination, path), info.mode & 0o777);
    }
    const after = await primarySource(origin);
    if (JSON.stringify(files) !== JSON.stringify(await list()) || after.revision !== revision || after.branch !== source.branch)
      throw new Error("Source changed during preparation; retry the run");
    for (const path of files) if (stamps.get(path) !== await stamp(path)) throw new Error("Source changed during preparation; retry the run");
    dirty = Boolean((await git(source.directory, ["status", "--porcelain"])).length);
  } else {
    const tree = (await git(source.directory, ["ls-tree", "-r", "-z", revision])).toString().split("\0").filter(Boolean);
    // Reading blobs avoids tar traversal and never follows repository symlinks.
    for (const entry of tree) {
      const tab = entry.indexOf("\t"), path = entry.slice(tab + 1);
      if (!included(path)) continue;
      const [permissions, kind, oid] = entry.slice(0, tab).split(" ");
      if (permissions === "120000") throw new Error(`Source snapshot cannot include symlink: ${path}`);
      if (kind !== "blob") continue;
      const target = join(destination, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, await git(source.directory, ["cat-file", "blob", oid!]), { mode: permissions === "100755" ? 0o755 : 0o644 });
    }
  }
  return { ...source, revision, dirty, mode, snapshot: resolve(destination), codeHash: await fingerprint(destination) };
}

/** Keep each Jive run's dependencies independent of later installs in the main worktree. */
export async function snapshotDependencies(source: SourceRecord) {
  if (!source.snapshot) return;
  const lockHash = async (dir: string) => {
    const hash = createHash("sha256");
    for (const name of ["package.json", "bun.lock", "bun.lockb", "package-lock.json"])
      hash.update(await readFile(join(dir, name)).catch(() => Buffer.alloc(0)));
    return hash.digest("hex");
  };
  if (await lockHash(source.directory) === await lockHash(source.snapshot) && await lstat(join(source.directory, "node_modules")).then(s => s.isDirectory(), () => false)) {
    await cp(join(source.directory, "node_modules"), join(source.snapshot, "node_modules"), { recursive: true, dereference: true, mode: constants.COPYFILE_FICLONE });
  } else {
    const child = Bun.spawn([process.execPath, "install", "--frozen-lockfile", "--ignore-scripts"], { cwd: source.snapshot, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    await writeFile(join(dirname(source.snapshot), "logs/dependencies.log"), out + err);
    if (code) throw new Error("Could not install the selected source's dependencies; inspect logs/dependencies.log");
  }
}
