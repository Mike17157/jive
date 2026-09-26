import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  fetchAnthropicModelCatalog,
  loadCachedAnthropicModelCatalog,
  mergeAnthropicModelOptions,
  saveAnthropicModelCatalog,
} from "../src/planner/models.ts";

const temporaryDirectories: string[] = [];
const originalFetch = globalThis.fetch;

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function makeCwd(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "jive-models-test-"));
  temporaryDirectories.push(cwd);
  return cwd;
}

describe("mergeAnthropicModelOptions", () => {
  test("only lists curated ids Anthropic's own catalog actually recognizes", () => {
    const models = mergeAnthropicModelOptions({
      fetchedAt: "2026-09-25T00:00:00.000Z",
      models: [
        { id: "claude-sonnet-5", display_name: "Claude Sonnet 5", max_input_tokens: 1_000_000, capabilities: { thinking: { supported: true } } },
      ],
    });
    // "claude-opus-5.5" (curated) has no live match (Anthropic's real id is dashed, not
    // dotted), so it is left off rather than shown as servable; only sonnet-5 matches.
    expect(models.map((model) => model.id)).toEqual(["anthropic/claude-sonnet-5"]);
    expect(models[0]).toMatchObject({
      id: "anthropic/claude-sonnet-5",
      name: "Claude Sonnet 5",
      contextLength: 1_000_000,
      reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
    });
  });

  test("excludes non-Claude ids entirely, even as a custom id", () => {
    const models = mergeAnthropicModelOptions(
      { fetchedAt: "2026-09-25T00:00:00.000Z", models: [] },
      ["openai/gpt-6-astra"],
    );
    expect(models).toEqual([]);
  });

  test("includes a custom anthropic/claude-* id once it matches the live catalog", () => {
    const models = mergeAnthropicModelOptions(
      {
        fetchedAt: "2026-09-25T00:00:00.000Z",
        models: [{ id: "claude-haiku-4-5-20251001", display_name: "Claude Haiku 4.5", capabilities: { thinking: { supported: false } } }],
      },
      ["anthropic/claude-haiku-4-5-20251001"],
    );
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ id: "anthropic/claude-haiku-4-5-20251001", reasoningEfforts: [] });
  });

  test("with no catalog at all, nothing is servable", () => {
    expect(mergeAnthropicModelOptions(undefined, ["anthropic/claude-sonnet-5"])).toEqual([]);
  });
});

describe("fetchAnthropicModelCatalog", () => {
  test("follows has_more/after_id pagination and sends the credential + version headers", async () => {
    const requests: { url: string; headers: Record<string, string> }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      if (!url.includes("after_id")) {
        return new Response(JSON.stringify({ data: [{ id: "claude-sonnet-5" }], has_more: true, last_id: "claude-sonnet-5" }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [{ id: "claude-opus-5-5" }], has_more: false, last_id: "claude-opus-5-5" }), { status: 200 });
    }) as unknown as typeof fetch;

    const catalog = await fetchAnthropicModelCatalog({ credential: { kind: "oauth", value: "test-oauth-token" } });
    expect(catalog.models.map((model) => model.id)).toEqual(["claude-sonnet-5", "claude-opus-5-5"]);
    expect(requests).toHaveLength(2);
    expect(requests[0]!.url).toBe("https://api.anthropic.com/v1/models");
    expect(requests[1]!.url).toContain("after_id=claude-sonnet-5");
    expect(requests[0]!.headers["anthropic-version"]).toBe("2023-06-01");
    expect(requests[0]!.headers.Authorization).toBe("Bearer test-oauth-token");
  });

  test("sends x-api-key instead of a bearer token for a plain API key credential", async () => {
    let seenHeaders: Record<string, string> = {};
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response(JSON.stringify({ data: [], has_more: false }), { status: 200 });
    }) as unknown as typeof fetch;
    await fetchAnthropicModelCatalog({ credential: { kind: "api-key", value: "sk-ant-test" } });
    expect(seenHeaders["x-api-key"]).toBe("sk-ant-test");
    expect(seenHeaders.Authorization).toBeUndefined();
  });

  test("throws clearly on a non-OK response", async () => {
    globalThis.fetch = (async () => new Response("", { status: 401 })) as unknown as typeof fetch;
    await expect(fetchAnthropicModelCatalog({ credential: { kind: "api-key", value: "bad" } }))
      .rejects.toThrow(/401/);
  });
});

describe("Anthropic model catalog cache", () => {
  test("round-trips through the .jev cache file", async () => {
    const cwd = await makeCwd();
    expect(await loadCachedAnthropicModelCatalog(cwd)).toBeUndefined();
    const catalog = { fetchedAt: "2026-09-25T00:00:00.000Z", models: [{ id: "claude-sonnet-5" }] };
    await saveAnthropicModelCatalog(cwd, catalog);
    expect(await loadCachedAnthropicModelCatalog(cwd)).toEqual(catalog);
  });
});
