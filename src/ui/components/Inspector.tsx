import type { GraphModel, GraphNode } from "../graph/model.ts";
import { edgeReady, statusTone } from "../graph/model.ts";
import { formatDuration, nodeDuration } from "../graph/layout.ts";
import { palette } from "../theme.ts";

const MAX_LINES = 120;

export function pretty(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Bound a block of text, reporting exactly how much was left out. */
export function bounded(text: string, maxLines = MAX_LINES): { text: string; omitted: number } {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return { text, omitted: 0 };
  return { text: lines.slice(0, maxLines).join("\n"), omitted: lines.length - maxLines };
}

function toneColor(tone: ReturnType<typeof statusTone>): string {
  switch (tone) {
    case "done":
      return palette.green;
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

function Section(props: { title: string; body: string; color?: string }) {
  const b = bounded(props.body);
  return (
    <box flexDirection="column" marginTop={1}>
      <text fg={palette.accent} wrapMode="none">
        {props.title}
      </text>
      <text fg={props.color ?? palette.text}>{b.text}</text>
      {b.omitted > 0 ? <text fg={palette.yellow}>… {b.omitted} more lines not shown (full record in artifact)</text> : null}
    </box>
  );
}

export function Inspector(props: { graph: GraphModel; node: GraphNode; width: number; height: number; now: number }) {
  const { graph, node } = props;
  const tone = statusTone(node.status);
  const duration = formatDuration(nodeDuration(node, props.now));
  const boxWidth = Math.max(20, props.width - 2);
  const boxHeight = Math.max(6, props.height - 3);
  const lastRequest = node.jevRequests[node.jevRequests.length - 1];
  const lastResponse = node.jevResponses[node.jevResponses.length - 1];
  const output = node.result?.output !== undefined ? pretty(node.result.output) : node.output;
  return (
    <box
      position="absolute"
      top={1}
      left={1}
      width={boxWidth}
      height={boxHeight}
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={toneColor(tone)}
      backgroundColor={palette.surfaceRaised}
      title={` ${node.label} `}
      titleColor={palette.text}
      zIndex={30}
      paddingX={1}
    >
      <text wrapMode="none">
        <span fg={palette.textDim}>{node.id}</span>
        <span fg={palette.textFaint}> · </span>
        <span fg={palette.accent}>{node.type}</span>
        <span fg={palette.textFaint}> · </span>
        <span fg={toneColor(tone)}>{node.status === "building" ? "drafted (not yet created)" : node.status}</span>
        {duration ? <span fg={palette.textDim}> · {duration}</span> : null}
        {node.parent ? <span fg={palette.textFaint}> · in {node.parent}</span> : null}
      </text>
      <scrollbox flexGrow={1} focused scrollY stickyScroll={false} viewportCulling>
        <box flexDirection="column">
          {node.needs.length > 0 ? (
            <text wrapMode="word">
              <span fg={palette.accent}>needs </span>
              {node.needs.map((dep, i) => (
                <span key={dep} fg={edgeReady(graph, dep, node.id) ? palette.green : palette.grey}>
                  {(edgeReady(graph, dep, node.id) ? "● " : "○ ") + dep + (i < node.needs.length - 1 ? "  " : "")}
                </span>
              ))}
            </text>
          ) : (
            <text fg={palette.textFaint}>no dependencies</text>
          )}
          {node.artifact ? (
            <text wrapMode="none">
              <span fg={palette.accent}>artifact </span>
              <span fg={palette.text}>{node.artifact}</span>
            </text>
          ) : null}
          {node.error ? <Section title="error" body={node.error} color={palette.yellow} /> : null}
          {lastRequest ? (
            <>
              <Section title={`jev request · state${node.jevRequests.length > 1 ? ` (${node.jevRequests.length} requests, latest)` : ""}`} body={pretty(lastRequest.data.state)} />
              <Section title="jev request · questions" body={pretty(lastRequest.data.questions)} />
              {lastRequest.data.model !== undefined ? <Section title="jev request · model" body={pretty(lastRequest.data.model)} /> : null}
            </>
          ) : null}
          {lastResponse ? <Section title="jev response · answers" body={pretty(lastResponse.data.answers ?? lastResponse.data)} /> : null}
          {output ? <Section title={node.result?.output !== undefined ? "output" : "output (live)"} body={output} /> : null}
          {node.activity.length > 0 ? (
            <Section title={`plugin activity (${node.activity.length})`} body={node.activity.map((a) => pretty(a.data.message ?? a.data.activity ?? a.data)).join("\n")} />
          ) : null}
          {!output && !lastRequest && !node.error && node.activity.length === 0 ? (
            <text fg={palette.textFaint} marginTop={1}>
              Nothing recorded for this node yet.
            </text>
          ) : null}
        </box>
      </scrollbox>
      <text fg={palette.textFaint} wrapMode="none">
        ↑/↓ scroll · Esc or ← back
      </text>
    </box>
  );
}
