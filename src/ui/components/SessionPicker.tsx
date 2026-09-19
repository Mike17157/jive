import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useMemo, useRef, useState } from "react";
import type { SessionSummary } from "../../session/types.ts";
import { palette } from "../theme.ts";

function truncate(value: string, width: number): string {
  if (width <= 1) return value.slice(0, Math.max(0, width));
  const chars = [...value];
  return chars.length <= width ? value : `${chars.slice(0, width - 1).join("")}…`;
}

export function relativeSessionTime(timestamp: string, now = Date.now()): string {
  const elapsed = Math.max(0, now - Date.parse(timestamp));
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function SessionPicker(props: {
  sessions: SessionSummary[];
  current: string;
  width: number;
  height: number;
  loading: boolean;
  error?: string;
  onChoose: (id: string) => void;
  onCancel: () => void;
}) {
  const [query, setQueryState] = useState("");
  const [cursor, setCursorState] = useState(0);
  const queryRef = useRef(query);
  const cursorRef = useRef(cursor);
  const setQuery = (value: string) => {
    queryRef.current = value;
    setQueryState(value);
    cursorRef.current = 0;
    setCursorState(0);
  };
  const setCursor = (value: number) => {
    cursorRef.current = value;
    setCursorState(value);
  };
  const sessions = useMemo(() => {
    const needle = query.toLocaleLowerCase();
    if (!needle) return props.sessions;
    return props.sessions.filter((session) =>
      [session.name, session.id, session.model ?? ""]
        .some((value) => value.toLocaleLowerCase().includes(needle))
    );
  }, [props.sessions, query]);

  const boxWidth = Math.max(20, Math.min(props.width - 4, 72));
  const maxRows = Math.max(1, Math.min(12, props.height - 9));
  const boxHeight = Math.min(props.height - 4, maxRows + 5);
  const selected = Math.min(cursor, Math.max(0, sessions.length - 1));
  const offset = Math.max(0, Math.min(selected - maxRows + 1, sessions.length - maxRows));
  const visible = sessions.slice(offset, offset + maxRows);

  useKeyboard((key: KeyEvent) => {
    const consume = () => { key.preventDefault(); key.stopPropagation(); };
    if (key.name === "escape") { consume(); props.onCancel(); return; }
    if (props.loading || props.error) return;
    if (key.name === "up" || key.name === "down" || key.name === "home" || key.name === "end" || key.name === "return" || key.name === "kpenter") consume();
    if (key.name === "up") setCursor(Math.max(0, cursorRef.current - 1));
    if (key.name === "down") setCursor(Math.min(sessions.length - 1, cursorRef.current + 1));
    if (key.name === "home") setCursor(0);
    if (key.name === "end") setCursor(Math.max(0, sessions.length - 1));
    if ((key.name === "return" || key.name === "kpenter") && sessions[selected]) {
      props.onChoose(sessions[selected]!.id);
      return;
    }
    if (key.name === "backspace") {
      consume();
      setQuery([...queryRef.current].slice(0, -1).join(""));
      return;
    }
    if (key.ctrl || key.meta || key.name === "tab") return;
    const sequence = key.sequence ?? "";
    if ([...sequence].length === 1 && sequence >= " ") {
      consume();
      setQuery(queryRef.current + sequence);
    }
  });

  return (
    <box
      position="absolute"
      top={Math.max(0, Math.floor((props.height - boxHeight) / 2))}
      left={Math.max(0, Math.floor((props.width - boxWidth) / 2))}
      width={boxWidth}
      height={boxHeight}
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={palette.accent}
      backgroundColor={palette.surfaceRaised}
      title=" sessions "
      titleColor={palette.accent}
      zIndex={20}
      paddingX={1}
    >
      <text fg={query ? palette.text : palette.textFaint} wrapMode="none">
        {query ? `search: ${truncate(query, boxWidth - 12)}` : "type to search by name, id, or model"}
      </text>
      {props.loading ? (
        <text fg={palette.textDim}>Loading saved sessions…</text>
      ) : props.error ? (
        <text fg={palette.yellow}>{truncate(props.error, boxWidth - 4)}</text>
      ) : sessions.length === 0 ? (
        <text fg={palette.textDim}>{query ? "No matching sessions." : "No saved sessions."}</text>
      ) : (
        visible.map((session, row) => {
          const index = offset + row;
          const active = session.id === props.current;
          const metadata = `${session.id.slice(0, 8)} · ${relativeSessionTime(session.updatedAt)}`;
          const nameWidth = Math.max(4, boxWidth - metadata.length - 8);
          return (
            <box
              key={session.id}
              height={1}
              width="100%"
              flexDirection="row"
              justifyContent="space-between"
              backgroundColor={index === selected ? palette.accentSoft : palette.surfaceRaised}
            >
              <text fg={index === selected ? palette.text : palette.textDim} wrapMode="none">
                {active ? "● " : "  "}{truncate(session.name, nameWidth)}
              </text>
              <text fg={palette.textFaint} wrapMode="none">{metadata}</text>
            </box>
          );
        })
      )}
      <text fg={palette.textFaint} wrapMode="none">
        ↑/↓ · Enter resume · type search · Backspace · Esc
      </text>
    </box>
  );
}
