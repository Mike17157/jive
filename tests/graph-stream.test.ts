import { describe, expect, test } from "bun:test";

import { GraphStreamParser, type GraphStreamUpdate } from "../src/core/graph-stream";

function feedByCharacter(parser: GraphStreamParser, json: string): GraphStreamUpdate[] {
  const updates: GraphStreamUpdate[] = [];
  for (let index = 0; index < json.length; index += 1) {
    updates.push(...parser.push(json.slice(index, index + 1)));
  }
  return updates;
}

function eagerHeader(returns: string[] = []) {
  return {
    eager: true,
    version: 1,
    label: "eager graph",
    context: {},
    templates: {},
    limits: {},
    returns,
  };
}

describe("GraphStreamParser", () => {
  test("handles character splits, escapes, Unicode and quoted braces without false closes", () => {
    const script = 'printf "%s" "}{ \\\\"quoted\\\\" \\\\ path 東京 🚀"';
    const graph = {
      version: 1,
      label: "split 🚀",
      nodes: {
        inspect: { type: "bash", script },
      },
    };
    const json = JSON.stringify(graph);
    const parser = new GraphStreamParser();
    const updates = feedByCharacter(parser, json);

    expect(updates).toHaveLength(1);
    expect(updates[0]?.kind).toBe("preview");
    const node = updates[0]?.graph.nodes.inspect;
    expect(node && "script" in node ? node.script : undefined).toBe(script);
    expect(structuredClone(updates[0]!.graph)).toEqual(updates[0]!.graph);
    expect(parser.finish()).toEqual(graph as any);
  });

  test("never commits an unfinished command", () => {
    const prefix = `${JSON.stringify(eagerHeader(["write"])).slice(0, -1)},"nodes":{"write":{"type":"bash","script":"echo unfinished`;
    const parser = new GraphStreamParser();
    expect(feedByCharacter(parser, prefix)).toEqual([]);
    expect(() => parser.finish()).toThrow("truncated JSON");
  });

  test("commits only validated backward-dependent prefixes and filters future returns", () => {
    const graph = {
      ...eagerHeader(["first", "second"]),
      output: { $ref: "/nodes/second/output" },
      nodes: {
        first: { type: "bash", script: "printf first" },
        second: { type: "bash", needs: ["first"], script: "printf second" },
      },
    };
    const parser = new GraphStreamParser();
    const updates = feedByCharacter(parser, JSON.stringify(graph));

    expect(updates.map((update) => update.kind)).toEqual(["commit", "commit"]);
    expect(Object.keys(updates[0]!.graph.nodes)).toEqual(["first"]);
    expect(updates[0]!.graph.returns).toEqual(["first"]);
    expect(Object.keys(updates[1]!.graph.nodes)).toEqual(["first", "second"]);
    expect(updates[1]!.graph.returns).toEqual(["first", "second"]);
    expect(parser.finish()).toEqual(graph as any);
  });

  test("supports groups before nodes when templates are frozen in the eager header", () => {
    const graph = {
      eager: true,
      version: 1,
      label: "groups first",
      context: {},
      templates: {
        item: { nodes: { show: { type: "bash", script: "printf item" } } },
      },
      limits: {},
      returns: ["batch", "after"],
      groups: {
        batch: { kind: "foreach", items: [], template: "item", maxItems: 1 },
      },
      nodes: {
        after: { type: "bash", needs: ["batch"], script: "printf done" },
      },
    };
    const parser = new GraphStreamParser();
    const updates = parser.push(JSON.stringify(graph));

    expect(updates).toHaveLength(2);
    expect(updates[0]?.kind).toBe("commit");
    expect(updates[0]?.graph.nodes).toEqual({});
    expect(Object.keys(updates[0]?.graph.groups ?? {})).toEqual(["batch"]);
    expect(updates[0]?.graph.returns).toEqual(["batch"]);
    expect(updates[1]?.graph.returns).toEqual(["batch", "after"]);
    expect(parser.finish()).toEqual(graph as any);
  });

  test("rejects duplicate header, node, and nested keys before they can revise effects", () => {
    const duplicateHeader = new GraphStreamParser();
    expect(() => duplicateHeader.push('{"version":1,"version":1'))
      .toThrow("Duplicate key");

    const header = JSON.stringify(eagerHeader([])).slice(0, -1);
    const duplicateNode = new GraphStreamParser();
    const first = `${header},"nodes":{"same":{"type":"bash","script":"first"},`;
    expect(duplicateNode.push(first)).toHaveLength(1);
    expect(() => duplicateNode.push('"same":{"type":"bash","script":"second"}}}'))
      .toThrow('Duplicate key "same"');

    const duplicateNested = new GraphStreamParser();
    expect(() => duplicateNested.push('{"version":1,"label":"x","nodes":{"a":{"type":"bash","script":"one","script":"two"}}}'))
      .toThrow('Duplicate key "script"');
  });

  test("freezes eager headers and requires every early header before work starts", () => {
    const missing = new GraphStreamParser();
    expect(() => missing.push('{"eager":true,"version":1,"label":"x","returns":[],"nodes":{'))
      .toThrow("missing completed header fields");

    const late = new GraphStreamParser();
    const prefix = `${JSON.stringify(eagerHeader([])).slice(0, -1)},"nodes":{},`;
    expect(late.push(prefix)).toEqual([]);
    expect(() => late.push('"output":null}')).toThrow("header is frozen");

    const lateOptIn = new GraphStreamParser();
    expect(() => lateOptIn.push('{"version":1,"label":"x","nodes":{},"eager":true}'))
      .toThrow("must be fully declared before nodes or groups");

    const invalidHeader = new GraphStreamParser();
    const withUnknown = `${JSON.stringify({ ...eagerHeader([]), unknown: true }).slice(0, -1)},"nodes":{"a":{"type":"bash","script":"never"}}}`;
    expect(() => invalidHeader.push(withUnknown)).toThrow("Invalid graph");
  });

  test("adopts definitions written past a prematurely closed nodes or groups map", () => {
    const header = JSON.stringify({
      ...eagerHeader(["collect", "classify", "merge"]),
      templates: { round: { nodes: { fetch: { type: "bash", script: "printf hi" } } } },
    }).slice(0, -1);
    const parser = new GraphStreamParser();
    const updates = feedByCharacter(parser, `${header},"nodes":{"collect":{"type":"bash","script":"printf collect"}}`
      + ',"groups":{"classify":{"kind":"foreach","items":[],"template":"round","maxItems":1}}'
      + ',"merge":{"type":"bash","needs":["classify"],"script":"printf merge"}'
      + ',"later":{"kind":"repeat","template":"round","initial":{},"next":{},"until":{"op":"exists","args":[1]},"maxIterations":1}}');

    expect(updates.map((update) => update.kind)).toEqual(["commit", "commit", "commit", "commit"]);
    const last = updates.at(-1)!.graph;
    expect(Object.keys(last.nodes)).toEqual(["collect", "merge"]);
    expect(Object.keys(last.groups ?? {})).toEqual(["classify", "later"]);
    expect(last.returns).toEqual(["collect", "classify", "merge"]);
    expect((last as unknown as Record<string, unknown>).merge).toBeUndefined();
    expect(parser.finish()).toEqual(last as any);
    expect(parser.repairs).toEqual([
      "/merge: moved into /nodes; the nodes map was closed before this definition",
      "/later: moved into /groups; the groups map was closed before this definition",
    ]);

    const duplicate = new GraphStreamParser();
    duplicate.push(`${header},"nodes":{"collect":{"type":"bash","script":"printf collect"}}`);
    expect(() => duplicate.push(',"collect":{"type":"bash","script":"printf again"}}'))
      .toThrow('Duplicate nodes entry "collect"');
  });

  test("normal previews allow forward references but eager commits reject them", () => {
    const normalGraph = {
      version: 1,
      label: "normal forward reference",
      nodes: {
        first: { type: "bash", needs: ["later"], script: "printf first" },
        later: { type: "bash", script: "printf later" },
      },
    };
    const normal = new GraphStreamParser();
    const previews = normal.push(JSON.stringify(normalGraph));
    expect(previews).toHaveLength(2);
    expect(previews[0]?.kind).toBe("preview");
    expect(normal.finish()).toEqual(normalGraph as any);

    const eager = new GraphStreamParser();
    const eagerGraph = { ...eagerHeader([]), nodes: normalGraph.nodes };
    expect(() => eager.push(JSON.stringify(eagerGraph))).toThrow("Unknown dependency later");
  });

  test("repairs a string version in both eager commits and the final graph, and remembers what it changed", () => {
    const eager = new GraphStreamParser();
    const header = JSON.stringify({ ...eagerHeader(["a"]), version: "1" }).slice(0, -1);
    const updates = eager.push(`${header},"nodes":{"a":{"type":"bash","script":"printf a"}}}`);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.kind).toBe("commit");
    expect(updates[0]?.graph.version).toBe(1);
    expect(eager.finish().version).toBe(1);
    expect(eager.repairs).toEqual(['/version: coerced the string "1" to the number 1']);

    const normal = new GraphStreamParser();
    normal.push(JSON.stringify({ version: "1", label: "x", nodes: JSON.stringify({ a: { type: "bash", script: "ls" } }) }));
    expect(normal.finish()).toEqual({ version: 1, label: "x", nodes: { a: { type: "bash", script: "ls" } } } as any);
    expect(normal.repairs).toHaveLength(2);

    const clean = new GraphStreamParser();
    clean.push('{"version":1,"label":"x","nodes":{}}');
    clean.finish();
    expect(clean.repairs).toEqual([]);
  });

  test("rejects malformed, schema-invalid, and truncated final input", () => {
    const malformed = new GraphStreamParser();
    expect(() => malformed.push('{"version":1,,')).toThrow("Unexpected comma");
    const badNumber = new GraphStreamParser();
    expect(() => badNumber.push('{"version":01')).toThrow("Invalid number character");

    const invalid = new GraphStreamParser();
    expect(invalid.push('{"version":1,"label":"invalid","nodes":{"bad":{"type":"bash"}}}'))
      .toHaveLength(1);
    expect(() => invalid.finish()).toThrow("Invalid graph");

    const truncated = new GraphStreamParser();
    truncated.push('{"version":1,"label":"cut","nodes":{}');
    expect(() => truncated.finish()).toThrow("truncated JSON");
  });
});
