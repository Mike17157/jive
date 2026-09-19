import type { AgentSnapshot } from "../../core/types.ts";
import { palette, gradientAt } from "../theme.ts";

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return String(n);
}

export function StatusBar(props: { snapshot: AgentSnapshot; width: number; mode: string; notice?: string }) {
  const { snapshot, width } = props;
  const used = snapshot.contextLimit > 0 ? Math.min(1, snapshot.contextTokens / snapshot.contextLimit) : 0;
  const barWidth = width >= 80 ? 10 : width >= 60 ? 6 : 0;
  const filled = Math.round(used * barWidth);
  const bar = barWidth > 0 ? "▰".repeat(filled) + "▱".repeat(barWidth - filled) : "";
  const modelName = snapshot.models.find((m) => m.id === snapshot.model)?.name ?? snapshot.model ?? "no model";
  const busy = snapshot.busy;
  const narrow = width < 60;
  return (
    <box flexDirection="row" justifyContent="space-between" width="100%" paddingX={1} flexShrink={0} height={1}>
      <text wrapMode="none">
        <span fg={busy ? palette.accent : palette.accent}>{busy ? "◉ " : "◇ "}</span>
        <span fg={palette.text}>{modelName}</span>
        {snapshot.effort&&!narrow?<span fg={palette.accent}> · {snapshot.effort}</span>:null}
        {!narrow ? <span fg={palette.textFaint}> · {snapshot.sessionId.slice(0, 8)}</span> : null}
        {props.notice ? <span fg={palette.yellow}>  {props.notice}</span> : null}
      </text>
      <text wrapMode="none">
        {bar ? <span fg={gradientAt(used)}>{bar} </span> : null}
        <span fg={palette.textDim}>
          {compact(snapshot.contextTokens)}/{compact(snapshot.contextLimit)}
        </span>
        {snapshot.cachedTokens > 0 && !narrow ? <span fg={palette.textFaint}> · {compact(snapshot.cachedTokens)} cached</span> : null}
        <span fg={palette.textFaint}> · {props.mode}</span>
      </text>
    </box>
  );
}
