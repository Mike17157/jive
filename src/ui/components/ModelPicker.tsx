import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useMemo, useRef, useState } from "react";
import type { ModelOption } from "../../core/types.ts";
import { palette } from "../theme.ts";

function truncate(value: string, width: number): string {
  if (width <= 1) return value.slice(0, Math.max(0, width));
  const chars = [...value];
  return chars.length <= width ? value : `${chars.slice(0, width - 1).join("")}…`;
}

/**
 * Model selector shown as a modal overlay, like /sessions: type to narrow the list by
 * substring match against name or id, arrows/Enter to choose, matching /sessions's pattern.
 */
export function ModelPicker(props: {
  models: ModelOption[];
  current: string;
  width: number;
  height: number;
  onChoose: (id: string) => void;
  onCancel: () => void;
}) {
  const [query, setQueryState] = useState("");
  const [cursor, setCursorState] = useState(() => Math.max(0, props.models.findIndex((model) => model.id === props.current)));
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
  const models = useMemo(() => {
    const needle = query.toLocaleLowerCase();
    if (!needle) return props.models;
    return props.models.filter((model) =>
      [model.name, model.id].some((value) => value.toLocaleLowerCase().includes(needle))
    );
  }, [props.models, query]);

  const boxWidth = Math.max(20, Math.min(props.width - 4, 56));
  const maxRows = Math.max(1, Math.min(12, props.height - 9));
  const boxHeight = Math.min(props.height - 4, Math.min(models.length, maxRows) + 5);
  const selected = Math.min(cursor, Math.max(0, models.length - 1));
  const offset = Math.max(0, Math.min(selected - maxRows + 1, Math.max(0, models.length - maxRows)));
  const visible = models.slice(offset, offset + maxRows);

  useKeyboard((key: KeyEvent) => {
    const consume = () => { key.preventDefault(); key.stopPropagation(); };
    if (key.name === "escape") { consume(); props.onCancel(); return; }
    if (key.name === "up" || key.name === "down" || key.name === "home" || key.name === "end" || key.name === "return" || key.name === "kpenter") consume();
    if (key.name === "up") setCursor(Math.max(0, cursorRef.current - 1));
    if (key.name === "down") setCursor(Math.min(models.length - 1, cursorRef.current + 1));
    if (key.name === "home") setCursor(0);
    if (key.name === "end") setCursor(Math.max(0, models.length - 1));
    if ((key.name === "return" || key.name === "kpenter") && models[selected]) {
      props.onChoose(models[selected]!.id);
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
      title=" model "
      titleColor={palette.accent}
      zIndex={20}
      paddingX={1}
    >
      <text fg={query ? palette.text : palette.textFaint} wrapMode="none">
        {query ? `filter: ${truncate(query, boxWidth - 12)}` : "type to filter"}
      </text>
      {models.length === 0 ? (
        <text fg={palette.textDim} wrapMode="none">
          {query ? "No matching models. Esc to clear." : "No models listed. Use /model <id> to set one directly."}
        </text>
      ) : (
        visible.map((model, row) => {
          const index = offset + row;
          const active = model.id === props.current;
          return (
            <box
              key={model.id}
              height={1}
              width="100%"
              backgroundColor={index === selected ? palette.accentSoft : palette.surfaceRaised}
            >
              <text fg={index === selected ? palette.text : palette.textDim} wrapMode="none">
                {active ? "● " : "  "}{truncate(model.name, boxWidth - 4)}
              </text>
            </box>
          );
        })
      )}
      <text fg={palette.textFaint} wrapMode="none">
        ↑/↓ · Enter · Esc · /model &lt;id&gt; for a custom id
      </text>
    </box>
  );
}
