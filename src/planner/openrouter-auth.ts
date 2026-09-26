/**
 * `jive auth openrouter`: prompts for an OpenRouter API key with the input masked
 * as it's typed, the way a password prompt would, since it's a secret entered
 * live. The key is only ever returned to the caller to write into `.env` — it is
 * never echoed to the terminal or logged.
 */

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
  write(data: string): unknown;
}

export interface PromptOpenRouterApiKeyOptions {
  /** @default process.stdin */
  stdin?: StdinLike;
  /** @default process.stdout */
  stdout?: StdoutLike;
}

const CTRL_C = "";
const ENTER = new Set(["\r", "\n"]);
const BACKSPACE = new Set(["", "\b"]);

/**
 * Reads one line from `stdin` with every typed character echoed as `*`, and
 * returns the trimmed value. Throws with a clear, single-line message if the
 * terminal is not interactive, the prompt is cancelled (Ctrl+C), or the entered
 * value is empty.
 */
export async function promptOpenRouterApiKey(options: PromptOpenRouterApiKeyOptions = {}): Promise<string> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;

  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error("`jive auth openrouter` needs an interactive terminal to prompt for the API key.");
  }

  stdout.write("OpenRouter API key: ");
  const wasRaw = stdin.isRaw ?? false;
  stdin.setRawMode(true);
  stdin.resume();

  let value = "";
  let onData!: (chunk: Buffer) => void;
  try {
    const key = await new Promise<string>((resolveValue, reject) => {
      onData = (chunk: Buffer) => {
        for (const char of chunk.toString("utf8")) {
          if (char === CTRL_C) {
            reject(new Error("`jive auth openrouter` cancelled."));
            return;
          }
          if (ENTER.has(char)) {
            stdout.write("\n");
            resolveValue(value.trim());
            return;
          }
          if (BACKSPACE.has(char)) {
            if (value.length > 0) {
              value = value.slice(0, -1);
              stdout.write("\b \b");
            }
            continue;
          }
          value += char;
          stdout.write("*");
        }
      };
      stdin.on("data", onData);
    });
    if (!key) throw new Error("`jive auth openrouter` needs a non-empty API key.");
    return key;
  } finally {
    stdin.off("data", onData);
    stdin.setRawMode(wasRaw);
    stdin.pause();
  }
}
