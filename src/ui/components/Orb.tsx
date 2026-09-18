import { useEffect, useState } from "react";
import { orbSize, renderOrb } from "../orb.ts";

/** Frame period: slow enough to read as a breeze, not a flicker. */
const FRAME_MS = 120;

/**
 * Animated procedural flower shown in the empty conversation. Purely visual:
 * no captions beneath the art. Sizing and drawing live in ../orb.ts.
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
