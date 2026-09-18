/**
 * Pure lane layout for a graph model.
 *
 * Nodes become rows in creation order (children of an expanded group follow the
 * group row). Dependencies are drawn as lanes in a left gutter, git-log style:
 * a lane starts at the source node's column and runs downward until it reaches
 * each dependent row, where it turns into that row's node glyph.
 *
 * Rows never reorder when new nodes appear, so the picture stays stable while a
 * graph expands. Lanes are allocated left-to-right and reused when freed.
 */
import type { GraphModel, GraphNode, TemplateEntry, UINodeStatus } from "./model.ts";
import { isGroupType, statusTone, type StatusTone } from "./model.ts";

export type CellKind = "empty" | "pass" | "edge" | "node" | "loop";

export interface LaneCell {
  ch: string;
  /** Whether a horizontal segment continues to the right of this lane. */
  hright: boolean;
  kind: CellKind;
  from?: string;
  to?: string;
  /** For pass-through cells: all targets still pending on this lane. */
  targets?: string[];
  /** Distance in cells from the source node, used by the green sweep animation. */
  dist: number;
}

/** "node" rows are real graph nodes; "body" rows draw one entry of a loop's template body. */
export type RowKind = "node" | "body";

export interface LayoutRow {
  id: string;
  /**
   * The node drawn on this row. For a body row it is a synthetic node whose id and needs are
   * body ids, carrying the status and timing of the latest instance, or a pending placeholder
   * when the loop has not instantiated that entry yet.
   */
  node: GraphNode;
  kind: RowKind;
  /** The real node behind this row: the node itself, or a body row's latest instance. */
  instance?: GraphNode;
  /** Nesting depth (0 = top level, 1 = inside one group, ...). */
  depth: number;
  col: number;
  cells: LaneCell[];
  /**
   * Lanes alive between the previous row and this one, for the connector line a renderer may
   * draw there. Every lane continues through it, including the ones that end on this row, so a
   * connector never breaks a line off short. All empty for the first row.
   */
  above: LaneCell[];
  /** True for foreach/repeat rows. */
  group: boolean;
  expanded: boolean;
  /** Distinct iterations (or items) instantiated so far, for group rows. */
  iterations: number;
  /** The id of the group row whose body this row belongs to. */
  parentId?: string;
}

export interface GraphLayout {
  rows: LayoutRow[];
  laneCount: number;
  /** Real nodes hidden inside folded groups. */
  hidden: number;
}

interface Lane {
  from: string;
  srcRow: number;
  pending: string[];
  /** A loop-back lane: it spans a group's body and carries no edges. */
  loop?: boolean;
}

function mergeChar(existing: string, incoming: string): string {
  if (existing === " " || existing === incoming) return incoming;
  const set = new Set([existing, incoming]);
  const has = (c: string) => set.has(c);
  if (has("─")) {
    if (has("│") || has("├") || has("┤") || has("┼")) return "┼";
    if (has("╰") || has("╯") || has("┴")) return "┴";
  }
  if (has("│")) {
    if (has("╰") || has("├")) return "├";
    if (has("╯") || has("┤")) return "┤";
    if (has("┴")) return "┼";
  }
  if (has("╰") && has("╯")) return "┴";
  if (has("├") || has("┤") || has("┼")) return "┼";
  return incoming;
}

export interface LayoutOptions {
  /** Ids of group rows opened explicitly; groups are open by default. */
  expanded: ReadonlySet<string>;
  /** Ids of group rows closed explicitly. */
  folded?: ReadonlySet<string>;
}

export interface VisibleRow {
  id: string;
  node: GraphNode;
  kind: RowKind;
  instance?: GraphNode;
  depth: number;
  expanded: boolean;
  iterations: number;
  parentId?: string;
}

const BODY_MARK = "[*]/";

/** Id of the row drawing one entry of a group's body: the same row across every iteration. */
export function bodyId(group: string, key: string): string {
  return group + BODY_MARK + key;
}

/** Whether a row id names a loop body entry rather than a single instantiated node. */
export function isBodyId(id: string): boolean {
  return id.includes(BODY_MARK);
}

/** The template-local key of an instantiated child, e.g. "fetch" for "rounds[2]/fetch". */
function localKey(id: string, parent: string): string {
  const rest = id.slice(parent.length);
  return rest.replace(/^(?:\[\d+\]\/|\/\d+\/|\/)/, "");
}

/**
 * Creation order with each node's in-scope dependencies pulled ahead of it, so lanes always run
 * downward. Stable: a node added later can only depend on earlier ones, so existing rows keep
 * their relative order when the graph grows.
 */
function orderByDependency<T extends { id: string; needs: string[] }>(nodes: T[]): T[] {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const out: T[] = [];
  const done = new Set<string>();
  const visit = (n: T) => {
    if (done.has(n.id)) return;
    done.add(n.id);
    for (const dep of n.needs) {
      const other = byId.get(dep);
      if (other) visit(other);
    }
    out.push(n);
  };
  for (const n of nodes) visit(n);
  return out;
}

/** Real nodes grouped by the id of the group instance that contains them. */
function childrenByParent(g: GraphModel): Map<string, GraphNode[]> {
  const out = new Map<string, GraphNode[]>();
  for (const id of g.order) {
    const n = g.nodes[id]!;
    if (!(n.parent && g.nodes[n.parent])) continue;
    const list = out.get(n.parent) ?? [];
    list.push(n);
    out.set(n.parent, list);
  }
  return out;
}

/** Distinct iterations a group instance has started, or its loose child count for older records. */
function iterationCount(children: GraphNode[]): number {
  const indices = new Set(children.map((n) => n.iteration).filter((i): i is number => i !== undefined));
  return indices.size || children.length;
}

/**
 * What one pass of the body looks like: the template definition when known, otherwise the
 * entries reconstructed from the instances that have run.
 */
function bodyEntries(g: GraphModel, template: string | undefined, children: GraphNode[]): TemplateEntry[] {
  if (template && g.templates[template]) return g.templates[template]!;
  const seen = new Map<string, TemplateEntry>();
  for (const child of children) {
    const key = localKey(child.id, child.parent!);
    if (seen.has(key)) continue;
    const prefix = child.id.slice(0, child.id.length - key.length);
    const needs = child.needs.filter((n) => n.startsWith(prefix)).map((n) => n.slice(prefix.length));
    seen.set(key, { key, label: child.label, type: child.type, needs, ...(child.loop ? { loop: child.loop } : {}) });
  }
  return [...seen.values()];
}

/**
 * The instance a body row shows: the latest pass for a repeat loop, and for a foreach the item
 * that is running now, else the latest one.
 */
function currentInstance(kind: GraphNode["type"], instances: GraphNode[]): GraphNode | undefined {
  const sorted = [...instances].sort((a, b) => (a.iteration ?? -1) - (b.iteration ?? -1) || a.createdSeq - b.createdSeq);
  if (kind === "foreach") {
    const running = sorted.filter((n) => n.status === "running");
    if (running.length) return running[running.length - 1];
  }
  return sorted[sorted.length - 1];
}

function placeholder(id: string, entry: TemplateEntry, needs: string[], parent: string): GraphNode {
  return { id, label: entry.label, type: entry.type, needs, parent, status: "pending", createdSeq: 0, output: "", jevRequests: [], jevResponses: [], activity: [], ...(entry.loop ? { loop: entry.loop } : {}) };
}

/** Whether a group row is open: explicit choices win, otherwise groups are open. */
function isOpen(id: string, options: LayoutOptions): boolean {
  if (options.folded?.has(id)) return false;
  return true;
}

function countDescendants(g: GraphModel, instance: GraphNode): number {
  let n = 0;
  for (const id of g.order) if (id.startsWith(instance.id + "[") || id.startsWith(instance.id + "/")) n++;
  return n;
}

/**
 * Rows in display order, honouring folds. Beneath an open group comes its body, drawn once:
 * one row per template entry, showing the current pass's instance, so a running loop moves
 * back and forth over the same rows instead of appending new ones. A loop that has not started
 * shows its body as pending placeholders.
 */
export function visibleRows(g: GraphModel, expanded: ReadonlySet<string>, folded?: ReadonlySet<string>): VisibleRow[] {
  return walkRows(g, { expanded, folded }).rows;
}

function walkRows(g: GraphModel, options: LayoutOptions, openAll = false): { rows: VisibleRow[]; hidden: number } {
  const children = childrenByParent(g);
  const rows: VisibleRow[] = [];
  let hidden = 0;
  const walkBody = (groupRow: string, group: GraphNode, instance: GraphNode | undefined, depth: number, seenTemplates: ReadonlySet<string>) => {
    const template = instance?.loop?.template ?? group.loop?.template;
    if (template && seenTemplates.has(template)) return;
    const seen = new Set(seenTemplates);
    if (template) seen.add(template);
    const kids = instance ? children.get(instance.id) ?? [] : [];
    const entries = bodyEntries(g, template, kids).map((entry) => ({ ...entry, id: bodyId(groupRow, entry.key), needs: entry.needs.map((key) => bodyId(groupRow, key)) }));
    for (const entry of orderByDependency(entries)) {
      const instances = kids.filter((child) => localKey(child.id, child.parent!) === entry.key);
      const current = currentInstance(group.type, instances);
      const node: GraphNode = current
        ? { ...current, id: entry.id, label: current.label, needs: entry.needs, parent: groupRow, loop: current.loop ?? entry.loop }
        : placeholder(entry.id, entry, entry.needs, groupRow);
      walk(node, current, depth, groupRow, "body", seen);
    }
  };
  const walk = (node: GraphNode, instance: GraphNode | undefined, depth: number, parentId: string | undefined, kind: RowKind, seenTemplates: ReadonlySet<string>) => {
    const group = isGroupType(node.type);
    const open = group && (openAll || isOpen(node.id, options));
    const kids = instance ? children.get(instance.id) ?? [] : [];
    rows.push({ id: node.id, node, kind, instance, depth, expanded: open, iterations: iterationCount(kids), parentId });
    if (group && !open && instance) hidden += countDescendants(g, instance);
    if (open) walkBody(node.id, node, instance, depth + 1, seenTemplates);
  };
  const top = g.order.map((id) => g.nodes[id]!).filter((n) => !(n.parent && g.nodes[n.parent]));
  for (const node of orderByDependency(top)) walk(node, node, 0, undefined, "node", new Set());
  return { rows, hidden };
}

/** Every group row id a fold can apply to, open or not. */
export function foldableIds(g: GraphModel): string[] {
  return walkRows(g, { expanded: new Set() }, true).rows.filter((row) => isGroupType(row.node.type)).map((row) => row.id);
}

export function layoutGraph(g: GraphModel, options: LayoutOptions): GraphLayout {
  const walked = walkRows(g, options);
  const visible = walked.rows;
  const nodeById = new Map(visible.map((v) => [v.id, v.node] as const));
  // Edge state is looked up on the real instance, so a body lane sweeps green again each pass.
  const instanceId = (rowId: string) => nodeById.get(rowId) && visible.find((v) => v.id === rowId)?.instance?.id;
  // The rows a group's loop-back lane spans: its first and last direct body row.
  const bodySpan = new Map<string, { first: number; last: number }>();
  visible.forEach((v, i) => {
    if (v.kind !== "body" || !v.parentId) return;
    const span = bodySpan.get(v.parentId);
    if (span) span.last = i;
    else bodySpan.set(v.parentId, { first: i, last: i });
  });
  const loopStart = new Map<number, string>();
  const loopEnd = new Map<number, string>();
  for (const [group, span] of bodySpan) {
    loopStart.set(span.first, group);
    loopEnd.set(span.last, group);
  }

  const lanes: Array<Lane | null> = [];
  const rows: LayoutRow[] = [];
  let laneCount = 0;
  const laneCell = (lane: Lane, r: number, extra = 0): LaneCell => lane.loop
    ? { ch: "│", hright: false, kind: "loop", from: lane.from, dist: 0 }
    : { ch: "│", hright: false, kind: "pass", from: lane.from, targets: lane.pending.map((id) => instanceId(id) ?? id), dist: r - lane.srcRow + extra };
  const empty = (): LaneCell => ({ ch: " ", hright: false, kind: "empty", dist: 0 });

  for (let r = 0; r < visible.length; r++) {
    const entry = visible[r]!;
    const { id, depth, node } = entry;

    // Taken before this row consumes anything, so a lane that turns into this row's node or
    // corner is still drawn arriving from above instead of breaking off a line short.
    const above: LaneCell[] = r === 0 ? [] : lanes.map((lane) => (lane ? laneCell(lane, r, -0.5) : empty()));

    // A loop-back lane takes the leftmost free column before the body's first node is placed.
    const startingGroup = loopStart.get(r);
    let loopCol = -1;
    if (startingGroup) {
      loopCol = lanes.findIndex((l) => l === null);
      if (loopCol < 0) {
        loopCol = lanes.length;
        lanes.push(null);
      }
      const groupRow = visible.find((v) => v.id === startingGroup);
      lanes[loopCol] = { from: groupRow?.instance?.id ?? startingGroup, srcRow: r, pending: [], loop: true };
    }

    const incoming: number[] = [];
    lanes.forEach((lane, i) => {
      if (lane && !lane.loop && lane.pending[0] === id) incoming.push(i);
    });

    let col = -1;
    for (const i of incoming) {
      if (lanes[i]!.pending.length === 1) {
        col = i;
        break;
      }
    }
    if (col < 0) {
      col = lanes.findIndex((l) => l === null);
      if (col < 0) {
        col = lanes.length;
        lanes.push(null);
      }
    }

    const width = Math.max(lanes.length, col + 1);
    const cells: LaneCell[] = [];
    for (let i = 0; i < width; i++) {
      const lane = lanes[i] ?? null;
      if (lane && !incoming.includes(i)) cells.push(laneCell(lane, r));
      else cells.push(empty());
    }

    // Horizontal runs first, then corners, so merges resolve predictably.
    for (const i of incoming) {
      if (i === col) continue;
      const lane = lanes[i]!;
      const lo = Math.min(i, col);
      const hi = Math.max(i, col);
      for (let x = lo; x < hi; x++) {
        const c = cells[x]!;
        c.hright = true;
        if (x !== lo) {
          c.ch = mergeChar(c.ch, "─");
          if (c.kind === "empty") c.kind = "edge";
          if (c.kind !== "node" && c.kind !== "loop") {
            c.from = lane.from;
            c.to = instanceId(id) ?? id;
            c.dist = r - lane.srcRow + Math.abs(x - i);
          }
        }
      }
    }
    for (const i of incoming) {
      if (i === col) continue;
      const lane = lanes[i]!;
      const continuing = lane.pending.length > 1;
      const corner = i < col ? (continuing ? "├" : "╰") : continuing ? "┤" : "╯";
      const c = cells[i]!;
      c.ch = mergeChar(c.ch === " " ? " " : c.ch, corner);
      c.kind = continuing ? "pass" : "edge";
      c.from = lane.from;
      c.to = instanceId(id) ?? id;
      c.targets = continuing ? lane.pending.slice(1).map((t) => instanceId(t) ?? t) : undefined;
      c.dist = r - lane.srcRow;
      lane.pending.shift();
      if (!continuing) lanes[i] = null;
    }
    if (incoming.includes(col)) {
      lanes[col]!.pending.shift();
    }

    const nodeCell = cells[col]!;
    nodeCell.ch = "●";
    nodeCell.kind = "node";
    nodeCell.from = undefined;
    nodeCell.to = undefined;
    nodeCell.targets = undefined;
    nodeCell.dist = 0;
    nodeCell.hright = nodeCell.hright && incoming.some((i) => i > col);

    // The loop-back lane turns into the body's first and last node: ╭─ at the top, ╰─ at the
    // bottom, or ↻─ when the body is a single row.
    const endingGroup = loopEnd.get(r);
    const loopLane = startingGroup ? loopCol : endingGroup ? lanes.findIndex((l) => l?.loop && l.from === (visible.find((v) => v.id === endingGroup)?.instance?.id ?? endingGroup)) : -1;
    if (loopLane >= 0 && loopLane !== col) {
      const c = cells[loopLane]!;
      c.ch = startingGroup && endingGroup ? "↻" : startingGroup ? "╭" : "╰";
      c.kind = "loop";
      c.from = lanes[loopLane]!.from;
      const lo = Math.min(loopLane, col);
      const hi = Math.max(loopLane, col);
      for (let x = lo; x < hi; x++) {
        const cell = cells[x]!;
        cell.hright = true;
        if (x !== lo) {
          cell.ch = mergeChar(cell.ch, "─");
          if (cell.kind === "empty") {
            cell.kind = "loop";
            cell.from = c.from;
          }
        }
      }
      nodeCell.hright = nodeCell.hright || loopLane > col;
    }
    if (endingGroup && loopLane >= 0) lanes[loopLane] = null;

    // Outgoing lane: every visible dependant below this row.
    const dependants: string[] = [];
    for (let k = r + 1; k < visible.length; k++) {
      const other = nodeById.get(visible[k]!.id)!;
      if (other.needs.includes(id)) dependants.push(other.id);
    }
    lanes[col] = dependants.length > 0 ? { from: instanceId(id) ?? id, srcRow: r, pending: dependants } : null;

    laneCount = Math.max(laneCount, width);
    rows.push({
      id,
      node,
      kind: entry.kind,
      instance: entry.instance,
      depth,
      col,
      cells,
      above,
      group: isGroupType(node.type),
      expanded: entry.expanded,
      iterations: entry.iterations,
      parentId: entry.parentId,
    });
  }

  for (const row of rows) {
    for (const lane of [row.cells, row.above]) {
      while (lane.length < laneCount) lane.push(empty());
    }
  }

  return { rows, laneCount, hidden: walked.hidden };
}

/** The loop glyph shown beside a group label: a cycle for repeat, a stack for foreach. */
export function loopGlyph(type: GraphNode["type"]): string {
  return type === "repeat" ? "↻" : type === "foreach" ? "≡" : "";
}

/** Text for a group row's type column: kind plus how far the loop has come, e.g. "repeat · 2/50". */
export function groupSummary(row: Pick<LayoutRow, "node" | "iterations">): string {
  const { node } = row;
  const unit = node.type === "repeat" ? "iterations" : "items";
  const max = node.loop?.max;
  const count = row.iterations;
  if (count > 0) return max !== undefined && node.type === "repeat" ? `${node.type} · ${count}/${max}` : `${node.type} · ${count} ${unit}`;
  return max !== undefined ? `${node.type} · ≤${max} ${unit}` : node.type;
}

// ---------------------------------------------------------------------------
// Presentation helpers (still renderer independent)

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const EDGE_SWEEP_MS_PER_CELL = 45;

/** Reveal animation length for previewed node definitions. */
export const REVEAL_MS = 300;

export function statusGlyph(status: UINodeStatus, tick = 0): string {
  switch (status) {
    case "building":
      return "◌";
    case "done":
      return "●";
    case "running":
      return SPINNER_FRAMES[tick % SPINNER_FRAMES.length]!;
    case "failed":
      return "✖";
    case "yielded":
      return "◆";
    case "exhausted":
      return "◈";
    case "blocked":
      return "○";
    case "skipped":
      return "◌";
    case "cancelled":
      return "⊘";
    default:
      return "○";
  }
}

export function statusLabel(status: UINodeStatus): string {
  return status;
}

export type EdgeState = "idle" | "sweeping" | "ready";

/** How an edge cell should be drawn at time `now`, given the sweep animation. */
export function edgeCellState(g: GraphModel, cell: LaneCell, now: number): EdgeState {
  if (!cell.from) return "idle";
  // A lane segment may carry several edges from the same source (one per
  // dependant). It turns green as soon as any of them is ready.
  const targets = new Set<string>(cell.targets ?? []);
  if (cell.to) targets.add(cell.to);
  let readyAt: number | undefined;
  for (const e of g.edges) {
    if (e.from === cell.from && targets.has(e.to) && e.readyAt !== undefined) {
      readyAt = readyAt === undefined ? e.readyAt : Math.min(readyAt, e.readyAt);
    }
  }
  if (readyAt === undefined) return "idle";
  const reachedAt = readyAt + cell.dist * EDGE_SWEEP_MS_PER_CELL;
  return now >= reachedAt ? "ready" : "sweeping";
}

/** True while any ready edge is still animating its green sweep. */
export function sweepActive(g: GraphModel, layout: GraphLayout, now: number): boolean {
  for (const row of layout.rows) {
    for (const cell of row.cells) {
      if (cell.kind === "pass" || cell.kind === "edge") {
        if (edgeCellState(g, cell, now) === "sweeping") return true;
      }
    }
  }
  return false;
}

export function toneOf(node: GraphNode): StatusTone {
  return statusTone(node.status);
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s.toString().padStart(2, "0")}s`;
}

/** 0..1 progress of a previewed node's reveal at time `now` (1 when fully shown or not previewed). */
export function revealProgress(node: GraphNode, now: number): number {
  if (node.revealedAt === undefined) return 1;
  return Math.max(0, Math.min(1, (now - node.revealedAt) / REVEAL_MS));
}

/** True while any previewed node is still fading in. */
export function revealActive(g: GraphModel, now: number): boolean {
  for (const id of g.order) if (revealProgress(g.nodes[id]!, now) < 1) return true;
  return false;
}

export function nodeDuration(node: GraphNode, now: number): number | undefined {
  if (node.startedAt === undefined) return undefined;
  const end = node.finishedAt ?? (node.status === "running" ? now : undefined);
  return end === undefined ? undefined : end - node.startedAt;
}

/** Plain-text rendering of a row's gutter (2 columns per lane). */
export function gutterText(row: LayoutRow): string {
  return row.cells.map((c) => c.ch + (c.hright ? "─" : " ")).join("");
}

/** Plain-text rendering of the whole layout (used by tests and debugging). */
export function layoutToText(layout: GraphLayout, tick = 0): string {
  return layout.rows
    .map((row) => {
      const ghost = !row.instance;
      const glyph = ghost ? "◌" : statusGlyph(row.node.status, tick);
      const gutter = gutterText(row).replace(/●/g, glyph);
      const indent = "  ".repeat(row.depth);
      const caret = row.group ? (row.expanded ? "▾ " : "▸ ") : "";
      const mark = row.group ? loopGlyph(row.node.type) + " " : "";
      const status = ghost ? "body" : row.node.status;
      return `${gutter}${indent}${caret}${mark}${row.node.label} [${status}]`;
    })
    .join("\n");
}
