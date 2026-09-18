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
import type { GraphModel, GraphNode, UINodeStatus } from "./model.ts";
import { isGroupType, statusTone, type StatusTone } from "./model.ts";

export type CellKind = "empty" | "pass" | "edge" | "node";

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

export interface LayoutRow {
  id: string;
  node: GraphNode;
  /** Nesting depth (0 = top level, 1 = inside one group, ...). */
  depth: number;
  col: number;
  cells: LaneCell[];
  group: boolean;
  expanded: boolean;
  childCount: number;
}

export interface GraphLayout {
  rows: LayoutRow[];
  laneCount: number;
  /** Nodes hidden inside collapsed groups. */
  hidden: number;
}

interface Lane {
  from: string;
  srcRow: number;
  pending: string[];
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
  /** Ids of group nodes whose children are shown. */
  expanded: ReadonlySet<string>;
}

/** Visible rows in display order, honouring collapsed groups. */
export function visibleRows(g: GraphModel, expanded: ReadonlySet<string>): Array<{ id: string; depth: number }> {
  const children = new Map<string, string[]>();
  const top: string[] = [];
  for (const id of g.order) {
    const n = g.nodes[id]!;
    if (n.parent && g.nodes[n.parent]) {
      const list = children.get(n.parent) ?? [];
      list.push(id);
      children.set(n.parent, list);
    } else {
      top.push(id);
    }
  }
  const out: Array<{ id: string; depth: number }> = [];
  const walk = (id: string, depth: number) => {
    out.push({ id, depth });
    const kids = children.get(id);
    if (kids && expanded.has(id)) for (const k of kids) walk(k, depth + 1);
  };
  for (const id of top) walk(id, 0);
  return out;
}

export function childCount(g: GraphModel, id: string): number {
  let c = 0;
  for (const other of g.order) if (g.nodes[other]!.parent === id) c++;
  return c;
}

export function layoutGraph(g: GraphModel, options: LayoutOptions): GraphLayout {
  const visible = visibleRows(g, options.expanded);
  const rowIndex = new Map<string, number>();
  visible.forEach((v, i) => rowIndex.set(v.id, i));

  const lanes: Array<Lane | null> = [];
  const rows: LayoutRow[] = [];
  let laneCount = 0;

  for (let r = 0; r < visible.length; r++) {
    const { id, depth } = visible[r]!;
    const node = g.nodes[id]!;

    const incoming: number[] = [];
    lanes.forEach((lane, i) => {
      if (lane && lane.pending[0] === id) incoming.push(i);
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
      if (lane && !incoming.includes(i)) {
        cells.push({ ch: "│", hright: false, kind: "pass", from: lane.from, targets: [...lane.pending], dist: r - lane.srcRow });
      } else {
        cells.push({ ch: " ", hright: false, kind: "empty", dist: 0 });
      }
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
          if (c.kind !== "node") {
            c.from = lane.from;
            c.to = id;
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
      c.to = id;
      c.targets = continuing ? lane.pending.slice(1) : undefined;
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

    // Outgoing lane: every visible dependant below this row.
    const dependants: string[] = [];
    for (let k = r + 1; k < visible.length; k++) {
      const other = g.nodes[visible[k]!.id]!;
      if (other.needs.includes(id)) dependants.push(other.id);
    }
    lanes[col] = dependants.length > 0 ? { from: id, srcRow: r, pending: dependants } : null;

    laneCount = Math.max(laneCount, width);
    rows.push({
      id,
      node,
      depth,
      col,
      cells,
      group: isGroupType(node.type),
      expanded: options.expanded.has(id),
      childCount: childCount(g, id),
    });
  }

  for (const row of rows) {
    while (row.cells.length < laneCount) row.cells.push({ ch: " ", hright: false, kind: "empty", dist: 0 });
  }

  return { rows, laneCount, hidden: g.order.length - rows.length };
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
      const glyph = statusGlyph(row.node.status, tick);
      const gutter = gutterText(row).replace(/●/g, glyph);
      const indent = "  ".repeat(row.depth);
      const caret = row.group ? (row.expanded ? "▾ " : "▸ ") : "";
      return `${gutter}${indent}${caret}${row.node.label} [${row.node.status}]`;
    })
    .join("\n");
}
