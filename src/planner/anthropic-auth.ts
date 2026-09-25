/**
 * `jive auth`: runs `claude setup-token` (a Claude Code subcommand) so a Claude
 * subscription's long-lived OAuth token can be generated and saved without the
 * captain hand-copying it into `.env` themselves.
 *
 * `claude setup-token` is a full-screen, raw-mode terminal program: it renders
 * nothing at all unless its stdio is a real TTY, so it is run attached to a PTY
 * (`Bun.spawn`'s `terminal` option) with that PTY's bytes relayed live to this
 * process's own stdin/stdout — the captain sees and drives the same browser
 * sign-in and code-paste prompts they would running it directly. The relayed
 * bytes are also buffered so the printed token can be pulled out once it exits.
 */
import { access, constants as fsConstants } from "node:fs/promises";
import { delimiter, join } from "node:path";

/** Claude Code's long-lived OAuth tokens: `sk-ant-oat01-` plus a base64url payload. */
const OAUTH_TOKEN_PATTERN = /sk-ant-oat01-[A-Za-z0-9_-]{20,}/;

/** Drops ANSI/OSC terminal escape sequences so a token can be matched in plain text. */
function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC ... BEL or ST (hyperlinks, titles)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "") // CSI sequences (cursor moves, colors, ...)
    .replace(/\x1b[()#][0-9A-Za-z]/g, ""); // charset designators
}

/** Pulls the OAuth token out of `claude setup-token`'s (possibly ANSI-styled) output. */
export function extractAnthropicOauthToken(rawOutput: string): string | undefined {
  return stripAnsi(rawOutput).match(OAUTH_TOKEN_PATTERN)?.[0];
}

/** Whether `command` exists and is executable somewhere on `pathEnv`. */
export async function isExecutableOnPath(command: string, pathEnv = process.env.PATH ?? ""): Promise<boolean> {
  for (const directory of pathEnv.split(delimiter)) {
    if (!directory) continue;
    try {
      await access(join(directory, command), fsConstants.X_OK);
      return true;
    } catch {
      // not in this PATH entry
    }
  }
  return false;
}

/**
 * Only the parts of `process.stdin`/`process.stdout` this module drives —
 * spelled out (rather than `Pick<NodeJS.ReadStream, ...>`) so a plain
 * `EventEmitter`-based test double satisfies them without impersonating
 * every other member of Node's stream types.
 */
interface StdinLike {
  isTTY: boolean | undefined;
  isRaw: boolean | undefined;
  setRawMode(enabled: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  off(event: "data", listener: (chunk: Buffer) => void): unknown;
}
interface StdoutLike {
  isTTY: boolean | undefined;
  columns: number | undefined;
  rows: number | undefined;
  write(data: Uint8Array): unknown;
  on(event: "resize", listener: () => void): unknown;
  off(event: "resize", listener: () => void): unknown;
}

export interface RunClaudeSetupTokenOptions {
  /** @default Bun.spawn */
  spawn?: typeof Bun.spawn;
  /** @default process.stdin */
  stdin?: StdinLike;
  /** @default process.stdout */
  stdout?: StdoutLike;
  /** @default isExecutableOnPath */
  commandOnPath?: (command: string) => Promise<boolean>;
}

/**
 * Runs `claude setup-token` attached to a PTY and returns the OAuth token it
 * prints on success. Throws with a clear, single-line message if `claude` is
 * missing, the terminal is not interactive, or the flow is cancelled or fails
 * without ever printing a recognizable token.
 */
export async function runClaudeSetupToken(options: RunClaudeSetupTokenOptions = {}): Promise<string> {
  const spawn = options.spawn ?? Bun.spawn;
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const commandOnPath = options.commandOnPath ?? isExecutableOnPath;

  if (process.platform === "win32") {
    throw new Error("`jive auth` needs a PTY, which Bun does not support on Windows — run `claude setup-token` yourself and set ANTHROPIC_OAUTH_TOKEN.");
  }
  if (!(await commandOnPath("claude"))) {
    throw new Error("`claude` is not on PATH — install Claude Code (https://claude.com/claude-code), then retry `jive auth`.");
  }
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error("`jive auth` needs an interactive terminal, to open the browser sign-in and accept a pasted code.");
  }

  const decoder = new TextDecoder();
  let transcript = "";
  const env: NodeJS.ProcessEnv = { ...process.env, TERM: process.env.TERM ?? "xterm-256color" };
  delete env.COLUMNS;
  delete env.LINES;

  const child = spawn(["claude", "setup-token"], {
    env,
    terminal: {
      cols: stdout.columns ?? 80,
      rows: stdout.rows ?? 24,
      data(_terminal, bytes) {
        transcript += decoder.decode(bytes, { stream: true });
        stdout.write(bytes);
      },
    },
  });
  const terminal = child.terminal!;

  const wasRaw = stdin.isRaw ?? false;
  const onStdin = (chunk: Buffer) => terminal.write(chunk);
  const onResize = () => terminal.resize(stdout.columns ?? 80, stdout.rows ?? 24);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.on("data", onStdin);
  stdout.on("resize", onResize);

  let exitCode: number;
  try {
    exitCode = await child.exited;
  } finally {
    stdin.off("data", onStdin);
    stdout.off("resize", onResize);
    stdin.setRawMode(wasRaw);
    stdin.pause();
  }

  const token = extractAnthropicOauthToken(transcript);
  if (token) return token;
  throw new Error(exitCode === 0
    ? "`claude setup-token` finished without printing a recognizable token."
    : `\`claude setup-token\` exited with code ${exitCode} without printing a token — sign-in may have been cancelled.`);
}
