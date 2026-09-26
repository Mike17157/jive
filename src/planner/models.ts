import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { ModelOption } from "../core/types.ts";
import {
  ANTHROPIC_API_VERSION,
  anthropicCredentialHeaders,
  anthropicModelId,
  isDirectAnthropicModel,
  type AnthropicCredential,
} from "./anthropic.ts";

export const CURATED_MODEL_IDS = [
  "anthropic/claude-fable-5.1",
  "anthropic/claude-opus-5.5",
  "anthropic/claude-sonnet-5",
  "openai/gpt-6-astra",
  "openai/gpt-6-sol",
  "openai/gpt-5.6-sol",
  "google/gemini-3.1-pro-preview",
  "google/gemini-3.8-flash",
  "moonshotai/kimi-k3",
  "meta/muse-spark-1.3",
  "deepseek/deepseek-v4-pro-0813",
  "z-ai/glm-5.3",
] as const;

export type CuratedModelId = (typeof CURATED_MODEL_IDS)[number];

const MODEL_NAMES: Record<CuratedModelId, string> = {
  "anthropic/claude-fable-5.1": "Anthropic: Claude Fable 5.1",
  "anthropic/claude-opus-5.5": "Anthropic: Claude Opus 5.5",
  "anthropic/claude-sonnet-5": "Anthropic: Claude Sonnet 5",
  "openai/gpt-6-astra": "OpenAI: GPT-6 Astra",
  "openai/gpt-6-sol": "OpenAI: GPT-6 Sol",
  "openai/gpt-5.6-sol": "OpenAI: GPT-5.6 Sol",
  "google/gemini-3.1-pro-preview": "Google: Gemini 3.1 Pro Preview",
  "google/gemini-3.8-flash": "Google: Gemini 3.8 Flash",
  "moonshotai/kimi-k3": "MoonshotAI: Kimi K3",
  "meta/muse-spark-1.3": "Meta: Muse Spark 1.3",
  "deepseek/deepseek-v4-pro-0813": "DeepSeek: DeepSeek V4 Pro 0813",
  "z-ai/glm-5.3": "Z.ai: GLM 5.3",
};

export const CURATED_MODELS: readonly ModelOption[] = CURATED_MODEL_IDS.map((id) => ({
  id,
  name: MODEL_NAMES[id],
}));

export interface OpenRouterCatalogModel {
  id: string;
  name?: string;
  context_length?: number;
  supported_parameters?: string[];
  reasoning?: {
    mandatory?: boolean;
    default_enabled?: boolean;
    supported_efforts?: string[] | null;
    default_effort?: string;
  };
}

export interface ModelCatalog {
  fetchedAt: string;
  models: OpenRouterCatalogModel[];
}

export interface FetchModelCatalogOptions {
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  apiKey?: string;
  endpoint?: string;
}

export function modelCatalogCachePath(cwd: string): string {
  return join(resolve(cwd), ".jev", "openrouter-models.json");
}

export async function loadCachedModelCatalog(cwd: string): Promise<ModelCatalog | undefined> {
  try {
    const parsed = JSON.parse(await readFile(modelCatalogCachePath(cwd), "utf8")) as ModelCatalog;
    if (!Array.isArray(parsed.models) || typeof parsed.fetchedAt !== "string") return undefined;
    return parsed;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    return undefined;
  }
}

export async function saveModelCatalog(cwd: string, catalog: ModelCatalog): Promise<void> {
  const path = modelCatalogCachePath(cwd);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
}

export async function fetchOpenRouterModelCatalog(
  options: FetchModelCatalogOptions = {},
): Promise<ModelCatalog> {
  const transport = options.fetch ?? globalThis.fetch;
  const endpoint = options.endpoint ?? "https://openrouter.ai/api/v1/models?supported_parameters=tools";
  const response = await transport(endpoint, {
    method: "GET",
    headers: options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : undefined,
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(`OpenRouter model catalog request failed (${response.status}).`);
  }
  const body = await response.json() as { data?: OpenRouterCatalogModel[] };
  if (!Array.isArray(body.data)) throw new Error("OpenRouter returned an invalid model catalog.");
  return {
    fetchedAt: new Date().toISOString(),
    models: body.data.filter(
      (model) =>
        typeof model.id === "string" &&
        Array.isArray(model.supported_parameters) &&
        model.supported_parameters.includes("tools"),
    ),
  };
}

export function mergeModelOptions(
  catalog?: ModelCatalog,
  customIds: readonly string[] = [],
): ModelOption[] {
  const liveById = new Map(catalog?.models.map((model) => [model.id, model]) ?? []);
  const ids = [...CURATED_MODEL_IDS, ...customIds.filter((id) => !CURATED_MODEL_IDS.includes(id as CuratedModelId))];
  return ids.map((id) => {
    const live = liveById.get(id);
    const curated = CURATED_MODELS.find((option) => option.id === id);
    const reasoning = live?.reasoning;
    let reasoningEfforts: string[] | undefined;
    if (live) {
      if (reasoning?.supported_efforts === null) {
        reasoningEfforts = [...GATEWAY_REASONING_EFFORTS];
      } else if (Array.isArray(reasoning?.supported_efforts)) {
        reasoningEfforts = reasoning.supported_efforts.filter(
          (effort): effort is string => typeof effort === "string",
        );
      } else reasoningEfforts = [];
      if (reasoning?.mandatory) reasoningEfforts = reasoningEfforts.filter((effort) => effort !== "none");
    }
    return {
      id,
      name: live?.name || curated?.name || id,
      ...(typeof live?.context_length === "number" ? { contextLength: live.context_length } : {}),
      ...(reasoningEfforts !== undefined ? { reasoningEfforts } : {}),
      ...(typeof reasoning?.default_effort === "string"
        ? { reasoningDefault: reasoning.default_effort }
        : {}),
      ...(typeof reasoning?.mandatory === "boolean"
        ? { reasoningMandatory: reasoning.mandatory }
        : {}),
    };
  });
}

/**
 * Anthropic's own `/v1/models` shape (verified empirically against the live API): `data[]`
 * entries carry `capabilities.thinking.supported` (extended thinking available at all) and,
 * separately, `capabilities.effort` (Anthropic's own graduated-effort feature, which jive's
 * `AnthropicClient` does not use). jive always sends the classic `thinking: {type:"enabled",
 * budget_tokens}` shape regardless of the `effort` capability — confirmed live against a
 * model that advertises `effort.supported: false` (claude-haiku-4-5) and one that advertises
 * only "adaptive" thinking, not "enabled" (claude-opus-5-5): both accepted the classic shape
 * and returned a normal completion. So `thinking.supported` alone gates whether jive's fixed
 * effort vocabulary (below) applies; the graduated `effort` field is not consulted.
 */
export interface AnthropicCatalogModel {
  id: string;
  display_name?: string;
  max_input_tokens?: number;
  capabilities?: {
    thinking?: { supported?: boolean };
  };
}

export interface AnthropicModelCatalog {
  fetchedAt: string;
  models: AnthropicCatalogModel[];
}

export interface FetchAnthropicModelCatalogOptions {
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  credential: AnthropicCredential;
  endpoint?: string;
}

export function anthropicModelCatalogCachePath(cwd: string): string {
  return join(resolve(cwd), ".jev", "anthropic-models.json");
}

export async function loadCachedAnthropicModelCatalog(cwd: string): Promise<AnthropicModelCatalog | undefined> {
  try {
    const parsed = JSON.parse(await readFile(anthropicModelCatalogCachePath(cwd), "utf8")) as AnthropicModelCatalog;
    if (!Array.isArray(parsed.models) || typeof parsed.fetchedAt !== "string") return undefined;
    return parsed;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    return undefined;
  }
}

export async function saveAnthropicModelCatalog(cwd: string, catalog: AnthropicModelCatalog): Promise<void> {
  const path = anthropicModelCatalogCachePath(cwd);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
}

/**
 * Anthropic's `/v1/models` is cursor-paginated (`has_more`/`last_id` + `after_id`), unlike
 * OpenRouter's single-page list; verified live that a page without `after_id` already
 * returns every model with `has_more: false`, but this still follows the cursor in case the
 * live catalog ever outgrows one page.
 */
export async function fetchAnthropicModelCatalog(
  options: FetchAnthropicModelCatalogOptions,
): Promise<AnthropicModelCatalog> {
  const transport = options.fetch ?? globalThis.fetch;
  const endpoint = options.endpoint ?? "https://api.anthropic.com/v1/models";
  const headers = { "anthropic-version": ANTHROPIC_API_VERSION, ...anthropicCredentialHeaders(options.credential) };
  const models: AnthropicCatalogModel[] = [];
  let afterId: string | undefined;
  for (;;) {
    const url = new URL(endpoint);
    if (afterId) url.searchParams.set("after_id", afterId);
    const response = await transport(url.toString(), { method: "GET", headers, signal: options.signal });
    if (!response.ok) {
      throw new Error(`Anthropic model catalog request failed (${response.status}).`);
    }
    const body = await response.json() as { data?: AnthropicCatalogModel[]; has_more?: boolean; last_id?: string };
    if (!Array.isArray(body.data)) throw new Error("Anthropic returned an invalid model catalog.");
    models.push(...body.data);
    if (!body.has_more || !body.last_id) break;
    afterId = body.last_id;
  }
  return { fetchedAt: new Date().toISOString(), models };
}

/**
 * The subset of `customIds`/curated ids Anthropic's own API can serve directly right now:
 * an `anthropic/claude-*` id whose `anthropicModelId()` transform matches a live model id.
 * A curated id that does not match (jive's dotted version suffixes vs. Anthropic's dashed
 * ones, confirmed live to 404 for at least one curated id) is left out rather than shown as
 * servable — this is what keeps the picker honest about what `/provider anthropic` can
 * actually call, without changing how `AnthropicClient` builds requests.
 */
export function mergeAnthropicModelOptions(
  catalog?: AnthropicModelCatalog,
  customIds: readonly string[] = [],
): ModelOption[] {
  const liveByApiId = new Map(catalog?.models.map((model) => [model.id, model]) ?? []);
  const candidateIds = [
    ...CURATED_MODEL_IDS,
    ...customIds.filter((id) => !CURATED_MODEL_IDS.includes(id as CuratedModelId)),
  ];
  const ids = candidateIds.filter(
    (id) => isDirectAnthropicModel(id) && liveByApiId.has(anthropicModelId(id)),
  );
  return ids.map((id) => {
    const live = liveByApiId.get(anthropicModelId(id))!;
    const curated = CURATED_MODELS.find((option) => option.id === id);
    const reasoningEfforts = live.capabilities?.thinking?.supported
      ? ["none", "low", "medium", "high", "xhigh", "max"]
      : [];
    return {
      id,
      name: live.display_name || curated?.name || id,
      ...(typeof live.max_input_tokens === "number" ? { contextLength: live.max_input_tokens } : {}),
      reasoningEfforts,
    };
  });
}

/** OpenRouter's gateway-wide effort vocabulary, highest effort first. */
export const GATEWAY_REASONING_EFFORTS = [
  "max",
  "xhigh",
  "high",
  "medium",
  "low",
  "minimal",
  "none",
] as const;

export function cacheConfigurationForModel(model: string): Record<string, unknown> {
  // OpenAI, recent Gemini, DeepSeek, and Z.AI use implicit caching through
  // OpenRouter. Anthropic-family routes support the recommended automatic
  // breakpoint, which advances while the underlying messages stay immutable.
  if (model.startsWith("anthropic/")) {
    return { cache_control: { type: "ephemeral" } };
  }
  return {};
}
