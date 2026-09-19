/**
 * execute_graph_mod: run a saved graph by ID or file, with optional edits.
 *
 * Every executed (or schema-rejected) graph is written to .jev/runs/<graphId>/graph.json. The
 * planner refers back to it by ID and sends edits that apply to the DECODED graph, never to the
 * JSON text: a JSON pointer scopes each edit to one field, so an old/new replacement inside a
 * long script cannot collide with the same text in another node and needs no JSON escaping.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export const GRAPH_TOOL_NAME = "execute_graph";
export const GRAPH_MOD_TOOL_NAME = "execute_graph_mod";
export const GRAPH_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

export interface GraphEdit {
  path: string;
  old?: string;
  new?: unknown;
}

export interface GraphModCall {
  base?: string;
  file?: string;
  label?: string;
  edits: GraphEdit[];
}

export const graphModToolParameters: Record<string, unknown> = {
  type: "object",
  description: "Execute a saved graph by base graphId or JSON file, with optional edits. Supply exactly one of base or file. Omit edits (or use []) to run unchanged. Edits apply to decoded JSON values. The graph is validated and executed in this session and saved under a new graphId; the source is unchanged. Every node runs again; this is not a resume of unfinished nodes.",
  properties: {
    base: { type: "string", description: "graphId of the saved graph to start from, copied from an earlier tool result." },
    file: { type: "string", description: "Path to a graph JSON file, absolute or relative to the session working directory. Mutually exclusive with base. Node paths still resolve from the session directory, not the graph file's directory." },
    label: { type: "string", description: "Optional new label for the rerun (1 to 200 chars). Defaults to the base graph's label." },
    edits: {
      type: "array",
      description: "Optional edits applied in order; omit or use [] to run unchanged. Each targets one location with a JSON pointer such as /nodes/build/script or /templates/expand/nodes/links/timeoutMs. With old: the target must be a string and old must occur exactly once in it; only that substring is replaced with new (a string). Without old: new replaces the whole value at path (any JSON, including a complete new node under a fresh ID), and new: null deletes the entry.",
      items: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string", description: "JSON pointer into the graph, e.g. /nodes/ID/script, /nodes/ID/env/NAME, /groups/ID/maxItems, /returns, /limits/timeoutMs. Use ~1 for a literal / and ~0 for a literal ~ inside a key." },
          old: { type: "string", description: "Substring to replace inside the string at path. Must match exactly once. Omit to replace or delete the whole value." },
          new: { description: "Replacement. With old: the replacement substring. Without old: the new value at path; null deletes." },
        },
      },
    },
  },
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function graphRunDirectory(cwd: string, graphId: string): string {
  if (!GRAPH_ID_PATTERN.test(graphId)) throw new Error(`Invalid graphId ${JSON.stringify(graphId)}.`);
  return join(cwd, ".jev", "runs", graphId);
}

/** Loads .jev/runs/<graphId>/graph.json. IDs are confined to one path segment. */
export async function loadSavedGraph(cwd: string, graphId: string): Promise<unknown> {
  const path = join(graphRunDirectory(cwd, graphId), "graph.json");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`No saved graph with graphId ${JSON.stringify(graphId)}. Use the graphId from an earlier execute_graph result; saved graphs live under .jev/runs/.`);
    }
    throw new Error(`Could not read saved graph ${graphId}: ${errorMessage(error)}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Saved graph ${graphId} is not valid JSON: ${errorMessage(error)}`);
  }
}

/** File replay uses the same executor and session cwd as inline and ID-based graphs. */
export async function loadGraphFile(cwd: string, file: string): Promise<unknown> {
  const path = resolve(cwd, file);
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error) { throw new Error(`Could not read graph file ${JSON.stringify(path)}: ${errorMessage(error)}`); }
  try { return JSON.parse(text); }
  catch (error) { throw new Error(`Graph file ${JSON.stringify(path)} is not valid JSON: ${errorMessage(error)}`); }
}

/** Writes graph.json for a graph the executor never reached (parse or schema rejection), so it can still be edited. */
export async function saveGraphForEditing(cwd: string, graphId: string, graph: unknown): Promise<string> {
  const directory = graphRunDirectory(cwd, graphId);
  await mkdir(directory, { recursive: true });
  const path = join(directory, "graph.json");
  await writeFile(path, JSON.stringify(graph, null, 2));
  return path;
}

export function parseGraphModCall(argumentsText: string): GraphModCall {
  let value: unknown;
  try {
    value = JSON.parse(argumentsText);
  } catch (error) {
    throw new Error(`${GRAPH_MOD_TOOL_NAME} arguments are not valid JSON: ${errorMessage(error)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${GRAPH_MOD_TOOL_NAME} arguments must be a JSON object with base or file and optional edits.`);
  }
  const call = value as Record<string, unknown>;
  if ((call.base !== undefined) === (call.file !== undefined)) throw new Error("Supply exactly one of base (graphId) or file (graph JSON path).");
  if (call.base !== undefined && (typeof call.base !== "string" || !GRAPH_ID_PATTERN.test(call.base))) throw new Error("base must be a valid graphId string, not a file path; use file for paths.");
  if (call.file !== undefined && (typeof call.file !== "string" || !call.file.trim() || call.file.includes("\0"))) throw new Error("file must be a non-empty graph JSON path without null bytes.");
  if (call.label !== undefined && (typeof call.label !== "string" || !call.label.trim() || call.label.length > 200)) {
    throw new Error("label must be a string of 1 to 200 characters.");
  }
  let edits = call.edits === undefined ? [] : call.edits;
  if (typeof edits === "string") {
    try { edits = JSON.parse(edits); } catch { /* reported below */ }
  }
  if (!Array.isArray(edits)) throw new Error("edits must be an array of {path, old?, new?} objects; omit it to run unchanged.");
  for (const [index, edit] of edits.entries()) {
    if (!edit || typeof edit !== "object" || Array.isArray(edit)) throw new Error(`edits[${index}] must be an object with a path.`);
    const entry = edit as Record<string, unknown>;
    if (typeof entry.path !== "string" || !entry.path.startsWith("/")) {
      throw new Error(`edits[${index}].path must be a JSON pointer starting with /, such as /nodes/ID/script.`);
    }
    if (entry.old !== undefined && typeof entry.old !== "string") throw new Error(`edits[${index}].old must be a string.`);
    if (entry.old !== undefined && typeof entry.new !== "string") {
      throw new Error(`edits[${index}].new must be the replacement string when old is given.`);
    }
    if (entry.old === undefined && !Object.hasOwn(entry, "new")) {
      throw new Error(`edits[${index}] needs new (a value to set, or null to delete) or old plus new.`);
    }
    if (entry.old === "") throw new Error(`edits[${index}].old must not be empty.`);
  }
  return {
    ...(call.base !== undefined ? { base: call.base as string } : { file: call.file as string }),
    ...(call.label !== undefined ? { label: call.label as string } : {}),
    edits: (edits as Array<Record<string, unknown>>).map((entry) => ({
      path: entry.path as string,
      ...(entry.old !== undefined ? { old: entry.old as string } : {}),
      ...(Object.hasOwn(entry, "new") ? { new: entry.new } : {}),
    })),
  };
}

function parsePointer(pointer: string): string[] {
  if (pointer === "/") return [""];
  return pointer.slice(1).split("/").map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function excerpt(value: unknown, max = 1_500): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) return "undefined";
  return text.length > max ? `${text.slice(0, max)}… (${text.length - max} more characters)` : text;
}

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return value !== null && typeof value === "object";
}

function readChild(container: Record<string, unknown> | unknown[], key: string): unknown {
  if (Array.isArray(container)) {
    const index = Number(key);
    return Number.isInteger(index) && index >= 0 && index < container.length ? container[index] : undefined;
  }
  return Object.hasOwn(container, key) ? container[key] : undefined;
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let index = haystack.indexOf(needle); index !== -1; index = haystack.indexOf(needle, index + needle.length)) count += 1;
  return count;
}

/**
 * Applies edits to a deep copy of the graph. Errors name the failing edit and show the current
 * value at its path so the next attempt can be exact.
 */
export function applyGraphEdits(graph: unknown, edits: readonly GraphEdit[]): { graph: unknown; applied: string[] } {
  const result = structuredClone(graph);
  const applied: string[] = [];
  for (const [index, edit] of edits.entries()) {
    const label = `edits[${index}] at ${edit.path}`;
    const segments = parsePointer(edit.path);
    if (segments.length === 1 && segments[0] === "") throw new Error(`${label}: the root cannot be edited; target a field such as /nodes/ID.`);
    let parent: unknown = result;
    for (const segment of segments.slice(0, -1)) {
      if (!isContainer(parent)) throw new Error(`${label}: /${segments.slice(0, segments.indexOf(segment)).join("/")} is not an object or array.`);
      const child = readChild(parent, segment);
      if (child === undefined) {
        throw new Error(`${label}: the path does not exist (missing ${JSON.stringify(segment)}). Existing keys here: ${excerpt(Array.isArray(parent) ? `array of ${parent.length}` : Object.keys(parent))}.`);
      }
      parent = child;
    }
    const key = segments.at(-1)!;
    if (!isContainer(parent)) throw new Error(`${label}: the parent of ${JSON.stringify(key)} is not an object or array.`);
    const current = readChild(parent, key);

    if (edit.old !== undefined) {
      if (typeof current !== "string") {
        throw new Error(`${label}: old/new replacement needs a string at the path, but found ${current === undefined ? "nothing" : excerpt(current)}. Omit old to set the whole value.`);
      }
      const occurrences = countOccurrences(current, edit.old);
      if (occurrences !== 1) {
        throw new Error(`${label}: old ${occurrences === 0 ? "was not found" : `occurs ${occurrences} times; include more surrounding text so it matches once`}. Current value:\n${excerpt(current)}`);
      }
      const next = current.replace(edit.old, () => edit.new as string);
      if (Array.isArray(parent)) parent[Number(key)] = next; else parent[key] = next;
      applied.push(`${edit.path}: replaced ${edit.old.length} characters`);
      continue;
    }

    if (edit.new === null) {
      if (current === undefined) throw new Error(`${label}: nothing to delete; the path does not exist.`);
      if (Array.isArray(parent)) parent.splice(Number(key), 1); else delete parent[key];
      applied.push(`${edit.path}: deleted`);
      continue;
    }

    if (Array.isArray(parent)) {
      if (key === "-") parent.push(structuredClone(edit.new));
      else {
        const position = Number(key);
        if (!Number.isInteger(position) || position < 0 || position > parent.length) {
          throw new Error(`${label}: array index ${JSON.stringify(key)} is out of range (length ${parent.length}); use - to append.`);
        }
        parent[position] = structuredClone(edit.new);
      }
    } else parent[key] = structuredClone(edit.new);
    applied.push(`${edit.path}: ${current === undefined ? "added" : "replaced"}`);
  }
  return { graph: result, applied };
}
