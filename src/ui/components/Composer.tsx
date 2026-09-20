import { RGBA, type BoxRenderable, type KeyBinding, type OptimizedBuffer, type TextareaRenderable } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { useCallback, useEffect, useMemo, useState, type RefObject } from "react";
import { borderRing, GLIMMER_FRAME_MS, glimmerColor, rayIntensity, rayState } from "../glimmer.ts";
import { palette } from "../theme.ts";

/** Enter submits; Shift+Enter, Alt+Enter and Ctrl+J insert a newline. */
export const composerKeyBindings: KeyBinding[] = [
  { name: "return", action: "submit" },
  { name: "kpenter", action: "submit" },
  { name: "return", shift: true, action: "newline" },
  { name: "return", meta: true, action: "newline" },
  { name: "linefeed", action: "newline" },
];

const MAX_LINES = 6;
/** Columns used by the "❯ " prompt glyph beside the text. */
const PROMPT_WIDTH = 2;
/** Horizontal margin around the composer card. */
export const COMPOSER_MARGIN_X = 2;
/** Rows used by the composer chrome (border, top padding, bottom margin) beyond the text lines. */
export const COMPOSER_CHROME_ROWS = 4;

const glimmerEpoch = Date.now();
const inputBackground = RGBA.fromHex(palette.input);

/**
 * Recolour the card's border after the box has drawn it: a white base with a
 * slanted blue ray that sweeps left and right, lighting the top and bottom
 * edges together. Only colours change, so the border characters and layout
 * stay exactly what the box produced.
 */
function paintGlimmer(this: BoxRenderable, buffer: OptimizedBuffer): void {
  const ray = rayState((Date.now() - glimmerEpoch) / 1000, this.width);
  const chars = buffer.buffers.char;
  const stride = buffer.width;
  for (const cell of borderRing(this.width, this.height)) {
    const x = this.screenX + cell.x;
    const y = this.screenY + cell.y;
    if (x < 0 || y < 0 || x >= buffer.width || y >= buffer.height) continue;
    const code = chars[y * stride + x] ?? 0;
    if (!code) continue;
    const fg = RGBA.fromHex(glimmerColor(rayIntensity(cell.x, cell.y, this.width, this.height, ray)));
    buffer.setCell(x, y, String.fromCodePoint(code), fg, inputBackground);
  }
}

export function Composer(props: {
  textareaRef: RefObject<TextareaRenderable | null>;
  focused: boolean;
  width: number;
  onSubmit: () => void;
  onTextChange?: (text: string) => void;
  onLinesChange?: (lines: number) => void;
}) {
  const [lines, setLines] = useState(1);
  const { onTextChange, onLinesChange } = props;
  const renderer = useRenderer();
  // The glimmer is painted from the clock on every frame; this only asks for
  // frames while the card is focused, without touching React state.
  useEffect(() => {
    if (!props.focused) return;
    const id = setInterval(() => renderer.requestRender(), GLIMMER_FRAME_MS);
    return () => clearInterval(id);
  }, [props.focused, renderer]);
  const renderAfter = useMemo(() => (props.focused ? paintGlimmer : undefined), [props.focused]);
  // `virtualLineCount` is clamped to the current viewport height, so reading it
  // to size the box would pin the composer at one row forever. The editor view's
  // total count is the wrapped height the text actually needs.
  const measure = useCallback((ta: TextareaRenderable) => {
    const wrapped = ta.editorView?.getTotalVirtualLineCount?.() ?? 0;
    return Math.max(1, Math.min(MAX_LINES, wrapped || ta.lineCount || 1));
  }, []);
  const resize = useCallback(
    (count: number) =>
      setLines((prev) => {
        if (prev !== count) onLinesChange?.(count);
        return count;
      }),
    [onLinesChange],
  );
  const onContentChange = useCallback(() => {
    const ta = props.textareaRef.current;
    if (!ta) return;
    resize(measure(ta));
    onTextChange?.(ta.plainText);
  }, [props.textareaRef, onTextChange, measure, resize]);
  // A narrower terminal re-wraps existing text without a content change.
  useEffect(() => {
    const ta = props.textareaRef.current;
    if (ta) resize(measure(ta));
  }, [props.width, props.textareaRef, measure, resize]);
  // Explicit width: the row's prompt glyph plus card chrome, subtracted so the
  // wrapped text stops at the border instead of painting over it.
  const textWidth = Math.max(8, props.width - COMPOSER_MARGIN_X * 2 - 4 - PROMPT_WIDTH);
  return (
    <box
      flexDirection="column"
      flexShrink={0}
      height={lines + COMPOSER_CHROME_ROWS - 1}
      marginX={COMPOSER_MARGIN_X}
      marginBottom={1}
      border
      borderStyle="rounded"
      borderColor={props.focused ? palette.border : palette.borderSoft}
      backgroundColor={palette.input}
      paddingX={1}
      paddingTop={1}
      renderAfter={renderAfter}
    >
      <box flexDirection="row" width="100%" height={lines} flexShrink={0}>
        <text fg={props.focused ? palette.accent : palette.textFaint} wrapMode="none" width={PROMPT_WIDTH} flexShrink={0}>
          {"❯ "}
        </text>
        <textarea
          ref={props.textareaRef}
          focused={props.focused}
          placeholder="Ask, or type / for commands"
          placeholderColor={palette.textFaint}
          textColor={palette.text}
          focusedTextColor={palette.text}
          backgroundColor={palette.input}
          focusedBackgroundColor={palette.input}
          cursorColor={palette.accent}
          keyBindings={composerKeyBindings}
          wrapMode="word"
          onSubmit={props.onSubmit}
          onContentChange={onContentChange}
          height={lines}
          width={textWidth}
          flexShrink={0}
        />
      </box>
    </box>
  );
}
