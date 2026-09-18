import { useEffect, useState } from "react";
import { orbSize, renderOrb } from "../orb.ts";

/** Frame period: smooth enough for the time-lapse bloom, cheap enough to loop forever. */
const FRAME_MS = 100;

/**
 * Animated lit dahlia shown in the empty conversation, drawn in Braille dots:
 * it blooms from a bud, holds, dissolves and grows again on a loop. Purely
 * visual: no captions beneath the art. Sizing and drawing live in ../orb.ts.
 */
export function Orb(props: { width: number; height: number; animate?: boolean }) {
  const { width, height } = orbSize(props.width, props.height);
  const [t, setT] = useState(0);
  const animate = props.animate ?? true;
  useEffect(() => {
    if (!animate) return;
    const started = Date.now();
    const id = setInterval(() => setT((Date.now() - started) / 1000), FRAME_MS);
    return () => clearInterval(id);
  }, [animate]);
  const frame = renderOrb(t, width, height);
  return (
    <box flexDirection="column" alignItems="center" width="100%">
      {frame.rows.map((runs, i) => (
        <text key={i} wrapMode="none">
          {runs.map((run, j) => (
            <span key={j} fg={run.color}>
              {run.text}
            </span>
          ))}
        </text>
      ))}
    </box>
  );
}

export const Flower = Orb;
