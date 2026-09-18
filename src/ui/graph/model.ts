/**
 * Pure reducer: ExecutionEvent[] → GraphModel[].
 *
 * The event payload contract (from the parent controller) is:
 *   graph.started   data: { label?, nodes?: Record<string, {label?, type, needs?}> }
 *   node.created    nodeId, data: { id?, label?, type, needs?: string[], parent?: string, scope?: string }
 *   node.started    nodeId, data: { label?, type? }
 *   node.output     nodeId, data: { chunk?|text?|data?, stream? }
 *   node.finished   nodeId, data: { result: NodeResult }
 *   edge.ready      data: { from, to }
 *   jev.request     nodeId, data: { state, questions, model? }
 *   jev.response    nodeId, data: { answers, model?, usage? }
 *   plugin.activity nodeId, data: { message?|activity?|name?, ... }
 *   graph.finished  data: { status?, reason?, report? }
 *
 * Streaming construction previews (UI-only extension of the core union, same
 * graphId as the later graph.started):
 *   graph.building           data: { label? }
 *   graph.preview            data: { graph: partial Graph (nodes/groups so far) }
 *   graph.building.finished  data: { status: "ready" | "interrupted" | "failed", error? }
 * Preview nodes get the UI-only status "building"; real node.created/started
 * events overwrite it, so the same node never appears twice.
 *
 * The reducer is defensive: unknown shapes are kept verbatim so the inspector
 * can still show exactly what the runtime emitted.
 */
import type { ExecutionEvent, NodeResult, NodeStatus } from "../../core/types.ts";
import { references } from "../../core/expressions.ts";

export type PreviewEventType = "graph.building" | "graph.preview" | "graph.building.finished";
export type UIExecutionEventType = ExecutionEvent["type"] | PreviewEventType;
/** An execution event whose type may be one of the UI-only preview events. */
export type UIExecutionEvent = Omit<ExecutionEvent, "type"> & { type: UIExecutionEventType };
/** Core statuses plus the UI-only "building" state for previewed-but-not-created nodes. */
export type UINodeStatus = NodeStatus | "building";
export type GraphPhase = "building" | "ready" | "running" | "finished" | "interrupted" | "failed";

export type GraphNodeType = NodeResult["type"] | "unknown";

export interface GraphNode {
  id: string;
  label: string;
  type: GraphNodeType;
  needs: string[];
  /** Enclosing group id (foreach/repeat instance) or undefined for top-level nodes. */
  parent?: string;
  status: UINodeStatus;
  createdSeq: number;
  /** Time the node definition first appeared in a construction preview. */
  revealedAt?: number;
  startedAt?: number;
  finishedAt?: number;
  result?: NodeResult;
  error?: string;
  artifact?: string;
  output: string;
  jevRequests: Array<{ time: number; data: Record<string, unknown> }>;
  jevResponses: Array<{ time: number; data: Record<string, unknown> }>;
  activity: Array<{ time: number; data: Record<string, unknown> }>;
}

export interface GraphEdge {
  from: string;
  to: string;
  /** Time the dependency became available (edge.ready) or undefined. */
  readyAt?: number;
}

export interface GraphModel {
  id: string;
  label: string;
  startedAt?: number;
  finishedAt?: number;
  status?: string;
  reason?: string;
  phase: GraphPhase;
  /** Generation and execution can overlap in eager mode. */
  building?: boolean;
  /** Error reported by graph.building.finished when construction failed. */
  buildError?: string;
  /** Node ids in creation order (stable). */
  order: string[];
  nodes: Record<string, GraphNode>;
  edges: GraphEdge[];
  lastSequence: number;
}

const GROUP_TYPES = new Set(["foreach", "repeat"]);

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
function nodeType(v: unknown): GraphNodeType {
  return v === "bash" || v === "jev" || v === "foreach" || v === "repeat" ? v : "unknown";
}

export function isGroupType(t: GraphNodeType): boolean {
  return GROUP_TYPES.has(t);
}

function ensureGraph(map: Map<string, GraphModel>, ev: UIExecutionEvent): GraphModel {
  let g = map.get(ev.graphId);
  if (!g) {
    g = { id: ev.graphId, label: ev.graphId, phase: "running", order: [], nodes: Object.create(null), edges: [], lastSequence: ev.sequence };
    map.set(ev.graphId, g);
  }
  g.lastSequence = Math.max(g.lastSequence, ev.sequence);
  return g;
}

function ensureNode(g: GraphModel, id: string, ev: UIExecutionEvent, data: Record<string, unknown>): GraphNode {
  let n = g.nodes[id];
  if (!n) {
    n = {
      id,
      label: str(data.label) ?? id,
      type: nodeType(data.type),
      needs: [],
      parent: str(data.parent) ?? str(data.scope),
      status: "pending",
      createdSeq: ev.sequence,
      output: "",
      jevRequests: [],
      jevResponses: [],
      activity: [],
    };
    g.nodes[id] = n;
    g.order.push(id);
  }
  return n;
}

function addNeeds(g: GraphModel, n: GraphNode, needs: string[]): void {
  for (const dep of needs) {
    if (dep === n.id || n.needs.includes(dep)) continue;
    n.needs.push(dep);
    if (!g.edges.some((e) => e.from === dep && e.to === n.id)) g.edges.push({ from: dep, to: n.id });
  }
}

function outputChunk(data: Record<string, unknown>): string {
  const c = data.chunk ?? data.text ?? data.data ?? data.output;
  if (typeof c === "string") return c;
  if (c === undefined || c === null) return "";
  try {
    return JSON.stringify(c);
  } catch {
    return String(c);
  }
}

/** Apply a preview's node/group definitions as "building" rows without disturbing real ones. */
function previewNeeds(spec: Record<string, unknown>): string[] {
  const inputs = spec.kind === "foreach" ? {items:spec.items,input:spec.input,when:spec.when}
    : spec.kind === "repeat" ? {initial:spec.initial,when:spec.when} : spec;
  return [...new Set([...strArray(spec.needs), ...references(inputs).flatMap(ref => {
    const match = /^\/(?:nodes|groups)\/([^/]+)/.exec(ref);
    return match ? [match[1]!] : [];
  })])];
}

function applyPreview(g: GraphModel, ev: UIExecutionEvent, graph: Record<string, unknown>): void {
  const nodes = graph.nodes;
  if (nodes && typeof nodes === "object" && !Array.isArray(nodes)) {
    for (const [id, spec] of Object.entries(nodes as Record<string, unknown>)) {
      const s = (spec ?? {}) as Record<string, unknown>;
      const existed = g.nodes[id] !== undefined;
      const n = ensureNode(g, id, ev, s);
      if (!existed) {
        n.status = "building";
        n.revealedAt = ev.time;
      }
      if (str(s.label)) n.label = str(s.label)!;
      if (n.type === "unknown") n.type = nodeType(s.type);
      addNeeds(g, n, previewNeeds(s));
    }
  }
  const groups = graph.groups;
  if (groups && typeof groups === "object" && !Array.isArray(groups)) {
    for (const [id, spec] of Object.entries(groups as Record<string, unknown>)) {
      const s = (spec ?? {}) as Record<string, unknown>;
      const existed = g.nodes[id] !== undefined;
      const n = ensureNode(g, id, ev, { ...s, type: s.kind });
      if (!existed) {
        n.status = "building";
        n.revealedAt = ev.time;
      }
      if (str(s.label)) n.label = str(s.label)!;
      if (n.type === "unknown") n.type = nodeType(s.kind);
      addNeeds(g, n, previewNeeds(s));
    }
  }
}

/** Reduce the full event log into per-graph models, in order of first appearance. */
export function reduceGraphs(events: readonly (ExecutionEvent | UIExecutionEvent)[]): GraphModel[] {
  const map = new Map<string, GraphModel>();
  const sorted = [...events].sort((a, b) => a.sequence - b.sequence);
  for (const ev of sorted) {
    const g = ensureGraph(map, ev);
    const data = (ev.data ?? {}) as Record<string, unknown>;
    switch (ev.type) {
      case "graph.building": {
        g.building = true;
        g.phase = "building";
        g.label = str(data.label) ?? g.label;
        break;
      }
      case "graph.preview": {
        g.building = true;
        if (g.phase !== "running" && g.phase !== "finished") g.phase = "building";
        const graph = data.graph;
        if (graph && typeof graph === "object" && !Array.isArray(graph)) {
          const gr = graph as Record<string, unknown>;
          if (str(gr.label)) g.label = str(gr.label)!;
          applyPreview(g, ev, gr);
        }
        break;
      }
      case "graph.building.finished": {
        g.building = false;
        const status = str(data.status);
        if (g.startedAt === undefined) {
          g.phase = status === "interrupted" ? "interrupted" : status === "failed" ? "failed" : "ready";
        }
        if (typeof data.error === "string") g.buildError = data.error;
        if (status === "interrupted" || status === "failed") {
          for (const node of Object.values(g.nodes)) if (node.status === "building") node.status = "cancelled";
        }
        break;
      }
      case "graph.started": {
        g.startedAt = ev.time;
        g.phase = "running";
        g.label = str(data.label) ?? g.label;
        const nodes = data.nodes;
        if (nodes && typeof nodes === "object" && !Array.isArray(nodes)) {
          for (const [id, spec] of Object.entries(nodes as Record<string, unknown>)) {
            const s = (spec ?? {}) as Record<string, unknown>;
            const n = ensureNode(g, id, ev, s);
            if (n.status === "building") n.status = "pending";
            addNeeds(g, n, strArray(s.needs));
          }
        }
        break;
      }
      case "node.created": {
        const id = ev.nodeId ?? str(data.id);
        if (!id) break;
        const n = ensureNode(g, id, ev, data);
        if (n.status === "building") n.status = "pending";
        if (str(data.label)) n.label = str(data.label)!;
        if (data.type !== undefined) n.type = nodeType(data.type);
        if (!n.parent) n.parent = str(data.parent) ?? str(data.scope);
        addNeeds(g, n, strArray(data.needs));
        break;
      }
      case "node.started": {
        if (!ev.nodeId) break;
        const n = ensureNode(g, ev.nodeId, ev, data);
        if (str(data.label)) n.label = str(data.label)!;
        if (data.type !== undefined && n.type === "unknown") n.type = nodeType(data.type);
        n.status = "running";
        n.startedAt = ev.time;
        break;
      }
      case "node.output": {
        if (!ev.nodeId) break;
        const n = ensureNode(g, ev.nodeId, ev, data);
        n.output += outputChunk(data);
        break;
      }
      case "node.finished": {
        if (!ev.nodeId) break;
        const n = ensureNode(g, ev.nodeId, ev, data);
        const result = (data.result ?? data) as Partial<NodeResult>;
        const status = result.status ?? str(data.status);
        n.status = (status as NodeStatus) ?? "done";
        n.finishedAt = ev.time;
        n.result = { id: n.id, label: n.label, type: n.type === "unknown" ? "bash" : n.type, status: n.status, ...result } as NodeResult;
        if (typeof result.label === "string") n.label = result.label;
        if (result.type) n.type = nodeType(result.type);
        if (typeof result.error === "string") n.error = result.error;
        if (typeof result.artifact === "string") n.artifact = result.artifact;
        if (typeof result.startedAt === "number") n.startedAt = result.startedAt;
        break;
      }
      case "edge.ready": {
        const from = str(data.from);
        const to = str(data.to);
        if (!from || !to) break;
        let e = g.edges.find((x) => x.from === from && x.to === to);
        if (!e) {
          e = { from, to };
          g.edges.push(e);
          const target = g.nodes[to];
          if (target && !target.needs.includes(from)) target.needs.push(from);
        }
        if (e.readyAt === undefined) e.readyAt = ev.time;
        break;
      }
      case "jev.request": {
        if (!ev.nodeId) break;
        ensureNode(g, ev.nodeId, ev, data).jevRequests.push({ time: ev.time, data });
        break;
      }
      case "jev.response": {
        if (!ev.nodeId) break;
        ensureNode(g, ev.nodeId, ev, data).jevResponses.push({ time: ev.time, data });
        break;
      }
      case "plugin.activity": {
        if (!ev.nodeId) break;
        ensureNode(g, ev.nodeId, ev, data).activity.push({ time: ev.time, data });
        break;
      }
      case "graph.finished": {
        g.finishedAt = ev.time;
        g.phase = "finished";
        g.status = str(data.status) ?? "done";
        g.reason = str(data.reason);
        break;
      }
    }
  }
  return [...map.values()];
}

/** Terminal states in the executor's vocabulary. */
export function isTerminalStatus(s: UINodeStatus): boolean {
  return s !== "pending" && s !== "running" && s !== "building";
}

export type StatusTone = "done" | "warn" | "blocked" | "running" | "pending" | "building";

/** Colour tone for a node status: green done, yellow failed/yielded/exhausted, grey blocked/skipped/cancelled. */
export function statusTone(s: UINodeStatus): StatusTone {
  switch (s) {
    case "building":
      return "building";
    case "done":
      return "done";
    case "failed":
    case "yielded":
    case "exhausted":
      return "warn";
    case "blocked":
    case "skipped":
    case "cancelled":
      return "blocked";
    case "running":
      return "running";
    default:
      return "pending";
  }
}

export interface GraphCounts {
  total: number;
  done: number;
  running: number;
  warn: number;
  blocked: number;
  pending: number;
  building: number;
}

export function countStatuses(g: GraphModel): GraphCounts {
  const c: GraphCounts = { total: 0, done: 0, running: 0, warn: 0, blocked: 0, pending: 0, building: 0 };
  for (const id of g.order) {
    const n = g.nodes[id]!;
    c.total++;
    const tone = statusTone(n.status);
    if (tone === "done") c.done++;
    else if (tone === "running") c.running++;
    else if (tone === "warn") c.warn++;
    else if (tone === "blocked") c.blocked++;
    else if (tone === "building") c.building++;
    else c.pending++;
  }
  return c;
}

/** Whether a node's incoming edge from `from` has been marked ready. */
export function edgeReady(g: GraphModel, from: string, to: string): boolean {
  return g.edges.some((e) => e.from === from && e.to === to && e.readyAt !== undefined);
}
