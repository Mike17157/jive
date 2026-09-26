import { useKeyboard } from "@opentui/react";
import { useState } from "react";
import { palette } from "../theme";

const CHOICES = ["auto", "anthropic", "openrouter"] as const;
const DESCRIPTIONS: Record<(typeof CHOICES)[number], string> = {
  auto: "Default: direct Anthropic when credentialed, OpenRouter otherwise.",
  anthropic: "Force direct Anthropic for anthropic/claude-* models.",
  openrouter: "Force OpenRouter for anthropic/claude-* models.",
};

/** Rows the inline provider panel occupies, so the conversation viewport can shrink for it. */
export const PROVIDER_PANEL_ROWS = 5;

/**
 * Provider selector shown inline just above the composer, like /effort: no modal
 * overlay, the rest of the screen keeps its normal contrast.
 */
export function ProviderPicker(props: { current?: string; width: number; error?: string; onChoose: (provider: string) => void; onCancel: () => void }) {
  const [cursor, setCursor] = useState(() => Math.max(0, CHOICES.indexOf((props.current ?? "auto") as (typeof CHOICES)[number])));
  const index = Math.min(cursor, CHOICES.length - 1);
  useKeyboard(key => {
    const consume = () => { key.preventDefault(); key.stopPropagation(); };
    if (key.name === "escape") { consume(); props.onCancel(); return; }
    if (["left", "down", "right", "up", "home", "end", "return", "kpenter"].includes(key.name)) consume();
    if (key.name === "left" || key.name === "down") setCursor(value => Math.max(0, value - 1));
    if (key.name === "right" || key.name === "up") setCursor(value => Math.min(CHOICES.length - 1, value + 1));
    if (key.name === "home") setCursor(0);
    if (key.name === "end") setCursor(CHOICES.length - 1);
    if (key.name === "return" || key.name === "kpenter") props.onChoose(CHOICES[index]!);
  });
  const width = Math.min(props.width - 4, 64);
  const current = CHOICES[index]!;
  const step = Math.max(2, Math.min(7, Math.floor((width - 8) / Math.max(1, CHOICES.length - 1))));
  return <box flexDirection="column" flexShrink={0} marginX={2} width={width} border borderStyle="rounded"
    borderColor={palette.borderSoft} backgroundColor={palette.surface} paddingX={1}
    title=" provider " titleColor={palette.textDim}>
    <text wrapMode="none">
      {CHOICES.map((choice, i) => <span key={choice} fg={i <= index ? palette.accent : palette.greyDim}>{i === index ? "●" : "○"}{i < CHOICES.length - 1 ? "─".repeat(step) : ""}</span>)}
    </text>
    <text wrapMode="none"><span fg={palette.accent}>{current}</span></text>
    <text fg={props.error ? palette.yellow : palette.textFaint} wrapMode="none">{props.error ?? DESCRIPTIONS[current]}</text>
    <text fg={palette.textFaint} wrapMode="none">←/→ adjust · Enter apply · Esc cancel</text>
  </box>;
}
