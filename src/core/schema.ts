import Ajv from "ajv";
import { references } from "./expressions";
import type { Graph, GraphBody, Group, Node } from "./types";

const common = {
  label: { type: "string", maxLength: 200 }, needs: { type: "array", items: { type: "string" }, uniqueItems: true },
  when: { $ref: "#/$defs/condition" }, allowFailedDependencies: { type: "boolean" }, onError: { enum: ["continue", "stop"] },
};
const positive = { type: "integer", minimum: 1 };
export const graphSchema: Record<string, any> = {
  type: "object", additionalProperties: false, required: ["version", "label", "nodes"],
  properties: {
    version: { const: 1 }, label: { type: "string", minLength: 1, maxLength: 200 }, eager: { type: "boolean" }, context: {},
    nodes: { $ref: "#/$defs/nodes" }, groups: { $ref: "#/$defs/groups" }, output: {},
    templates: { type: "object", maxProperties: 100, additionalProperties: { $ref: "#/$defs/body" } },
    returns: { type: "array", items: { type: "string" }, uniqueItems: true },
    limits: { type: "object", additionalProperties: false, properties: {
      maxNodes: { ...positive, maximum: 5000 }, concurrency: { ...positive, maximum: 32 },
      timeoutMs: { ...positive, maximum: 3600000 }, maxJevCalls: { type: "integer", minimum: 0, maximum: 1000 },
    } },
  },
  $defs: {
    condition: { type: "object", additionalProperties: false, required: ["op", "args"], properties: {
      op: { enum: ["eq", "ne", "gt", "gte", "lt", "lte", "and", "or", "not", "exists", "in"] },
      args: { type: "array", minItems: 1, items: {} },
    } },
    nodes: { type: "object", maxProperties: 200, propertyNames: { pattern: "^[a-zA-Z][a-zA-Z0-9_-]*$" }, additionalProperties: { oneOf: [
      { type: "object", additionalProperties: false, required: ["type", "script"], properties: {
        ...common, type: { const: "bash" }, script: { type: "string", minLength: 1 }, cwd: { type: "string" },
        env: { type: "object", additionalProperties: {} }, stdin: {}, timeoutMs: { ...positive, maximum: 3600000 },
        acceptedExitCodes: { type: "array", minItems: 1, uniqueItems: true, items: { type: "integer", minimum: 0, maximum: 255 } },
        outputFormat: { enum: ["text", "json"] },
      } },
      { type: "object", additionalProperties: false, required: ["type", "state", "questions", "accept"], properties: {
        ...common, type: { const: "jev" }, state: {}, questions: {}, accept: { $ref: "#/$defs/condition" },
        prepare: { type: "array", items: { type: "object", additionalProperties: false, required: ["use", "as", "input"], properties: {
          use: { type: "string", minLength: 1 }, as: { type: "string", pattern: "^[a-zA-Z][a-zA-Z0-9_-]*$" }, input: {}, config: {},
        } } },
        select: { type: "object", additionalProperties: { type: "object", additionalProperties: false, required: ["from", "key"], properties: { from: {}, key: {} } } },
      } },
    ] } },
    groups: { type: "object", maxProperties: 100, propertyNames: { pattern: "^[a-zA-Z][a-zA-Z0-9_-]*$" }, additionalProperties: { oneOf: [
      { type: "object", additionalProperties: false, required: ["kind", "items", "template", "maxItems"], properties: {
        ...common, kind: { const: "foreach" }, items: {}, input: {}, template: { type: "string" },
        maxItems: { ...positive, maximum: 5000 }, concurrency: { ...positive, maximum: 32 }, onItemFailure: { enum: ["fail", "continue"] },
      } },
      { type: "object", additionalProperties: false, required: ["kind", "template", "initial", "next", "until", "maxIterations"], properties: {
        ...common, kind: { const: "repeat" }, template: { type: "string" }, initial: {}, next: {},
        until: { $ref: "#/$defs/condition" }, maxIterations: { ...positive, maximum: 1000 },
      } },
    ] } },
    body: { type: "object", additionalProperties: false, required: ["nodes"], properties: {
      nodes: { $ref: "#/$defs/nodes" }, groups: { $ref: "#/$defs/groups" }, output: {},
    } },
  },
};
const validate = new Ajv({ allErrors: true, strict: false }).compile(graphSchema);

export function dependencyInputs(def: Node | Group): unknown {
  if ("type" in def) return def;
  return def.kind === "foreach" ? { items: def.items, input: def.input, when: def.when } : { initial: def.initial, when: def.when };
}
export function dependencies(def: Node | Group): string[] {
  return [...new Set([...(def.needs ?? []), ...references(dependencyInputs(def)).flatMap(ref => {
    const match = /^\/(?:nodes|groups)\/([^/]+)/.exec(ref); return match ? [match[1]!] : [];
  })])];
}
type AjvError = NonNullable<typeof validate.errors>[number];

function valueAt(root: unknown, pointer: string): unknown {
  let current: unknown = root;
  for (const raw of pointer.split("/").slice(1)) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Short, model-facing description of a value that failed validation. */
export function describeValue(value: unknown): string {
  if (value === undefined) return "nothing";
  if (value === null) return "null";
  if (typeof value === "string") return `the string ${JSON.stringify(value.length > 60 ? `${value.slice(0, 60)}…` : value)}`;
  if (typeof value === "number" || typeof value === "boolean") return `the ${typeof value} ${value}`;
  if (Array.isArray(value)) return `an array of ${value.length} items`;
  const keys = Object.keys(value as object);
  return keys.length ? `an object with keys ${keys.slice(0, 6).join(", ")}${keys.length > 6 ? ", …" : ""}` : "an empty object";
}

const DISCRIMINATORS: Array<{ parent: string; key: "type" | "kind"; options: string[] }> = [
  { parent: "nodes", key: "type", options: ["bash", "jev"] },
  { parent: "groups", key: "kind", options: ["foreach", "repeat"] },
];

function describeError(root: unknown, error: AjvError): string {
  const path = error.instancePath || "/";
  const received = () => describeValue(valueAt(root, error.instancePath));
  const params = error.params as Record<string, unknown>;
  switch (error.keyword) {
    case "const": return `${path} must be ${describeValue(params.allowedValue)} (received ${received()})`;
    case "enum": return `${path} must be one of ${(params.allowedValues as unknown[]).map(v => JSON.stringify(v)).join(", ")} (received ${received()})`;
    case "type": return `${path} must be ${params.type === "object" ? "a JSON object, not a JSON-encoded string" : params.type} (received ${received()})`;
    case "required": return `${path} is missing required property ${JSON.stringify(params.missingProperty)}`;
    case "additionalProperties": return `${path} has unknown property ${JSON.stringify(params.additionalProperty)}`;
    case "propertyNames": return `${path} has invalid ID ${JSON.stringify(params.propertyName)}; IDs must match ^[a-zA-Z][a-zA-Z0-9_-]*$`;
    case "minLength": return `${path} must not be empty`;
    case "maxLength": case "maxItems": case "maxProperties": case "maximum": return `${path} ${error.message} (received ${received()})`;
    default: return `${path} ${error.message}`;
  }
}

/**
 * Ajv reports every oneOf branch with allErrors, which buries the real mistake under
 * complaints from the branch the model never chose. Keep only the discriminated branch.
 */
function relevantErrors(root: unknown, errors: AjvError[]): AjvError[] {
  const dropped = new Set<AjvError>();
  const replacements: AjvError[] = [];
  for (const error of errors) {
    if (error.keyword !== "oneOf") continue;
    const scope = error.instancePath;
    // Ajv reports schemaPath relative to the $ref target, so the entry kind comes from the instance path.
    const parent = /\/(nodes|groups)\/[^/]+$/.exec(scope)?.[1];
    const discriminator = DISCRIMINATORS.find(entry => entry.parent === parent);
    const inside = errors.filter(candidate => candidate !== error && candidate.instancePath.startsWith(scope)
      && (candidate.instancePath.length === scope.length || candidate.instancePath[scope.length] === "/"));
    dropped.add(error);
    if (!discriminator) continue;
    const value = valueAt(root, scope) as Record<string, unknown> | undefined;
    const branch = discriminator.options.indexOf(String(value?.[discriminator.key]));
    if (branch < 0) {
      for (const candidate of inside) dropped.add(candidate);
      replacements.push({ ...error, keyword: "enum", instancePath: `${scope}/${discriminator.key}`,
        params: { allowedValues: discriminator.options }, message: "" });
      continue;
    }
    for (const candidate of inside) {
      const match = /\/oneOf\/(\d+)\//.exec(candidate.schemaPath);
      if (match && Number(match[1]) !== branch) dropped.add(candidate);
    }
  }
  return [...errors.filter(error => !dropped.has(error)), ...replacements];
}

export function formatValidationErrors(root: unknown, errors: AjvError[]): string {
  const messages = relevantErrors(root, errors).map(error => describeError(root, error));
  return [...new Set(messages)].join("; ");
}

/** Root fields that models sometimes write inside the nodes map after closing it late. */
const HOISTABLE_ROOT_KEYS = ["returns", "limits", "context", "templates", "groups", "eager", "output"] as const;
/** Keys models use in place of $ref when a provider drops the schema descriptions. */
const POINTER_ALIASES = new Set(["ref", "path", "pointer", "$path", "$pointer"]);
/** A pointer into a graph namespace; a file path such as /src/index.ts never matches. */
const POINTER_PATTERN = /^\/(?:nodes|groups|context|item|index|input|state|prepared|answers)(?:\/|$)/;

function repairExpressions(value: unknown, path: string, repairs: string[]): unknown {
  if (Array.isArray(value)) return value.map((entry, index) => repairExpressions(entry, `${path}/${index}`, repairs));
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (Object.hasOwn(record, "$literal")) return value;
  const keys = Object.keys(record);
  const alias = keys.length === 1 ? keys[0]! : undefined;
  if (alias && POINTER_ALIASES.has(alias) && typeof record[alias] === "string" && POINTER_PATTERN.test(record[alias] as string)) {
    repairs.push(`${path}: rewrote {"${alias}": ...} as {"$ref": ...}; a reference is an object whose only key is $ref`);
    return { $ref: record[alias] };
  }
  return Object.fromEntries(keys.map(key => [key, repairExpressions(record[key], `${path}/${key}`, repairs)]));
}

/**
 * Normalize the mistakes that models on loosely-typed tool schemas make most: version sent as the
 * string "1", nodes/groups/templates/context sent as JSON-encoded strings, root fields written
 * inside the nodes map, and references spelled ref/path instead of $ref.
 * Returns a copy; the original is untouched. Repairs are described for the tool result.
 */
export function repairGraph(value: unknown): { value: unknown; repairs: string[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { value, repairs: [] };
  const repairs: string[] = [];
  const graph: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  if (graph.version === "1") { graph.version = 1; repairs.push('/version: coerced the string "1" to the number 1'); }
  const parseEmbedded = (target: Record<string, unknown>, key: string, path: string) => {
    const raw = target[key];
    if (typeof raw !== "string") return;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return; }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      target[key] = parsed; repairs.push(`${path}: parsed a JSON-encoded string into an object; send an object directly`);
    }
  };
  parseEmbedded(graph, "nodes", "/nodes");
  if (graph.nodes && typeof graph.nodes === "object" && !Array.isArray(graph.nodes)) {
    const nodes: Record<string, unknown> = { ...(graph.nodes as Record<string, unknown>) };
    for (const key of HOISTABLE_ROOT_KEYS) {
      const entry = nodes[key];
      const looksLikeNode = entry !== null && typeof entry === "object" && !Array.isArray(entry) && Object.hasOwn(entry, "type");
      if (entry === undefined || looksLikeNode || graph[key] !== undefined) continue;
      graph[key] = entry; delete nodes[key];
      repairs.push(`/nodes/${key}: moved to the top level; ${key} is a sibling of nodes, not a node`);
    }
    graph.nodes = nodes;
  }
  for (const key of ["groups", "templates", "context"]) parseEmbedded(graph, key, `/${key}`);
  if (graph.templates && typeof graph.templates === "object" && !Array.isArray(graph.templates)) {
    const templates: Record<string, unknown> = { ...(graph.templates as Record<string, unknown>) };
    for (const [name, body] of Object.entries(templates)) {
      if (!body || typeof body !== "object" || Array.isArray(body)) continue;
      const copy: Record<string, unknown> = { ...(body as Record<string, unknown>) };
      for (const key of ["nodes", "groups"]) parseEmbedded(copy, key, `/templates/${name}/${key}`);
      templates[name] = copy;
    }
    graph.templates = templates;
  }
  // context is data and may legitimately hold {path: ...}; only program text is rewritten.
  for (const key of ["nodes", "groups", "templates"]) if (graph[key] !== undefined) graph[key] = repairExpressions(graph[key], `/${key}`, repairs);
  return { value: graph, repairs };
}

export const GRAPH_VALIDATION_PREFIX = "Invalid graph: ";
/** Shown to the planner alongside every schema rejection so it can resubmit without guessing. */
export const GRAPH_VALIDATION_HINT = "The graph was rejected before anything ran. Fix the listed paths: when the result carries a graphId, call execute_graph_mod with that base and only the edits; otherwise resubmit the whole graph. version is the JSON number 1 (not the string \"1\"); nodes, groups, templates and context are JSON objects (not JSON-encoded strings); returns, limits, context and templates are siblings of nodes, not entries inside it; every node has type \"bash\" or \"jev\"; a reference is an object whose only key is $ref, such as {\"$ref\": \"/nodes/ID/output/stdout\"}.";
export const MINIMAL_GRAPH_EXAMPLE: Graph = { version: 1, label: "List files", nodes: { list: { type: "bash", script: "ls -la" } }, returns: ["list"] };

/** An interpreter reading its program from a heredoc on stdin, which displaces the node's stdin payload. */
const HEREDOC_PROGRAM = /\b(?:python3?|node|ruby|perl|php)\s+-\s*<<-?\s*['"]?\w+/;

function isExpression(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return keys.length === 1 && ((keys[0] === "$ref" && typeof value.$ref === "string") || keys[0] === "$literal");
}

/** Reject objects in reference positions that are neither {$ref} nor {$literal}; a missing $ref key would otherwise become a literal dict at runtime. */
function expectExpression(value: unknown, path: string, literal: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value) || isExpression(value as Record<string, unknown>)) return;
  throw new Error(`${GRAPH_VALIDATION_PREFIX}${path} must be ${literal} or a reference {"$ref": "/nodes/ID/output/..."} (received ${describeValue(value)}); the reference key is exactly $ref`);
}

/** Every object that carries a $ref anywhere in program text must be a well-formed reference. */
function checkReferences(value: unknown, path: string): void {
  if (Array.isArray(value)) return value.forEach((entry, index) => checkReferences(entry, `${path}/${index}`));
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (Object.hasOwn(record, "$literal")) return;
  if (Object.hasOwn(record, "$ref") && !isExpression(record)) throw new Error(`${GRAPH_VALIDATION_PREFIX}${path} is not a valid reference: $ref must be the only key and hold a JSON pointer string (received ${describeValue(value)})`);
  for (const [key, child] of Object.entries(record)) checkReferences(child, `${path}/${key}`);
}

function checkExpressions(body: GraphBody, base: string): void {
  for (const [id, def] of Object.entries(body.nodes)) {
    const path = `${base}/nodes/${id}`;
    if (def.type === "bash") {
      for (const [name, entry] of Object.entries(def.env ?? {})) expectExpression(entry, `${path}/env/${name}`, "a string, number or boolean");
      if (def.stdin !== undefined && HEREDOC_PROGRAM.test(def.script) && !def.script.includes("JIVE_STDIN")) {
        throw new Error(`${GRAPH_VALIDATION_PREFIX}${path}/script feeds its program to the interpreter through a heredoc on stdin, which discards this node's stdin payload; use python3 -c, write the program to a file first, or read the payload from the file named by $JIVE_STDIN`);
      }
    } else {
      (def.prepare ?? []).forEach((step, index) => expectExpression(step.input, `${path}/prepare/${index}/input`, "a string"));
      for (const [name, selection] of Object.entries(def.select ?? {})) {
        expectExpression(selection.from, `${path}/select/${name}/from`, "a collection");
        expectExpression(selection.key, `${path}/select/${name}/key`, "a string");
      }
    }
  }
  for (const [id, def] of Object.entries(body.groups ?? {})) {
    if (def.kind === "foreach") expectExpression(def.items, `${base}/groups/${id}/items`, "an array");
  }
  checkReferences(body.nodes, `${base}/nodes`);
  checkReferences(body.groups, `${base}/groups`);
}

export function validateGraph(value: unknown): asserts value is Graph {
  if (!validate(value)) throw new Error(`${GRAPH_VALIDATION_PREFIX}${formatValidationErrors(value, validate.errors ?? [])}`);
  const graph = value as Graph;
  checkExpressions(graph, "");
  for (const [name, body] of Object.entries(graph.templates ?? {})) checkExpressions(body, `/templates/${name}`);
  function checkBody(body: GraphBody, label: string) {
    const entries = { ...body.nodes, ...body.groups };
    for (const id of Object.keys(body.groups ?? {})) if (Object.hasOwn(body.nodes, id)) throw new Error(`Duplicate node/group ID ${label}/${id}`);
    for (const [id, def] of Object.entries(entries)) {
      for (const dep of dependencies(def)) if (!Object.hasOwn(entries, dep)) throw new Error(`Unknown dependency ${dep} in ${label}/${id}`);
      if ("kind" in def && (!graph.templates || !Object.hasOwn(graph.templates, def.template))) throw new Error(`Unknown template ${def.template}`);
    }
    const visiting = new Set<string>(), visited = new Set<string>();
    function visit(id: string) {
      if (visiting.has(id)) throw new Error(`Dependency cycle at ${label}/${id}; use bounded repeat`);
      if (visited.has(id)) return;
      visiting.add(id); dependencies(entries[id]!).forEach(visit); visiting.delete(id); visited.add(id);
    }
    Object.keys(entries).forEach(visit);
  }
  checkBody(graph, "root");
  for (const [name, body] of Object.entries(graph.templates ?? {})) checkBody(body, name);
  const stack = new Set<string>(), seen = new Set<string>();
  function templates(body: GraphBody) {
    for (const group of Object.values(body.groups ?? {})) {
      if (stack.has(group.template)) throw new Error(`Recursive template ${group.template} is not allowed`);
      if (seen.has(group.template)) continue;
      stack.add(group.template); templates(graph.templates![group.template]!); stack.delete(group.template); seen.add(group.template);
    }
  }
  templates(graph);
  for (const name of graph.returns ?? []) if (!Object.hasOwn(graph.nodes, name) && !Object.hasOwn(graph.groups ?? {}, name)) throw new Error(`Unknown requested result ${name}`);
}
