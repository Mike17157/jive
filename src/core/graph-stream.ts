import { repairGraph, validateGraph } from "./schema";
import type { Graph } from "./types";

export interface GraphStreamUpdate {
  kind: "preview" | "commit";
  graph: Graph;
}

type Path = Array<string | number>;
type ObjectState = "firstKeyOrEnd" | "key" | "colon" | "value" | "valueInProgress" | "commaOrEnd";
type ArrayState = "firstValueOrEnd" | "value" | "valueInProgress" | "commaOrEnd";

interface ObjectFrame {
  kind: "object";
  path: Path;
  start: number;
  state: ObjectState;
  keys: Set<string>;
  key?: string;
}

interface ArrayFrame {
  kind: "array";
  path: Path;
  start: number;
  state: ArrayState;
  index: number;
}

type Frame = ObjectFrame | ArrayFrame;
type TokenMode = "none" | "string" | "number" | "literal";
type NumberState = "start" | "sign" | "zero" | "integer" | "dot" | "fraction" | "exponent" | "exponentSign" | "exponentDigits";

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_DEPTH = 256;
const EAGER_HEADERS = ["version", "label", "context", "templates", "limits", "returns"] as const;
const ROOT_HEADERS = new Set(["eager", ...EAGER_HEADERS, "output"]);

function isWhitespace(character: string): boolean {
  return character === " " || character === "\n" || character === "\r" || character === "\t";
}

function isDelimiter(character: string): boolean {
  return isWhitespace(character) || character === "," || character === "]" || character === "}";
}

function pathLabel(path: Path): string {
  return path.length ? `/${path.map(String).join("/")}` : "/";
}

/**
 * Incremental, strict JSON scanner specialized for streamed graph arguments.
 * It parses each completed graph entry once and never repairs unfinished JSON.
 */
export class GraphStreamParser {
  #buffer = "";
  #cursor = 0;
  #bytes = 0;
  #frames: Frame[] = [];
  #rootState: "value" | "valueInProgress" | "done" = "value";
  #mode: TokenMode = "none";
  #tokenStart = 0;
  #literal = "";
  #literalOffset = 0;
  #numberState: NumberState = "start";
  #escaped = false;
  #unicodeRemaining = 0;
  #updates: GraphStreamUpdate[] = [];
  #error?: Error;
  #finished?: Graph;
  #repairs = new Set<string>();

  #rootValues = new Map<string, unknown>();
  #completedHeaders = new Set<string>();
  #nodes = new Map<string, unknown>();
  #groups = new Map<string, unknown>();
  #workMaps = new Set<"nodes" | "groups">();
  #workStarted = false;
  #headerLocked = false;
  #headerValidated = false;
  #eager = false;

  push(delta: string): GraphStreamUpdate[] {
    this.#assertUsable();
    if (!delta) return [];
    this.#bytes += new TextEncoder().encode(delta).byteLength;
    if (this.#bytes > MAX_BYTES) return this.#fail(`Graph arguments exceed ${MAX_BYTES} bytes.`);
    this.#buffer += delta;
    this.#updates = [];
    try {
      this.#scan();
      return this.#updates;
    } catch (error) {
      return this.#fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  finish(): Graph {
    if (this.#error) throw this.#error;
    if (this.#finished) return structuredClone(this.#finished);
    try {
      if (this.#mode === "number") this.#finishNumber();
      if (this.#mode !== "none" || this.#frames.length || this.#rootState !== "done") {
        throw new Error("Graph arguments ended with truncated JSON.");
      }
      let value: unknown;
      try {
        value = JSON.parse(this.#buffer);
      } catch (error) {
        throw new Error(`Invalid final graph JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
      value = this.#repair(value);
      validateGraph(value);
      this.#finished = structuredClone(value as Graph);
      return structuredClone(this.#finished);
    } catch (error) {
      return this.#fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #scan(): void {
    while (this.#cursor < this.#buffer.length) {
      if (this.#mode === "string") {
        this.#scanString();
        continue;
      }
      if (this.#mode === "number") {
        this.#scanNumber();
        continue;
      }
      if (this.#mode === "literal") {
        this.#scanLiteral();
        continue;
      }

      const character = this.#buffer[this.#cursor]!;
      if (isWhitespace(character)) {
        this.#cursor += 1;
        continue;
      }
      if (character === '"') {
        this.#mode = "string";
        this.#tokenStart = this.#cursor;
        this.#escaped = false;
        this.#unicodeRemaining = 0;
        this.#cursor += 1;
        continue;
      }
      if (character === "{" || character === "[") {
        const start = this.#cursor;
        const path = this.#beginValue(start, character === "{" ? "object" : "array");
        this.#frames.push(character === "{"
          ? { kind: "object", path, start, state: "firstKeyOrEnd", keys: new Set() }
          : { kind: "array", path, start, state: "firstValueOrEnd", index: 0 });
        if (this.#frames.length > MAX_DEPTH) throw new Error(`Graph JSON nesting exceeds ${MAX_DEPTH}.`);
        this.#cursor += 1;
        continue;
      }
      if (character === "}" || character === "]" || character === ":" || character === ",") {
        this.#consumePunctuation(character);
        this.#cursor += 1;
        continue;
      }
      if (character === "-" || (character >= "0" && character <= "9")) {
        this.#mode = "number";
        this.#tokenStart = this.#cursor;
        this.#numberState = "start";
        continue;
      }
      if (character === "t" || character === "f" || character === "n") {
        this.#mode = "literal";
        this.#tokenStart = this.#cursor;
        this.#literal = character === "t" ? "true" : character === "f" ? "false" : "null";
        this.#literalOffset = 0;
        continue;
      }
      throw new Error(`Unexpected ${JSON.stringify(character)} at character ${this.#cursor}.`);
    }
  }

  #scanString(): void {
    while (this.#cursor < this.#buffer.length) {
      const character = this.#buffer[this.#cursor]!;
      if (this.#unicodeRemaining) {
        if (!/[0-9a-fA-F]/.test(character)) {
          throw new Error(`Invalid Unicode escape at character ${this.#cursor}.`);
        }
        this.#unicodeRemaining -= 1;
        this.#cursor += 1;
        if (this.#unicodeRemaining === 0) this.#escaped = false;
        continue;
      }
      if (this.#escaped) {
        if (!'"\\/bfnrtu'.includes(character)) {
          throw new Error(`Invalid string escape at character ${this.#cursor}.`);
        }
        this.#cursor += 1;
        if (character === "u") this.#unicodeRemaining = 4;
        else this.#escaped = false;
        continue;
      }
      if (character === "\\") {
        this.#escaped = true;
        this.#cursor += 1;
        continue;
      }
      if (character === '"') {
        this.#cursor += 1;
        const start = this.#tokenStart;
        const raw = this.#buffer.slice(start, this.#cursor);
        this.#mode = "none";
        const value = JSON.parse(raw) as string;
        this.#consumeString(value, start, this.#cursor);
        return;
      }
      if (character.charCodeAt(0) <= 0x1f) {
        throw new Error(`Unescaped control character in string at ${this.#cursor}.`);
      }
      this.#cursor += 1;
    }
  }

  #scanNumber(): void {
    while (this.#cursor < this.#buffer.length) {
      const character = this.#buffer[this.#cursor]!;
      if (isDelimiter(character)) {
        this.#finishNumber();
        return;
      }
      const digit = character >= "0" && character <= "9";
      const nonzero = character >= "1" && character <= "9";
      let next: NumberState | undefined;
      switch (this.#numberState) {
        case "start": next = character === "-" ? "sign" : character === "0" ? "zero" : nonzero ? "integer" : undefined; break;
        case "sign": next = character === "0" ? "zero" : nonzero ? "integer" : undefined; break;
        case "zero": next = character === "." ? "dot" : character === "e" || character === "E" ? "exponent" : undefined; break;
        case "integer": next = digit ? "integer" : character === "." ? "dot" : character === "e" || character === "E" ? "exponent" : undefined; break;
        case "dot": next = digit ? "fraction" : undefined; break;
        case "fraction": next = digit ? "fraction" : character === "e" || character === "E" ? "exponent" : undefined; break;
        case "exponent": next = character === "+" || character === "-" ? "exponentSign" : digit ? "exponentDigits" : undefined; break;
        case "exponentSign": next = digit ? "exponentDigits" : undefined; break;
        case "exponentDigits": next = digit ? "exponentDigits" : undefined; break;
      }
      if (next) {
        this.#numberState = next;
        this.#cursor += 1;
        continue;
      }
      throw new Error(`Invalid number character ${JSON.stringify(character)} at ${this.#cursor}.`);
    }
  }

  #finishNumber(): void {
    const start = this.#tokenStart;
    const raw = this.#buffer.slice(start, this.#cursor);
    const complete = this.#numberState === "zero" || this.#numberState === "integer" ||
      this.#numberState === "fraction" || this.#numberState === "exponentDigits";
    if (!complete) throw new Error(`Invalid JSON number ${JSON.stringify(raw)} at character ${start}.`);
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error(`Invalid JSON number ${JSON.stringify(raw)} at character ${start}.`);
    }
    if (typeof value !== "number") throw new Error(`Invalid JSON number at character ${start}.`);
    this.#mode = "none";
    const path = this.#beginValue(start, "primitive");
    this.#completeValue(path, start, this.#cursor);
  }

  #scanLiteral(): void {
    while (this.#cursor < this.#buffer.length && this.#literalOffset < this.#literal.length) {
      if (this.#buffer[this.#cursor] !== this.#literal[this.#literalOffset]) {
        throw new Error(`Invalid JSON literal at character ${this.#tokenStart}.`);
      }
      this.#cursor += 1;
      this.#literalOffset += 1;
    }
    if (this.#literalOffset !== this.#literal.length) return;
    const start = this.#tokenStart;
    this.#mode = "none";
    const path = this.#beginValue(start, "primitive");
    this.#completeValue(path, start, this.#cursor);
  }

  #consumeString(value: string, start: number, end: number): void {
    const frame = this.#frames.at(-1);
    if (
      frame?.kind === "object" &&
      (frame.state === "firstKeyOrEnd" || frame.state === "key")
    ) {
      if (frame.keys.has(value)) {
        throw new Error(`Duplicate key ${JSON.stringify(value)} in ${pathLabel(frame.path)}.`);
      }
      frame.keys.add(value);
      frame.key = value;
      frame.state = "colon";
      if (frame.path.length === 0) this.#rootKey(value);
      return;
    }
    const path = this.#beginValue(start, "primitive");
    this.#completeValue(path, start, end);
  }

  #consumePunctuation(character: string): void {
    const frame = this.#frames.at(-1);
    if (!frame) throw new Error(`Unexpected ${character} at character ${this.#cursor}.`);
    if (character === ":") {
      if (frame.kind !== "object" || frame.state !== "colon") {
        throw new Error(`Unexpected colon at character ${this.#cursor}.`);
      }
      frame.state = "value";
      return;
    }
    if (character === ",") {
      if (frame.state !== "commaOrEnd") {
        throw new Error(`Unexpected comma at character ${this.#cursor}.`);
      }
      if (frame.kind === "object") frame.state = "key";
      else frame.state = "value";
      return;
    }
    if (character === "}") {
      if (
        frame.kind !== "object" ||
        (frame.state !== "firstKeyOrEnd" && frame.state !== "commaOrEnd")
      ) throw new Error(`Unexpected object close at character ${this.#cursor}.`);
    } else if (
      frame.kind !== "array" ||
      (frame.state !== "firstValueOrEnd" && frame.state !== "commaOrEnd")
    ) throw new Error(`Unexpected array close at character ${this.#cursor}.`);

    this.#frames.pop();
    this.#completeValue(frame.path, frame.start, this.#cursor + 1);
  }

  #beginValue(start: number, valueKind: "object" | "array" | "primitive"): Path {
    const parent = this.#frames.at(-1);
    let path: Path;
    if (!parent) {
      if (this.#rootState !== "value") throw new Error(`Unexpected value at character ${start}.`);
      if (valueKind !== "object") throw new Error("Graph JSON root must be an object.");
      this.#rootState = "valueInProgress";
      path = [];
    } else if (parent.kind === "object") {
      if (parent.state !== "value" || parent.key === undefined) {
        throw new Error(`Unexpected value at character ${start}.`);
      }
      path = [...parent.path, parent.key];
      parent.state = "valueInProgress";
    } else {
      if (parent.state !== "firstValueOrEnd" && parent.state !== "value") {
        throw new Error(`Unexpected value at character ${start}.`);
      }
      path = [...parent.path, parent.index];
      parent.state = "valueInProgress";
    }
    if (
      path.length === 1 &&
      (path[0] === "nodes" || path[0] === "groups")
    ) this.#beginWorkMap(path[0], valueKind);
    return path;
  }

  #completeValue(path: Path, start: number, end: number): void {
    const parent = this.#frames.at(-1);
    if (!parent) {
      if (path.length !== 0 || this.#rootState !== "valueInProgress") {
        throw new Error(`Invalid completed root value at character ${end}.`);
      }
      this.#rootState = "done";
    } else {
      if (parent.state !== "valueInProgress") {
        throw new Error(`Unexpected completed value at character ${end}.`);
      }
      parent.state = "commaOrEnd";
      if (parent.kind === "array") parent.index += 1;
    }
    this.#completed(path, start, end);
  }

  #rootKey(key: string): void {
    if (this.#headerLocked && key !== "nodes" && key !== "groups") {
      throw new Error(`Eager graph header is frozen; late root field ${JSON.stringify(key)} is not allowed.`);
    }
  }

  #beginWorkMap(key: "nodes" | "groups", valueKind: "object" | "array" | "primitive"): void {
    this.#workStarted = true;
    this.#workMaps.add(key);
    if (!this.#eager) return;
    this.#headerLocked = true;
    const missing = EAGER_HEADERS.filter((header) => !this.#completedHeaders.has(header));
    if (missing.length) {
      throw new Error(`Eager graph is missing completed header fields before ${key}: ${missing.join(", ")}.`);
    }
    if (valueKind !== "object") throw new Error(`Eager graph ${key} must be an object.`);
    this.#validateHeader();
  }

  #completed(path: Path, start: number, end: number): void {
    if (path.length === 1 && typeof path[0] === "string") {
      const key = path[0];
      if (key !== "nodes" && key !== "groups") {
        const value = this.#parseSlice(start, end, path);
        this.#rootValues.set(key, value);
        if (ROOT_HEADERS.has(key)) this.#completedHeaders.add(key);
        if (key === "eager") {
          if (value === true && this.#workStarted) {
            throw new Error("eager:true must be fully declared before nodes or groups begins.");
          }
          this.#eager = value === true;
        }
      }
      return;
    }
    if (
      path.length === 2 &&
      (path[0] === "nodes" || path[0] === "groups") &&
      typeof path[1] === "string"
    ) {
      const value = this.#parseSlice(start, end, path);
      const entries = path[0] === "nodes" ? this.#nodes : this.#groups;
      entries.set(path[1], value);
      const graph = this.#eager ? this.#commitGraph() : this.#previewGraph();
      this.#updates.push({
        kind: this.#eager ? "commit" : "preview",
        graph: structuredClone(graph),
      });
    }
  }

  #parseSlice(start: number, end: number, path: Path): unknown {
    try {
      return JSON.parse(this.#buffer.slice(start, end));
    } catch (error) {
      throw new Error(`Invalid completed JSON value at ${pathLabel(path)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  #validateHeader(): void {
    if (this.#headerValidated) return;
    this.#commitGraph();
    this.#headerValidated = true;
  }

  #previewGraph(): Graph {
    return this.#buildGraph(false);
  }

  #commitGraph(): Graph {
    const graph = this.#repair(this.#buildGraph(true)) as Graph;
    validateGraph(graph);
    return graph;
  }

  /** Normalizations applied to what the model sent, in the order they were first seen. */
  get repairs(): string[] {
    return [...this.#repairs];
  }

  #repair(value: unknown): unknown {
    const repaired = repairGraph(value);
    for (const repair of repaired.repairs) this.#repairs.add(repair);
    return repaired.value;
  }

  #buildGraph(commit: boolean): Graph {
    const value: Record<string, unknown> = {
      version: this.#rootValues.has("version") ? this.#rootValues.get("version") : 1,
      label: this.#rootValues.has("label") ? this.#rootValues.get("label") : "Building graph",
      nodes: Object.fromEntries(this.#nodes),
    };
    for (const [key, entry] of this.#rootValues) {
      if (key !== "version" && key !== "label" && key !== "returns") value[key] = entry;
    }
    if (this.#workMaps.has("groups") || this.#groups.size) {
      value.groups = Object.fromEntries(this.#groups);
    }
    if (this.#rootValues.has("returns")) {
      const returns = this.#rootValues.get("returns");
      if (
        commit &&
        Array.isArray(returns) &&
        returns.every((id): id is string => typeof id === "string") &&
        new Set(returns).size === returns.length
      ) {
        const known = new Set([...this.#nodes.keys(), ...this.#groups.keys()]);
        value.returns = returns.filter((id) => known.has(id));
      } else value.returns = returns;
    }
    return value as unknown as Graph;
  }

  #assertUsable(): void {
    if (this.#error) throw this.#error;
    if (this.#finished) throw new Error("Graph stream is already finished.");
  }

  #fail(message: string | Error): never {
    this.#error = typeof message === "string" ? new Error(message) : message;
    throw this.#error;
  }
}
