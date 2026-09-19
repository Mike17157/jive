import { normalizeSessionName } from "./names.ts";

export const SESSION_NAMING_MODEL = "google/gemma-3-27b-it";
export const SESSION_NAMING_RETRIES = 3;
const SESSION_NAME_MAX_LENGTH = 48;

export interface SessionNamingInput {
  sessionId: string;
  userMessage: string;
  assistantMessage?: string;
}

export type SessionNameGenerator = (
  input: SessionNamingInput,
  signal?: AbortSignal,
) => Promise<string>;

export interface OpenRouterSessionNamerOptions {
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  endpoint?: string;
  model?: string;
  /** Retries after the initial request. */
  retries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Session naming was aborted."));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function contentFromResponse(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return "";
  const content = (choices[0] as { message?: { content?: unknown } } | undefined)?.message?.content;
  if (typeof content !== "string") return "";
  try {
    const parsed = JSON.parse(content) as { name?: unknown };
    if (typeof parsed.name === "string") return parsed.name;
  } catch {
    // A provider may ignore response_format. A validated plain-text title is safe.
  }
  return content;
}

/** Small, isolated OpenRouter request used only for cosmetic session naming. */
export class OpenRouterSessionNamer {
  readonly apiKey: string;
  readonly fetch: typeof globalThis.fetch;
  readonly endpoint: string;
  readonly model: string;
  readonly retries: number;
  readonly retryDelayMs: number;
  readonly timeoutMs: number;

  constructor(options: OpenRouterSessionNamerOptions) {
    this.apiKey = options.apiKey;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.endpoint = options.endpoint ?? "https://openrouter.ai/api/v1/chat/completions";
    this.model = options.model ?? SESSION_NAMING_MODEL;
    this.retries = options.retries ?? SESSION_NAMING_RETRIES;
    this.retryDelayMs = options.retryDelayMs ?? 250;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  generate: SessionNameGenerator = async (input, signal) => {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      signal?.throwIfAborted();
      try {
        const timeout = AbortSignal.timeout(this.timeoutMs);
        const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
        const response = await this.fetch(this.endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: this.model,
            messages: [
              {
                role: "system",
                content: [
                  "Name this coding-agent session.",
                  "Return a concrete 3-7 word title, at most 48 characters.",
                  "Preserve useful issue IDs, filenames, and commands.",
                  "Do not use quotes, Markdown, trailing punctuation, or generic words such as Session or Task.",
                ].join(" "),
              },
              {
                role: "user",
                content: [
                  `First request:\n${input.userMessage.slice(0, 4_000)}`,
                  input.assistantMessage
                    ? `\nFirst outcome:\n${input.assistantMessage.slice(0, 2_000)}`
                    : "",
                ].join(""),
              },
            ],
            temperature: 0.2,
            max_tokens: 80,
            response_format: {
              type: "json_schema",
              json_schema: {
                name: "session_name",
                strict: true,
                schema: {
                  type: "object",
                  properties: {
                    name: { type: "string", minLength: 1, maxLength: SESSION_NAME_MAX_LENGTH },
                  },
                  required: ["name"],
                  additionalProperties: false,
                },
              },
            },
          }),
          signal: requestSignal,
        });
        if (!response.ok) {
          throw new Error(`OpenRouter naming request failed (${response.status}).`);
        }
        const name = normalizeSessionName(contentFromResponse(await response.json()), SESSION_NAME_MAX_LENGTH);
        if (!name) throw new Error("OpenRouter returned an empty session name.");
        return name;
      } catch (error) {
        signal?.throwIfAborted();
        lastError = error;
        if (attempt < this.retries) {
          await wait(this.retryDelayMs * 2 ** attempt, signal);
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  };
}
