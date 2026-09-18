import { TextAttributes } from "@opentui/core";
import type { ReactNode } from "react";
import type { ChatEntry } from "../../core/types.ts";
import type { GraphModel } from "../graph/model.ts";
import { palette } from "../theme.ts";
import { thinkingTitle } from "../thinking.ts";
import { GraphView } from "./GraphView.tsx";
import { MarkdownMessage } from "./MarkdownMessage.tsx";

export interface GraphPlacement {
  graph: GraphModel;
  /** Message index the graph is shown before; >= messages.length places it at the end. */
  anchor: number;
  index: number;
}

/** Horizontal padding of the conversation column. */
export const CONVERSATION_PADDING_X = 3;

export function Message(props: { entry: ChatEntry; width: number; streaming?: boolean }) {
  const { entry } = props;
  if (entry.role === "user") {
    return (
      <box flexDirection="row" width="100%" marginTop={1}>
        <box
          flexDirection="column"
          maxWidth={Math.max(20, Math.floor(props.width * 0.85))}
          border={["left"]}
          borderStyle="single"
          borderColor={palette.user}
          backgroundColor={palette.surfaceRaised}
          paddingX={2}
          paddingY={0}
        >
          <text fg={palette.user} wrapMode="none">
            you
          </text>
          <text fg={palette.text} wrapMode="word">
            {entry.text}
          </text>
        </box>
      </box>
    );
  }
  if (entry.role === "thinking") {
    // The planner's reasoning for a round stays collapsed: one dim row whose
    // title follows the newest paragraph while the reasoning streams in, so
    // tool-only turns leave a trace without the prose competing with replies.
    return (
      <box flexDirection="row" width="100%" marginTop={1}>
        <text fg={palette.greyDim} wrapMode="none">
          {"▸ "}
        </text>
        <text fg={palette.textFaint} wrapMode="none" attributes={TextAttributes.ITALIC}>
          {thinkingTitle(entry.text)}
        </text>
      </box>
    );
  }
  if (entry.role === "notice") {
    return (
      <text fg={palette.textDim} wrapMode="word" marginTop={1}>
        {"· " + entry.text}
      </text>
    );
  }
  // A reply whose text has not arrived yet would render as a lone marker.
  if (!entry.text.trim()) return null;
  return (
    <box flexDirection="row" width="100%" marginTop={1}>
      <text fg={palette.accent} wrapMode="none">
        {"◆ "}
      </text>
      <box flexGrow={1} minWidth={0} flexDirection="column"><MarkdownMessage content={entry.text} streaming={props.streaming}/></box>
    </box>
  );
}

export function Conversation(props: {
  messages: ChatEntry[];
  placements: GraphPlacement[];
  width: number;
  /** Viewport height; short histories are pushed to the bottom so they grow upward. */
  minHeight: number;
  expanded: ReadonlySet<string>;
  focusedGraph: string | null;
  selectedRow: number;
  streaming?: boolean;
}) {
  const items: ReactNode[] = [];
  const total = props.placements.length;
  const innerWidth = props.width - CONVERSATION_PADDING_X * 2;
  const renderGraph = (p: GraphPlacement) => (
    <box key={`g:${p.graph.id}`} marginTop={1} width="100%">
      <GraphView graph={p.graph} width={innerWidth} expanded={props.expanded} selectedRow={props.selectedRow} focused={props.focusedGraph === p.graph.id} index={p.index} total={total} />
    </box>
  );
  props.messages.forEach((m, i) => {
    for (const p of props.placements) if (p.anchor === i) items.push(renderGraph(p));
    items.push(<Message key={`m:${m.id}`} entry={m} width={innerWidth} streaming={props.streaming && i===props.messages.length-1 && m.role==="assistant"}/>);
  });
  for (const p of props.placements) if (p.anchor >= props.messages.length) items.push(renderGraph(p));
  return (
    <box flexDirection="column" width="100%" minHeight={props.minHeight} justifyContent="flex-end" paddingX={CONVERSATION_PADDING_X} paddingBottom={1}>
      {items}
    </box>
  );
}
