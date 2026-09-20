import { spawn } from "node:child_process";
import { open, access } from "node:fs/promises";

export async function capture(command: string[], cwd: string, timeoutMs = 5000): Promise<string | null> {
  return await new Promise(resolve => {
    const child = spawn(command[0]!, command.slice(1), { cwd, stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.on("data", chunk => { if (output.length < 128000) output += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("error", () => { clearTimeout(timer); resolve(null); });
    child.once("close", code => { clearTimeout(timer); resolve(code === 0 ? output.trim() : null); });
  });
}

async function descendants(pid: number): Promise<number[]> {
  const rows = (await capture(["ps", "-axo", "pid=,ppid="], "/tmp"))?.split("\n").map(line => line.trim().split(/\s+/).map(Number)) ?? [];
  const result: number[] = [];
  const visit = (parent: number) => { for (const [child, ppid] of rows) if (ppid === parent && child !== parent) { visit(child!); result.push(child!); } };
  visit(pid);
  return result;
}

export interface ProcessResult { exitCode: number | null; signal: string | null; cancelled: boolean; timedOut: boolean }

/** A retained supervisor forwards cancellation to descendants, including Jive's detached bash nodes. */
export async function runProcess(command: string[], options: {
  cwd: string; env?: NodeJS.ProcessEnv; stdout: string; stderr: string; interactive?: boolean;
  cancelFile?: string; timeoutMs?: number; onStart?: (pid: number) => Promise<void>;
}): Promise<ProcessResult> {
  if (options.cancelFile && await access(options.cancelFile).then(() => true, () => false)) return { exitCode: null, signal: null, cancelled: true, timedOut: false };
  const stdout = options.interactive ? undefined : await open(options.stdout, "a", 0o600);
  const stderr = options.interactive ? undefined : await open(options.stderr, "a", 0o600);
  let child: ReturnType<typeof spawn> | undefined;
  let cancelled = false, timedOut = false;
  let killing: Promise<void> | undefined;
  const stop = () => {
    cancelled = !timedOut;
    if (!child?.pid || killing) return;
    const pid = child.pid;
    killing = (async () => {
      const pids = [...await descendants(pid), pid];
      for (const target of pids) { try { process.kill(target, "SIGTERM"); } catch {} }
      await new Promise(resolve => setTimeout(resolve, 750));
      for (const target of pids) { try { process.kill(target, "SIGKILL"); } catch {} }
    })();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const timer = options.timeoutMs ? setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs) : undefined;
  const poll = options.cancelFile ? setInterval(() => { void access(options.cancelFile!).then(stop, () => {}); }, 250) : undefined;
  try {
    child = spawn(command[0]!, command.slice(1), {
      cwd: options.cwd, env: options.env ?? process.env,
      stdio: options.interactive ? "inherit" : ["ignore", stdout!.fd, stderr!.fd],
    });
    const completed = new Promise<{ exitCode: number | null; signal: string | null }>((resolve, reject) => {
      child!.once("error", reject);
      child!.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
    });
    // Attach the rejection handler before awaiting filesystem work in onStart.
    completed.catch(() => {});
    if (child.pid) await options.onStart?.(child.pid);
    const outcome = await completed;
    await killing;
    return { ...outcome, cancelled, timedOut };
  } catch (error) {
    if (child?.pid && child.exitCode === null && child.signalCode === null) { stop(); await killing; }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    if (poll) clearInterval(poll);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await Promise.all([stdout?.close(), stderr?.close()]);
  }
}
