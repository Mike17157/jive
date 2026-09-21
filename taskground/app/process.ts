import { spawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { access } from "node:fs/promises";
import { once } from "node:events";
import { finished } from "node:stream/promises";
import { HeadlessRecorder, normalizeRecordingOptions, type RecordingCaptureOptions, type RecordingStream } from "./recording";

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
  recording?: RecordingCaptureOptions;
}): Promise<ProcessResult> {
  if (options.cancelFile && await access(options.cancelFile).then(() => true, () => false)) return { exitCode: null, signal: null, cancelled: true, timedOut: false };
  if (options.interactive && options.recording) throw new Error("Transcript recording is only supported for headless processes, not interactive TTY sessions");
  const recording = options.recording ? normalizeRecordingOptions(options.recording) : undefined;
  const openLog = async (path: string) => {
    const stream = createWriteStream(path, { flags: "a", mode: 0o600 });
    await new Promise<void>((resolvePromise, reject) => {
      const opened = () => { cleanup(); resolvePromise(); };
      const failed = (error: Error) => { cleanup(); reject(error); };
      const cleanup = () => { stream.off("open", opened); stream.off("error", failed); };
      stream.once("open", opened); stream.once("error", failed);
    });
    return stream;
  };
  const stdout = options.interactive ? undefined : await openLog(options.stdout);
  let stderr: WriteStream | undefined;
  try { stderr = options.interactive ? undefined : await openLog(options.stderr); }
  catch (error) {
    stdout?.end();
    if (stdout) await finished(stdout).catch(() => {});
    throw error;
  }
  const stdoutFinished = stdout ? finished(stdout) : undefined;
  const stderrFinished = stderr ? finished(stderr) : undefined;
  stdoutFinished?.catch(() => {}); stderrFinished?.catch(() => {});
  let recorder: HeadlessRecorder | undefined;
  try { recorder = recording ? await HeadlessRecorder.create(recording) : undefined; }
  catch (error) {
    stdout?.end(); stderr?.end();
    await Promise.all([stdoutFinished, stderrFinished].map(promise => promise?.catch(() => {})));
    throw error;
  }
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
  let outputFailed = false;
  let rejectOutput!: (error: Error) => void;
  const outputFailure = new Promise<never>((_, reject) => { rejectOutput = reject; });
  const outputError = (error: unknown) => {
    if (outputFailed) return;
    outputFailed = true;
    stop();
    rejectOutput(error instanceof Error ? error : new Error(`Could not capture process output: ${String(error)}`));
  };
  stdout?.once("error", outputError); stderr?.once("error", outputError);
  const removeRecorderError = recorder?.onError(outputError);
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const timer = options.timeoutMs ? setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs) : undefined;
  const poll = options.cancelFile ? setInterval(() => { void access(options.cancelFile!).then(stop, () => {}); }, 250) : undefined;
  try {
    const env = recording
      ? { ...(options.env ?? process.env), COLUMNS: String(recording.columns), LINES: String(recording.rows) }
      : options.env ?? process.env;
    child = spawn(command[0]!, command.slice(1), {
      cwd: options.cwd, env,
      stdio: options.interactive ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    const tee = (source: NodeJS.ReadableStream, destination: WriteStream, stream: RecordingStream) => {
      source.on("data", (chunk: Buffer) => {
        try {
          const logReady = destination.write(chunk);
          const recordingReady = recorder?.write(stream, chunk) ?? true;
          if (logReady && recordingReady) return;
          source.pause();
          const waits: Promise<unknown>[] = [];
          if (!logReady && destination.writableNeedDrain) waits.push(once(destination, "drain"));
          if (!recordingReady) waits.push(recorder!.drain());
          void Promise.all(waits).then(() => {
            if (!outputFailed && !(source as NodeJS.ReadableStream & { destroyed?: boolean }).destroyed) source.resume();
          }, outputError);
        } catch (error) {
          source.pause(); outputError(error);
        }
      });
    };
    if (!options.interactive) {
      tee(child.stdout!, stdout!, "stdout");
      tee(child.stderr!, stderr!, "stderr");
    }
    const completed = new Promise<{ exitCode: number | null; signal: string | null }>((resolve, reject) => {
      child!.once("error", reject);
      child!.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
    });
    // Attach the rejection handler before awaiting filesystem work in onStart.
    completed.catch(() => {});
    if (child.pid) await options.onStart?.(child.pid);
    const outcome = await Promise.race([completed, outputFailure]);
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
    stdout?.removeListener("error", outputError); stderr?.removeListener("error", outputError);
    removeRecorderError?.();
    stdout?.end(); stderr?.end();
    await Promise.all([stdoutFinished, stderrFinished, recorder?.finish()]);
  }
}
