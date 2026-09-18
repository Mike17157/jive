/**
 * Procedural digit-drawn dahlia for the empty conversation.
 *
 * Inspired by ASCII time-lapse footage: a tight bud on a thick stem unfolds
 * ring by ring into a full dahlia, holds, dissolves into scattered glyphs and
 * grows again, on a fixed loop. Every cell is a plain digit or punctuation
 * mark (no block-drawing characters, which render as solid tiles in many
 * terminals), so shading comes from glyph density and exactly two foreground
 * colours: a blue body and warm-white highlights.
 *
 * Pure: given a time and a size it returns rows of colour runs, so it is
 * deterministic, unit-testable and renderer-independent. The historical
 * `renderOrb` / `orbSize` / `orbToString` names are kept as the public API.
 */
import { palette } from "./theme.ts";

export interface OrbRun {
  text: string;
  color: string;
}

export interface OrbFrame {
  rows: OrbRun[][];
  width: number;
  height: number;
}

export type FlowerFrame = OrbFrame;
export type FlowerRun = OrbRun;

/** The two colours the flower is drawn with. */
export const flowerColors = { body: palette.accent, light: palette.text } as const;

// ---------------------------------------------------------------------------
// Timing

/** Seconds per loop: bud, bloom, hold, dissolve, dark, grow back in. */
export const LOOP_SECONDS = 18;

const PHASES = {
  bud: [0, 1.6],
  bloom: [1.6, 10],
  hold: [10, 14.4],
  dissolve: [14.4, 16.4],
  dark: [16.4, 17],
  growIn: [17, 18],
} as const;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smooth(v: number): number {
  const k = clamp01(v);
  return k * k * (3 - 2 * k);
}

function lerp(a: number, b: number, k: number): number {
  return a + (b - a) * k;
}

function span(t: number, [a, b]: readonly [number, number]): number {
  return clamp01((t - a) / (b - a));
}

export interface Phase {
  /** 0 = closed bud, 1 = fully open. */
  bloom: number;
  /** 0 = nothing drawn, 1 = every cell drawn. */
  presence: number;
}

/** Bloom and presence for a time in seconds; periodic in LOOP_SECONDS. */
export function phaseAt(t: number): Phase {
  const u = ((t % LOOP_SECONDS) + LOOP_SECONDS) % LOOP_SECONDS;
  const bloom = u >= PHASES.dark[0] ? 0 : smooth(span(u, PHASES.bloom));
  let presence = 1;
  if (u >= PHASES.growIn[0]) presence = span(u, PHASES.growIn);
  else if (u >= PHASES.dark[0]) presence = 0;
  else if (u >= PHASES.dissolve[0]) presence = 1 - span(u, PHASES.dissolve);
  return { bloom, presence };
}

/** Wind lean in [-1,1]; slow, gust-like and periodic in the loop. */
export function windLean(t: number): number {
  const w = (2 * Math.PI) / LOOP_SECONDS;
  return 0.7 * Math.sin(t * w + 0.4) + 0.3 * Math.sin(t * w * 3 + 1.7);
}

// ---------------------------------------------------------------------------
// Deterministic helpers

/** Hash-based value noise in [0,1); stable for a given cell. */
function hash(x: number, y: number, seed = 0): number {
  const s = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

// ---------------------------------------------------------------------------
// Geometry

/**
 * Petal rings, innermost first. Lengths are fractions of the head radius; the
 * outer ring opens first and the centre last, like a dahlia time-lapse.
 */
interface Ring {
  count: number;
  length: number;
  offset: number;
  tone: number;
  start: number;
}

const RINGS: readonly Ring[] = [
  { count: 5, length: 0.36, offset: 0.2, tone: 0.0, start: 0.62 },
  { count: 8, length: 0.55, offset: 1.1, tone: 0.02, start: 0.46 },
  { count: 11, length: 0.72, offset: 0.5, tone: 0.04, start: 0.3 },
  { count: 13, length: 0.87, offset: 1.6, tone: 0.06, start: 0.15 },
  { count: 16, length: 1.0, offset: 0.9, tone: 0.08, start: 0 },
];
const OPEN_SPAN = 0.4;
const PETAL_BASE = 0.08;

/** Downward petals read longer than upward ones: a three-quarter view. */
function stretch(theta: number): number {
  return 1 + 0.26 * Math.sin(theta) - 0.06 * Math.cos(theta * 2);
}
const DOWN_EXTENT = 1.26;
const UP_EXTENT = 0.8;

export function ringOpen(ring: Ring, bloom: number): number {
  return smooth((bloom - ring.start) / OPEN_SPAN);
}

/** Petal extent (0..1 of the head radius) at polar angle theta for a bloom state. */
export function petalRadius(theta: number, bloom: number): number {
  let best = coreRadius(bloom);
  for (const ring of RINGS) {
    const open = ringOpen(ring, bloom);
    const len = ring.length * lerp(0.44, 1, open);
    const n = ring.count;
    const a = local(theta, ring, open);
    const hw = halfWidth(n, 0.5);
    if (Math.abs(a) < hw) best = Math.max(best, len);
  }
  return best * stretch(theta);
}

function coreRadius(bloom: number): number {
  return lerp(0.5, 0.27, bloom);
}

function local(theta: number, ring: Ring, open: number): number {
  const twist = 0.22 * (1 - open);
  const period = (2 * Math.PI) / ring.count;
  const a = theta - ring.offset - twist;
  return ((((a + period / 2) % period) + period) % period) - period / 2;
}

function halfWidth(count: number, u: number): number {
  const shape = Math.sqrt(Math.max(0, 1 - Math.pow(u, 2.4)));
  return ((Math.PI / count) * 0.76) * shape;
}

// ---------------------------------------------------------------------------
// Sizing

/** Pick a flower size that fits, keeping a 2:1 character aspect for the head. */
export function orbSize(availableWidth: number, availableHeight: number): { width: number; height: number } {
  const height = Math.max(5, Math.min(24, availableHeight - 2, Math.floor((availableWidth - 4) / 2)));
  const width = height * 2 + 1;
  return { width, height };
}

export const flowerSize = orbSize;

/** Rows given to the flower head; the remainder is stem. */
export function headRows(height: number): number {
  if (height < 9) return height;
  return Math.max(7, Math.round(height * 0.7));
}

// ---------------------------------------------------------------------------
// Rendering

interface Cell {
  ch: string;
  color: string;
}

/** Glyph density ramps, sparse to dense, for each colour. */
const BODY_RAMP = [" ", "·", ":", "1", "7", "3", "4", "5", "9", "0", "8"];
const LIGHT_RAMP = ["7", "3", "5", "9", "0", "8"];
const LIGHT_FROM = 0.78;

function glyph(brightness: number): Cell {
  const b = clamp01(brightness);
  if (b >= LIGHT_FROM) {
    const i = Math.min(LIGHT_RAMP.length - 1, Math.floor(((b - LIGHT_FROM) / (1 - LIGHT_FROM)) * LIGHT_RAMP.length));
    return { ch: LIGHT_RAMP[i]!, color: flowerColors.light };
  }
  const i = Math.min(BODY_RAMP.length - 1, Math.floor((b / LIGHT_FROM) * BODY_RAMP.length));
  return { ch: BODY_RAMP[i]!, color: flowerColors.body };
}

/** Brightness of the head at normalised polar coords, or -1 when outside. */
function headBrightness(r: number, theta: number, ny: number, bloom: number, x: number, y: number): number {
  const rr = r / stretch(theta);
  const light = -0.1 * ny;
  const grain = 0.12 * (hash(x, y, 5) - 0.5);
  // Innermost ring on top: the first ring containing the cell wins. A petal
  // seen through the gap between two petals of a ring above it is in shadow.
  let shadow = 0;
  for (const ring of RINGS) {
    const open = ringOpen(ring, bloom);
    const len = ring.length * lerp(0.44, 1, open);
    if (rr < PETAL_BASE || rr > len) continue;
    const u = (rr - PETAL_BASE) / (len - PETAL_BASE);
    const a = local(theta, ring, open);
    const hw = halfWidth(ring.count, u);
    if (Math.abs(a) >= hw) {
      if (u < 0.85) shadow = 0.4;
      continue;
    }
    const ridge = 1 - Math.pow(Math.abs(a) / hw, 1.4);
    const b = ring.tone + 0.72 * ridge * lerp(0.6, 1, open) + 0.16 * u * open + light;
    return b * (1 - shadow) + grain;
  }
  const core = coreRadius(bloom);
  if (rr <= core) {
    // Tight centre: a wrapped spiral when closed, a dense dark disc when open.
    const spiral = 0.5 + 0.5 * Math.sin(theta * 3 + rr * 14 - bloom * 2);
    const k = rr / core;
    return 0.14 + 0.3 * spiral * (1 - 0.5 * bloom) + 0.2 * (1 - k) * bloom + light + grain;
  }
  return -1;
}

export function renderOrb(t: number, width: number, height: number): OrbFrame {
  const { bloom, presence } = phaseAt(t);
  const head = headRows(height);
  const stemRows = height - head;
  const cx = (width - 1) / 2;
  const ryUnit = (head - 1) / (DOWN_EXTENT + UP_EXTENT);
  const cy = UP_EXTENT * ryUnit;
  const rxUnit = Math.min(cx, ryUnit * 2.5);
  const scale = lerp(0.8, 1, bloom);
  const squeeze = lerp(0.72, 1, bloom);
  const lean = windLean(t);
  const maxShear = Math.max(1, rxUnit * 0.18);
  // Lean grows with distance from the base of the stem (bottom row).
  const shearAt = (y: number) => {
    const h = (height - 1 - y) / Math.max(1, height - 1);
    return lean * maxShear * Math.pow(h, 1.4);
  };

  const grid: Cell[][] = [];
  for (let y = 0; y < height; y++) {
    const row: Cell[] = [];
    for (let x = 0; x < width; x++) row.push({ ch: " ", color: palette.bg });
    grid.push(row);
  }

  const visible = (x: number, y: number) => presence >= 1 || hash(x, y, 11) < presence;
  const fade = presence >= 1 ? 0 : (1 - presence) * 0.25;
  // A few cells at a time catch the light, like digits flickering in footage.
  const tick = 13 + Math.floor((((t % LOOP_SECONDS) + LOOP_SECONDS) % LOOP_SECONDS) * 2);
  const sparkle = (x: number, y: number) => (hash(x, y, tick) < 0.04 ? 0.3 : 0);

  // Stem: a column of digits from the head centre to the bottom, drawn first so
  // petals overlap it.
  if (stemRows > 0) {
    const stemWidth = width >= 31 ? 3 : width >= 19 ? 2 : 1;
    for (let y = Math.floor(cy); y < height; y++) {
      const sx = Math.round(cx + shearAt(y) - (stemWidth - 1) / 2);
      for (let i = 0; i < stemWidth; i++) {
        const x = sx + i;
        if (x < 0 || x >= width || !visible(x, y)) continue;
        const across = stemWidth === 1 ? 0.5 : i / (stemWidth - 1);
        const b = 0.56 - 0.3 * across + 0.12 * (hash(x, y, 9) - 0.5) - fade;
        grid[y]![x] = glyph(b);
      }
    }
  }

  // Flower head.
  const lo = Math.max(0, Math.floor(cy - UP_EXTENT * ryUnit * scale) - 1);
  const hi = Math.min(height - 1, Math.ceil(cy + DOWN_EXTENT * ryUnit * scale) + 1);
  for (let y = lo; y <= hi; y++) {
    const shear = shearAt(y);
    for (let x = 0; x < width; x++) {
      if (!visible(x, y)) continue;
      const nx = (x - cx - shear) / (rxUnit * scale * squeeze);
      const ny = (y - cy) / (ryUnit * scale);
      const r = Math.hypot(nx, ny);
      if (r > DOWN_EXTENT + 0.05) continue;
      const theta = Math.atan2(ny, nx);
      const b = headBrightness(r, theta, ny, bloom, x, y);
      if (b < 0) continue;
      grid[y]![x] = glyph(b - fade + sparkle(x, y));
    }
  }

  // Compress to colour runs.
  const rows: OrbRun[][] = grid.map((cells) => {
    const runs: OrbRun[] = [];
    let cur: OrbRun | null = null;
    for (const c of cells) {
      if (cur && cur.color === c.color) cur.text += c.ch;
      else {
        cur = { text: c.ch, color: c.color };
        runs.push(cur);
      }
    }
    return runs;
  });
  return { rows, width, height };
}

export const renderFlower = renderOrb;

/** Plain-text projection of a frame (for tests and logs). */
export function orbToString(frame: OrbFrame): string {
  return frame.rows.map((r) => r.map((run) => run.text).join("")).join("\n");
}

export const flowerToString = orbToString;
