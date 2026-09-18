import { mixHex, palette } from "./theme.ts";

/** Fraction of the card width lit by the ray at its widest. */
export const GLIMMER_COVERAGE = 0.4;
/** Seconds for one full sweep: left edge to right edge and back. */
export const SWEEP_PERIOD_S = 13;
/** Seconds for the ray's tilt to swing from one lean to the other and back. */
export const SKEW_PERIOD_S = 8.7;
/** Largest horizontal lean, in cells per row of card height. */
export const SKEW_MAX = 2.4;
/** The sweep overshoots each edge by this fraction of the half-width so the ray fades out past the corners. */
export const SWEEP_OVERSHOOT = 0.15;
/** Repaint period: slow enough to stay cheap, fast enough to read as motion. */
export const GLIMMER_FRAME_MS = 80;

export interface RingCell {
  x: number;
  y: number;
}

export interface RayState {
  /** Column the ray crosses at the card's vertical middle. */
  centre: number;
  /** Horizontal shift of the ray per row below the middle; negative leans the other way. */
  tilt: number;
}

/** Border cells of a width×height box, clockwise from the top-left corner. */
export function borderRing(width: number, height: number): RingCell[] {
  const cells: RingCell[] = [];
  if (width <= 0 || height <= 0) return cells;
  if (width === 1 || height === 1) {
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) cells.push({ x, y });
    return cells;
  }
  for (let x = 0; x < width; x++) cells.push({ x, y: 0 });
  for (let y = 1; y < height - 1; y++) cells.push({ x: width - 1, y });
  for (let x = width - 1; x >= 0; x--) cells.push({ x, y: height - 1 });
  for (let y = height - 2; y >= 1; y--) cells.push({ x: 0, y });
  return cells;
}

/**
 * Where the ray is at `seconds`. The sweep is sinusoidal, so it eases into
 * each edge and crosses the middle fastest, and the tilt swings on its own,
 * incommensurate period so no two passes look alike.
 */
export function rayState(seconds: number, width: number): RayState {
  const half = (width - 1) / 2;
  const sweep = Math.sin((2 * Math.PI * seconds) / SWEEP_PERIOD_S);
  const tilt = SKEW_MAX * Math.sin((2 * Math.PI * seconds) / SKEW_PERIOD_S + 1);
  return { centre: half + half * (1 + SWEEP_OVERSHOOT) * sweep, tilt };
}

/**
 * Brightness in [0,1] of border cell (x, y): a raised-cosine bump around a
 * slanted vertical line, so the top and bottom edges light together with the
 * bottom offset by the tilt, and the side borders glow as the ray reaches them.
 */
export function rayIntensity(x: number, y: number, width: number, height: number, ray: RayState, coverage = GLIMMER_COVERAGE): number {
  const halfWidth = (width * coverage) / 2;
  if (halfWidth <= 0) return 0;
  const line = ray.centre + ray.tilt * (y - (height - 1) / 2);
  const distance = Math.abs(x - line);
  if (distance >= halfWidth) return 0;
  return 0.5 * (1 + Math.cos((Math.PI * distance) / halfWidth));
}

/** The white base lit toward the accent by `intensity`. */
export function glimmerColor(intensity: number): string {
  return mixHex(palette.border, palette.accent, intensity);
}
