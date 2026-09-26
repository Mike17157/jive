import type { PlannerMessage } from "../session/types.ts";
import { ANTHROPIC_REASONING_BUDGETS } from "./openrouter.ts";
import {
  DEFAULT_RETRY_POLICY,
  parseRetryAfter,
  parseServerSentEvents,
  type CompleteOptions,
  type OpenRouterCompletion,
  type OpenRouterUsage,
  type RetryPolicy,
} from "./openrouter.ts";

/** `anthropic/claude-*` is the only family this direct client knows how to call. */
export function isDirectAnthropicModel(model: string): boolean {
  return model.startsWith("anthropic/claude-");
}

/** Anthropic's own model id is jive's id with the routing prefix stripped. */
export function anthropicModelId(model: string): string {
  return model.slice("anthropic/".length);
}

export interface AnthropicCredential {
  /** `oauth` is a `claude setup-token` subscription token; `api-key` is a pay-per-token key. */
  kind: "oauth" | "api-key";
  value: string;
}

/**
 * `ANTHROPIC_OAUTH_TOKEN` first, `ANTHROPIC_API_KEY` as fallback — the same precedence
 * Claude Code itself uses, so a subscription token bills against the Claude subscription
 * instead of pay-per-token API pricing whenever one is configured.
 */
export function resolveAnthropicCredential(env: NodeJS.ProcessEnv = process.env): AnthropicCredential | undefined {
  const oauth = env.ANTHROPIC_OAUTH_TOKEN?.trim();
  if (oauth) return { kind: "oauth", value: oauth };
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (apiKey) return { kind: "api-key", value: apiKey };
  return undefined;
}

/**
 * A request authenticated with a Claude-subscription OAuth token is only accepted by
 * api.anthropic.com when its first system block matches one of a small set of strings
 * Anthropic's own tooling sends; anything else in that position fails closed with an
 * auth error ("not authorized for use with Claude Code"). This is the identity the
 * Claude Agent SDK sends, confirmed against the live API; it costs nothing on the
 * plain-API-key path, so it is sent either way to keep one request shape.
 */
const CLAUDE_SUBSCRIPTION_IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

/** Anthropic requires an explicit ceiling; OpenRouter's client never sets one. */
const RESPONSE_HEADROOM_TOKENS = 16_000;

/** Anthropic's own version header; every direct call (messages, models) sends this exact value. */
export const ANTHROPIC_API_VERSION = "2023-06-01";

/**
 * The Authorization/x-api-key + anthropic-beta shape shared by every Anthropic endpoint
 * this codebase calls directly, so the models-list catalog fetch (models.ts) can send the
 * same credential shape as `AnthropicClient` without duplicating it. Verified empirically
 * against the live models-list endpoint: the OAuth bearer form works there exactly as it
 * does for messages, and `anthropic-version` is required while `anthropic-beta` is not
 * (sent anyway to keep one shape).
 */
export function anthropicCredentialHeaders(credential: AnthropicCredential): Record<string, string> {
  if (credential.kind === "oauth") {
    return { Authorization: `Bearer ${credential.value}`, "anthropic-beta": "oauth-2025-04-20" };
  }
  return { "x-api-key": credential.value };
}

function authHeaders(credential: AnthropicCredential): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "anthropic-version": ANTHROPIC_API_VERSION,
    ...anthropicCredentialHeaders(credential),
  };
}

/** The reasoning object for one request, or undefined to leave thinking off. */
function thinkingParameters(effort: string | undefined): { type: "enabled"; budget_tokens: number } | undefined {
  if (!effort || effort === "none") return undefined;
  const budget = ANTHROPIC_REASONING_BUDGETS[effort];
  if (budget === undefined) return undefined;
  return { type: "enabled", budget_tokens: budget };
}

function maxTokensFor(thinking: { budget_tokens: number } | undefined): number {
  return (thinking?.budget_tokens ?? 0) + RESPONSE_HEADROOM_TOKENS;
}

export class AnthropicError extends Error {
  readonly status?: number;
  readonly details?: unknown;
  /** Set when the same request could plausibly succeed on a second attempt. */
  readonly retryable: boolean;
  /** A delay the provider asked for, in milliseconds. */
  readonly retryAfterMs?: number;

  constructor(message: string, options: { status?: number; details?: unknown; cause?: unknown; retryable?: boolean; retryAfterMs?: number } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AnthropicError";
    this.status = options.status;
    this.details = options.details;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
  }
}

const TRANSIENT_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);
const TRANSIENT_ERROR_TYPES = new Set(["overloaded_error", "api_error", "timeout_error", "rate_limit_error"]);
const MAX_HONOURED_RETRY_AFTER_MS = 30_000;

function transientErrorPayload(payload: unknown): boolean {
  const type = payload && typeof payload === "object" ? (payload as Record<string, unknown>).type : undefined;
  return typeof type === "string" && TRANSIENT_ERROR_TYPES.has(type);
}

function retryReason(error: AnthropicError): string {
  if (error.status === 429 || /rate.?limit/i.test(error.message)) return "rate limited";
  if (error.status === 529 || /overloaded/i.test(error.message)) return "overloaded";
  if (error.status !== undefined && error.status >= 500) return `provider error ${error.status}`;
  if (/Could not reach Anthropic/.test(error.message)) return "network error";
  if (/stream/i.test(error.message)) return "stream interrupted";
  return "transient error";
}

function retryDelay(error: unknown, attempt: number, policy: RetryPolicy): number | undefined {
  if (!(error instanceof AnthropicError) || !error.retryable) return undefined;
  if (attempt >= policy.attempts) return undefined;
  const backoff = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  const jittered = Math.round(backoff * (0.7 + Math.random() * 0.6));
  const asked = Math.min(error.retryAfterMs ?? 0, MAX_HONOURED_RETRY_AFTER_MS);
  return Math.max(asked, jittered);
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((done, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); done(); }, ms);
    const abort = () => { clearTimeout(timer); reject(signal?.reason); };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

type AnthropicContentBlock = Record<string, unknown> & { type: string; cache_control?: { type: "ephemeral" } };
interface AnthropicMessage { role: "user" | "assistant"; content: AnthropicContentBlock[] }

/**
 * OpenAI-shaped history to Anthropic's shape: system messages become the top-level
 * `system` blocks, tool results become `tool_result` blocks in a user turn (batching
 * consecutive ones, since Anthropic requires every result for a round in one message),
 * and reasoning is replayed only while continuing with the same model that produced it.
 */
function buildMessages(messages: readonly PlannerMessage[], model: string): { system: AnthropicContentBlock[]; conversation: AnthropicMessage[] } {
  const system: AnthropicContentBlock[] = [];
  const conversation: AnthropicMessage[] = [];
  let pendingToolResults: AnthropicContentBlock[] | undefined;

  const flushToolResults = () => {
    if (pendingToolResults) {
      conversation.push({ role: "user", content: pendingToolResults });
      pendingToolResults = undefined;
    }
  };

  for (const message of messages) {
    if (message.role === "system") {
      flushToolResults();
      if (message.content) system.push({ type: "text", text: message.content });
      continue;
    }
    if (message.role === "tool") {
      const block: AnthropicContentBlock = {
        type: "tool_result",
        tool_use_id: message.tool_call_id ?? "",
        content: message.content ?? "",
      };
      pendingToolResults = pendingToolResults ? [...pendingToolResults, block] : [block];
      continue;
    }
    flushToolResults();
    if (message.role === "user") {
      conversation.push({ role: "user", content: [{ type: "text", text: message.content ?? "" }] });
      continue;
    }
    // assistant
    const blocks: AnthropicContentBlock[] = [];
    const sameModel = !message.model || message.model === model;
    if (sameModel && message.reasoning_details) {
      const details = Array.isArray(message.reasoning_details) ? message.reasoning_details : [message.reasoning_details];
      for (const detail of details) {
        if (detail && typeof detail === "object") blocks.push(detail as AnthropicContentBlock);
      }
    }
    if (typeof message.content === "string" && message.content) blocks.push({ type: "text", text: message.content });
    for (const call of message.tool_calls ?? []) {
      let input: unknown = {};
      try { input = call.function.arguments ? JSON.parse(call.function.arguments) : {}; } catch { input = {}; }
      blocks.push({ type: "tool_use", id: call.id, name: call.function.name, input });
    }
    conversation.push({ role: "assistant", content: blocks });
  }
  flushToolResults();
  return { system, conversation };
}

/** The last cacheable block gets the breakpoint; thinking blocks cannot carry one. */
function lastCacheableBlock(blocks: AnthropicContentBlock[]): AnthropicContentBlock | undefined {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]!;
    if (block.type !== "thinking" && block.type !== "redacted_thinking") return block;
  }
  return undefined;
}

function applyCacheControl(system: AnthropicContentBlock[], conversation: AnthropicMessage[]): void {
  const lastSystem = lastCacheableBlock(system);
  if (lastSystem) lastSystem.cache_control = { type: "ephemeral" };
  const lastMessage = conversation.at(-1);
  const lastBlock = lastMessage ? lastCacheableBlock(lastMessage.content) : undefined;
  if (lastBlock) lastBlock.cache_control = { type: "ephemeral" };
}

function anthropicTools(toolSchema: Record<string, unknown> | Record<string, unknown>[]): Record<string, unknown>[] {
  const schemas = Array.isArray(toolSchema) ? toolSchema : [toolSchema];
  return schemas.map((schema, index) => ({
    name: schema.name,
    description: schema.description,
    input_schema: schema.parameters,
    ...(index === schemas.length - 1 ? { cache_control: { type: "ephemeral" } } : {}),
  }));
}

function normalizeUsage(started: Record<string, unknown> | undefined, finished: Record<string, unknown> | undefined): OpenRouterUsage {
  const number = (candidate: unknown) => typeof candidate === "number" ? candidate : 0;
  const inputTokens = number(started?.input_tokens);
  const outputTokens = number(finished?.output_tokens ?? started?.output_tokens);
  const cachedTokens = number(started?.cache_read_input_tokens);
  const cacheWriteTokens = number(started?.cache_creation_input_tokens);
  return {
    promptTokens: inputTokens,
    completionTokens: outputTokens,
    totalTokens: inputTokens + outputTokens,
    cachedTokens,
    cacheWriteTokens,
  };
}

/** Anthropic's stop reasons to the OpenAI-shaped ones the rest of jive checks for. */
function normalizeFinishReason(stopReason: unknown): string | undefined {
  switch (stopReason) {
    case "end_turn":
    case "stop_sequence":
    case "pause_turn":
      return "stop";
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    case "refusal":
      return "content_filter";
    default:
      return undefined;
  }
}

interface BlockAccumulator {
  kind: "text" | "tool_use" | "thinking" | "redacted_thinking" | "other";
  toolCallIndex?: number;
  id?: string;
  name?: string;
  arguments?: string;
  thinking?: string;
  signature?: string;
  data?: string;
}

export interface AnthropicClientOptions {
  credential: AnthropicCredential;
  fetch?: typeof globalThis.fetch;
  endpoint?: string;
  retry?: Partial<RetryPolicy>;
}

/**
 * Calls Anthropic's Messages API directly (not through OpenRouter). Mirrors
 * OpenRouterClient's `complete()` contract so the planner can select either
 * transport for the same request without branching on the result shape.
 */
export class AnthropicClient {
  readonly credential: AnthropicCredential;
  readonly endpoint: string;
  readonly fetch: typeof globalThis.fetch;
  readonly retry: RetryPolicy;

  constructor(options: AnthropicClientOptions) {
    this.credential = options.credential;
    this.endpoint = options.endpoint ?? "https://api.anthropic.com/v1/messages";
    this.fetch = options.fetch ?? globalThis.fetch;
    this.retry = { ...DEFAULT_RETRY_POLICY, ...options.retry };
  }

  async complete(options: CompleteOptions): Promise<OpenRouterCompletion> {
    const policy: RetryPolicy = { ...this.retry, ...options.retry };
    for (let attempt = 1; ; attempt += 1) {
      let handedOver = false;
      try {
        return await this.#attempt(options, () => { handedOver = true; });
      } catch (error) {
        options.signal?.throwIfAborted();
        const delay = handedOver ? undefined : retryDelay(error, attempt, policy);
        if (delay === undefined) throw error;
        const failure = error as AnthropicError;
        options.onRetry?.({ attempt, attempts: policy.attempts, delayMs: delay, reason: retryReason(failure), error: failure });
        await wait(delay, options.signal);
      }
    }
  }

  async #attempt(options: CompleteOptions, handOver: () => void): Promise<OpenRouterCompletion> {
    const model = anthropicModelId(options.model);
    const { system, conversation } = buildMessages(options.messages, options.model);
    system.unshift({ type: "text", text: CLAUDE_SUBSCRIPTION_IDENTITY });
    applyCacheControl(system, conversation);
    const thinking = thinkingParameters(options.effort);

    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokensFor(thinking),
      system,
      messages: conversation,
      tools: anthropicTools(options.toolSchema),
      stream: true,
      ...(thinking ? { thinking } : {}),
    };

    let response: Response;
    try {
      response = await this.fetch(this.endpoint, {
        method: "POST",
        headers: authHeaders(this.credential),
        body: JSON.stringify(body),
        signal: options.signal,
      });
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason ?? error;
      throw new AnthropicError(
        `Could not reach Anthropic: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error, retryable: true },
      );
    }

    if (!response.ok) {
      const raw = await response.text();
      let details: unknown = raw.slice(0, 4_000);
      try { details = JSON.parse(raw); } catch { /* keep bounded text */ }
      const remoteMessage = details && typeof details === "object" && "error" in details
        ? JSON.stringify((details as Record<string, unknown>).error)
        : raw.slice(0, 500);
      throw new AnthropicError(
        `Anthropic request failed (${response.status}${response.statusText ? ` ${response.statusText}` : ""}): ${remoteMessage || "empty response"}`,
        {
          status: response.status,
          details,
          retryable: TRANSIENT_STATUS.has(response.status),
          retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
        },
      );
    }
    if (!response.body) throw new AnthropicError("Anthropic returned an empty streaming response.");

    let content = "";
    let reasoning = "";
    let reasoningDetails: unknown[] | undefined;
    let messageStart: Record<string, unknown> | undefined;
    let messageDeltaUsage: Record<string, unknown> | undefined;
    let finishReason: string | undefined;
    const blocks = new Map<number, BlockAccumulator>();
    let nextToolCallIndex = 0;
    let done = false;

    try {
      for await (const event of parseServerSentEvents(response.body)) {
        if (!event.data) continue;
        let chunk: Record<string, any>;
        try {
          chunk = JSON.parse(event.data) as Record<string, any>;
        } catch (error) {
          throw new AnthropicError("Anthropic sent malformed SSE JSON.", {
            details: event.data.slice(0, 1_000),
            cause: error,
            retryable: true,
          });
        }
        const type = chunk.type ?? event.event;
        if (type === "error") {
          const reported = typeof chunk.error?.message === "string" ? chunk.error.message : JSON.stringify(chunk.error ?? chunk);
          throw new AnthropicError(`Anthropic stream failed: ${reported}`, {
            details: chunk.error ?? chunk,
            retryable: transientErrorPayload(chunk.error),
          });
        }
        if (type === "message_start") {
          messageStart = chunk.message?.usage;
          continue;
        }
        if (type === "content_block_start") {
          const index = chunk.index as number;
          const block = chunk.content_block ?? {};
          if (block.type === "tool_use") {
            const accumulator: BlockAccumulator = { kind: "tool_use", toolCallIndex: nextToolCallIndex, id: block.id, name: block.name, arguments: "" };
            nextToolCallIndex += 1;
            blocks.set(index, accumulator);
            handOver();
            await options.onToolCall?.({ index: accumulator.toolCallIndex!, id: accumulator.id ?? "", name: accumulator.name ?? "", arguments: "", argumentsDelta: "" });
          } else if (block.type === "thinking") {
            blocks.set(index, { kind: "thinking", thinking: "", signature: "" });
          } else if (block.type === "redacted_thinking") {
            blocks.set(index, { kind: "redacted_thinking", data: typeof block.data === "string" ? block.data : "" });
            options.onReasoning?.();
          } else {
            blocks.set(index, { kind: "text" });
          }
          continue;
        }
        if (type === "content_block_delta") {
          const index = chunk.index as number;
          const accumulator = blocks.get(index);
          const delta = chunk.delta ?? {};
          if (!accumulator) continue;
          if (delta.type === "text_delta" && typeof delta.text === "string") {
            content += delta.text;
            if (delta.text) handOver();
            options.onContent?.(delta.text);
          } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
            accumulator.thinking = (accumulator.thinking ?? "") + delta.thinking;
            reasoning += delta.thinking;
            if (delta.thinking) handOver();
            options.onReasoning?.(delta.thinking);
          } else if (delta.type === "signature_delta" && typeof delta.signature === "string") {
            accumulator.signature = (accumulator.signature ?? "") + delta.signature;
          } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
            accumulator.arguments = (accumulator.arguments ?? "") + delta.partial_json;
            handOver();
            await options.onToolCall?.({
              index: accumulator.toolCallIndex!,
              id: accumulator.id ?? "",
              name: accumulator.name ?? "",
              arguments: accumulator.arguments,
              argumentsDelta: delta.partial_json,
            });
          }
          continue;
        }
        if (type === "content_block_stop") {
          const index = chunk.index as number;
          const accumulator = blocks.get(index);
          if (accumulator?.kind === "thinking") {
            reasoningDetails ??= [];
            reasoningDetails.push({ type: "thinking", thinking: accumulator.thinking ?? "", signature: accumulator.signature ?? "" });
          } else if (accumulator?.kind === "redacted_thinking") {
            reasoningDetails ??= [];
            reasoningDetails.push({ type: "redacted_thinking", data: accumulator.data ?? "" });
          }
          continue;
        }
        if (type === "message_delta") {
          if (typeof chunk.delta?.stop_reason === "string" || chunk.delta?.stop_reason === null) {
            finishReason = normalizeFinishReason(chunk.delta.stop_reason);
          }
          if (chunk.usage) messageDeltaUsage = chunk.usage;
          continue;
        }
        if (type === "message_stop") {
          done = true;
          break;
        }
        // "ping" and any future event types are ignored.
      }
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason ?? error;
      if (error instanceof AnthropicError) throw error;
      throw new AnthropicError(
        `Anthropic stream was interrupted: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error, retryable: true },
      );
    }

    if (!done && options.signal?.aborted) throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
    if (!done && !finishReason) {
      throw new AnthropicError("Anthropic stream ended before a completion marker.", { retryable: true });
    }
    const toolCalls = [...blocks.values()]
      .filter((accumulator): accumulator is BlockAccumulator & { toolCallIndex: number } => accumulator.kind === "tool_use")
      .sort((left, right) => left.toolCallIndex - right.toolCallIndex)
      .map((accumulator, index) => ({
        id: accumulator.id || `tool-call-${index}`,
        type: "function" as const,
        function: { name: accumulator.name ?? "", arguments: accumulator.arguments ?? "" },
      }));
    if (finishReason === "length" || finishReason === "content_filter") {
      throw new AnthropicError(`Anthropic completion ended with ${finishReason} before the full tool call was accepted.`);
    }
    if (toolCalls.length > 0 && finishReason !== "tool_calls" && finishReason !== "stop") {
      throw new AnthropicError("Anthropic did not confirm completion of the tool calls.");
    }
    if (toolCalls.length === 0 && !content.trim()) {
      throw new AnthropicError("Anthropic returned no answer or tool call.", { retryable: true });
    }
    const message: PlannerMessage = {
      role: "assistant",
      content: content || null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      ...(reasoning ? { reasoning } : {}),
      ...(reasoningDetails ? { reasoning_details: reasoningDetails } : {}),
      model: options.model,
      provider: "anthropic",
    };
    return {
      message,
      usage: normalizeUsage(messageStart, messageDeltaUsage),
      model: options.model,
      provider: "anthropic",
      ...(finishReason ? { finishReason } : {}),
    };
  }
}
