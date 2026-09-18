import { Fragment, useEffect, useMemo, useState } from "react";
import type { GraphModel, GraphNode } from "../graph/model.ts";
import { countStatuses, statusTone, type StatusTone } from "../graph/model.ts";
import { edgeCellState, formatDuration, groupSummary, layoutGraph, loopGlyph, nodeDuration, revealActive, revealProgress, statusGlyph, sweepActive, type LaneCell, type LayoutRow } from "../graph/layout.ts";
import { dimHex, mixHex, palette } from "../theme.ts";

const TICK_MS = 80;
const BUILD_TICK_MS = 240;
const BUILD_DOTS = ["   ", ".  ", ".. ", "..."];

export function toneColor(tone: StatusTone, type?: GraphNode["type"]): string {
  switch (tone) {
    case "done":
      return type === "jev" ? palette.purple : palette.green;
    case "warn":
      return palette.yellow;
    case "blocked":
      return palette.grey;
    case "running":
      return palette.accent;
    case "building":
      return palette.textFaint;
    default:
      return palette.textDim;
  }
}

function cellColor(graph: GraphModel, cell: LaneCell, now: number, nodeColor: string): string {
  if (cell.kind === "node") return nodeColor;
  if (cell.kind === "empty") return palette.bg;
  if (cell.kind === "loop") {
    // The loop-back lane follows its group: lit while the loop runs, settled when it is over.
    const group = cell.from ? graph.nodes[cell.from] : undefined;
    return group ? dimHex(toneColor(statusTone(group.status)), 0.25) : palette.greyDim;
  }
  const state = edgeCellState(graph, cell, now);
  if (state === "ready") return palette.green;
  if (state === "sweeping") return dimHex(palette.green, 0.65);
  return palette.greyDim;
}

function truncate(s: string, max: number): string {
  if (max <= 1) return "";
  return s.length <= max ? s : s.slice(0, Math.max(1, max - 1)) + "…";
}

function graphStatusColor(status: string | undefined): string {
  switch (status) {
    case "done":
      return palette.green;
    case "partial":
    case "yielded":
      return palette.yellow;
    case "cancelled":
      return palette.grey;
    default:
      return palette.accent;
  }
}

/** Construction remains visible when committed nodes already execute. */
export function phaseCaption(graph: GraphModel, tick: number): { text: string; color: string } | null {
  if (graph.building) return { text: `assembling${BUILD_DOTS[tick % BUILD_DOTS.length]}`, color: palette.accent };
  switch (graph.phase) {
    case "building":
      return { text: `assembling${BUILD_DOTS[tick % BUILD_DOTS.length]}`, color: palette.textDim };
    case "ready":
      return { text: "ready to run", color: palette.textDim };
    case "interrupted":
      return { text: "assembly interrupted", color: palette.yellow };
    case "failed":
      return { text: graph.buildError ? `assembly failed · ${graph.buildError}` : "assembly failed", color: palette.yellow };
    default:
      return null;
  }
}

export interface GraphViewProps {
  graph: GraphModel;
  width: number;
  expanded: ReadonlySet<string>;
  folded?: ReadonlySet<string>;
  /** Row index highlighted when this graph has keyboard focus, else -1. */
  selectedRow: number;
  focused: boolean;
  index: number;
  total: number;
}

export function GraphView(props: GraphViewProps) {
  const { graph, width, expanded, folded } = props;
  const layout = useMemo(() => layoutGraph(graph, { expanded, folded }), [graph, expanded, folded]);
  const counts = countStatuses(graph);
  const [now, setNow] = useState(() => Date.now());
  const [tick, setTick] = useState(0);
  const building = graph.building ?? graph.phase === "building";
  const animating = counts.running > 0 || sweepActive(graph, layout, now) || revealActive(graph, now);
  useEffect(() => {
    if (!animating && !building) return;
    const id = setInterval(
      () => {
        setNow(Date.now());
        setTick((t) => t + 1);
      },
      animating ? TICK_MS : BUILD_TICK_MS,
    );
    return () => clearInterval(id);
  }, [animating, building]);
  useEffect(() => {
    setNow(Date.now());
  }, [graph.lastSequence]);

  const narrow = width < 70;
  const gutterWidth = layout.laneCount * 2;
  const labelBudget = Math.max(6, width - gutterWidth - (narrow ? 14 : 34));
  const caption = phaseCaption(graph, tick);
  const summary = [
    counts.total > counts.building ? `${counts.done}/${counts.total} done` : counts.total ? `${counts.total} nodes` : "",
    counts.building && counts.total > counts.building ? `${counts.building} drafted` : "",
    counts.running ? `${counts.running} running` : "",
    counts.warn ? `${counts.warn} stopped` : "",
    counts.blocked ? `${counts.blocked} blocked` : "",
    layout.hidden ? `${layout.hidden} folded` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const graphDuration = graph.startedAt !== undefined ? formatDuration((graph.finishedAt ?? now) - graph.startedAt) : "";

  return (
    <box flexDirection="column" width="100%" paddingLeft={1} border={["left"]} borderStyle="single" borderColor={props.focused ? palette.accent : palette.borderSoft}>
      <text wrapMode="none">
        <span fg={props.focused ? palette.accent : building ? palette.textDim : palette.text}>{props.focused ? "◆ " : building ? "◌ " : "◇ "}</span>
        <span fg={palette.text}>{truncate(graph.label, Math.max(8, width - 40))}</span>
        {props.total > 1 ? <span fg={palette.textFaint}> {props.index + 1}/{props.total}</span> : null}
        {caption ? (
          <>
            <span fg={palette.textFaint}> · </span>
            <span fg={caption.color}>{caption.text}</span>
          </>
        ) : null}
        {summary ? (
          <>
            <span fg={palette.textFaint}> · </span>
            <span fg={palette.textDim}>{summary}</span>
          </>
        ) : null}
        {graph.status ? (
          <>
            <span fg={palette.textFaint}> · </span>
            <span fg={graphStatusColor(graph.status)}>{graph.status}</span>
          </>
        ) : null}
        {graphDuration && !narrow ? <span fg={palette.textFaint}> · {graphDuration}</span> : null}
      </text>
      {graph.reason ? (
        <text fg={palette.yellow} wrapMode="word">
          {"  " + graph.reason}
        </text>
      ) : null}
      {layout.rows.map((row, i) => (
        <Fragment key={row.id}>
          {i > 0 && row.node.needs.includes(layout.rows[i-1]!.id) ? (
            <text wrapMode="none">
              {row.above.map((cell, column) => (
                <span key={column} fg={cellColor(graph,cell,now,palette.text)}>{cell.ch+" "}</span>
              ))}
            </text>
          ) : null}
          <GraphRow graph={graph} row={row} now={now} tick={tick} selected={props.focused && props.selectedRow === i} narrow={narrow} labelBudget={labelBudget} />
        </Fragment>
      ))}
      {layout.rows.length === 0 ? <text fg={palette.textFaint}>{building ? "  waiting for the first node…" : "  waiting for nodes…"}</text> : null}
    </box>
  );
}

function GraphRow(props: { graph: GraphModel; row: LayoutRow; now: number; tick: number; selected: boolean; narrow: boolean; labelBudget: number }) {
  const { graph, row, now, tick } = props;
  const node = row.node;
  const bg = props.selected ? palette.surfaceRaised : undefined;
  const indent = "  ".repeat(row.depth);
  const caret = row.group ? (row.expanded ? "▾ " : "▸ ") : "";
  const duration = formatDuration(nodeDuration(node, now));
  // A body row with no instance yet is a ghost: the loop's plan, not a node that exists.
  const ghost = !row.instance;
  const tone = statusTone(node.status);
  const color = ghost ? palette.textFaint : toneColor(tone, node.type);
  const reveal = revealProgress(node, now);
  // A previewed definition fades in: dim text and a faint leading dot until fully revealed.
  const revealing = reveal < 1;
  const glyph = ghost ? "◌" : revealing ? "·" : statusGlyph(node.status, tick);
  const labelColor = ghost ? palette.textDim : tone === "blocked" ? palette.grey : tone === "building" ? palette.textDim : palette.text;
  const fadedLabel = revealing ? mixHex(palette.bg, labelColor, 0.35 + 0.65 * reveal) : labelColor;
  const mark = row.group ? loopGlyph(node.type) + " " : "";
  const label = truncate(node.label, props.labelBudget - indent.length - caret.length - mark.length);
  const typeText = row.group ? groupSummary(row) : node.type;
  const statusText = ghost ? "" : node.status === "building" ? "drafted" : node.status;
  return (
    <text wrapMode="none" bg={bg}>
      {row.cells.map((cell, i) => (
        <span key={i} fg={cell.kind === "node" && revealing ? mixHex(palette.bg, color, 0.35 + 0.65 * reveal) : cellColor(graph, cell, now, color)}>
          {(cell.kind === "node" ? glyph : cell.ch) + (cell.hright ? "─" : " ")}
        </span>
      ))}
      <span fg={palette.textFaint}>{indent}</span>
      {caret ? <span fg={palette.accent}>{caret}</span> : null}
      {mark ? <span fg={ghost ? palette.textFaint : palette.accent}>{mark}</span> : null}
      <span fg={fadedLabel}>{label}</span>
      {!props.narrow ? <span fg={palette.textFaint}>  {typeText}</span> : null}
      {statusText ? <span fg={revealing ? mixHex(palette.bg, color, 0.35 + 0.65 * reveal) : color}>  {statusText}</span> : null}
      {duration && !props.narrow ? <span fg={palette.textFaint}> {duration}</span> : null}
      {node.artifact ? <span fg={palette.textFaint}> ⎘</span> : null}
      {node.error && !props.narrow ? <span fg={dimHex(palette.yellow, 0.3)}>  {truncate(node.error.split("\n")[0] ?? "", 30)}</span> : null}
    </text>
  );
}
