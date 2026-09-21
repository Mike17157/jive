import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ImageRenderable, NativeImagePool, resolveImageRenderProtocol } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { orbSize, renderOrb, renderFlowerRaster } from "../orb.ts";

/** Frame period: gentle motion without excessive terminal redraws. */
const FRAME_MS = 100;

/**
 * Animated lit dahlia shown in the empty conversation, drawn in shaded blocks:
 * it blooms, sways, and occasionally folds and reopens. Purely
 * visual: no captions beneath the art. Sizing and drawing live in ../orb.ts.
 */
export function Orb(props: { width: number; height: number; animate?: boolean }) {
  const { width, height } = orbSize(props.width, props.height);
  const [t, setT] = useState(0);
  const [seed] = useState(() => Math.random() * 1000);
  const animate = props.animate ?? true;
  const renderer = useRenderer();
  const [graphicsFailed, setGraphicsFailed] = useState(false);
  const onGraphicsError = useCallback(() => setGraphicsFailed(true), []);
  const protocol = useSyncExternalStore(
    useCallback((notify: () => void) => {
      renderer.on("capabilities", notify);
      renderer.on("resize", notify);
      return () => {
        renderer.off("capabilities", notify);
        renderer.off("resize", notify);
      };
    }, [renderer]),
    () => resolveImageRenderProtocol("auto", renderer.capabilities, !!renderer.resolution),
  );
  useEffect(() => {
    if (!animate) return;
    const started = performance.now();
    const offset = t;
    const id = setInterval(() => setT(offset + (performance.now() - started) / 1000), FRAME_MS);
    return () => clearInterval(id);
  }, [animate]);
  if (protocol !== "blocks" && !graphicsFailed) {
    return (
      <box flexDirection="column" alignItems="center" width="100%">
        <DenseFlower width={width} height={height} t={t} seed={seed} onError={onGraphicsError} />
      </box>
    );
  }
  const frame = renderOrb(t, width, height, seed);
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

/** Keep the layout in terminal cells while the image contains a denser grid. */
function DenseFlower(props: { width: number; height: number; t: number; seed: number; onError: () => void }) {
  const target = useRef<ImageRenderable | null>(null);
  const pool = useRef<NativeImagePool | null>(null);
  const { width, height, t, seed, onError } = props;
  useEffect(() => {
    // Each mini glyph is 4×8 raster pixels; there are 2×2 per terminal cell.
    try {
      const images = new NativeImagePool({ width: width * 8, height: height * 16 });
      pool.current = images;
      return () => {
        pool.current = null;
        images.dispose();
      };
    } catch {
      onError();
    }
  }, [width, height, onError]);
  useEffect(() => {
    if (!target.current || !pool.current) return;
    try {
      const raster = renderFlowerRaster(t, width, height, seed);
      const image = pool.current.publishRgba(raster.data);
      if (!image) return; // The renderer is still using every pool slot.
      try {
        // ImageRenderable retains its own reference synchronously.
        target.current.source = image;
      } finally {
        image.dispose();
      }
    } catch {
      onError();
    }
  }, [t, width, height, seed, onError]);
  return <image id="flower-graphics" ref={target} width={width} height={height} fit="fill" protocol="auto" onError={onError} />;
}

export const Flower = Orb;
