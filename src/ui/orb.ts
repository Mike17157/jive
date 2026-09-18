/**
 * Procedural lit dahlia for the empty conversation, drawn in Braille dots.
 *
 * Inspired by ASCII time-lapse footage: a tight bud unfolds ring by ring into
 * a full dahlia, holds, dissolves into scattered dots and grows again on a
 * fixed loop. The head is shaded by a directional light (diffuse + specular)
 * over a curved-petal surface, and rendered at 2×4 sub-cell resolution with
 * Braille glyphs: each dot is roughly square, brightness sets both how many
 * dots a cell shows (ordered dithering) and the cell colour, which runs from
 * deep blue through the accent blue into warm white for highlights. No block
 * glyphs, which render as solid tiles in many terminals.
 *
 * Pure: given a time and a size it returns rows of colour runs, so it is
 * deterministic, unit-testable and renderer-independent. The historical
 * `renderOrb` / `orbSize` / `orbToString` names are kept as the public API.
 */
import { mixHex, palette } from "./theme.ts";

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

/** The two hues the flower is drawn with; brightness shades between them. */
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

function wrapTime(t: number): number {
  return ((t % LOOP_SECONDS) + LOOP_SECONDS) % LOOP_SECONDS;
}

export interface Phase {
  /** 0 = closed bud, 1 = fully open. */
  bloom: number;
  /** 0 = nothing drawn, 1 = every dot drawn. */
  presence: number;
}

/** Bloom and presence for a time in seconds; periodic in LOOP_SECONDS. */
export function phaseAt(t: number): Phase {
  const u = wrapTime(t);
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

/** Unit direction towards the light (upper left, in front of the flower), drifting slowly. */
export function lightDirection(t: number): [number, number, number] {
  const w = (2 * Math.PI) / LOOP_SECONDS;
  const x = -0.5 + 0.2 * Math.sin(t * w * 2 + 0.9);
  const y = -0.65 + 0.1 * Math.sin(t * w + 2.3);
  const z = 0.6;
  const n = Math.hypot(x, y, z);
  return [x / n, y / n, z / n];
}

// ---------------------------------------------------------------------------
// Deterministic helpers

/** Hash-based value noise in [0,1); stable for a given pixel. */
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
  { count: 6, length: 0.34, offset: 0.2, tone: 0.62, start: 0.62 },
  { count: 9, length: 0.52, offset: 1.1, tone: 0.72, start: 0.46 },
  { count: 12, length: 0.7, offset: 0.5, tone: 0.82, start: 0.3 },
  { count: 15, length: 0.86, offset: 1.6, tone: 0.92, start: 0.15 },
  { count: 18, length: 1.0, offset: 0.9, tone: 1.0, start: 0 },
];
const OPEN_SPAN = 0.4;
const PETAL_BASE = 0.06;

/** Downward petals read longer than upward ones: a three-quarter view. */
function stretch(theta: number): number {
  return 1 + 0.2 * Math.sin(theta) - 0.05 * Math.cos(theta * 2);
}
const DOWN_EXTENT = 1.2;
const UP_EXTENT = 0.85;

export function ringOpen(ring: Ring, bloom: number): number {
  return smooth((bloom - ring.start) / OPEN_SPAN);
}

function ringLength(ring: Ring, open: number): number {
  return ring.length * lerp(0.42, 1, open);
}

/** Petal extent (0..1 of the head radius) at polar angle theta for a bloom state. */
export function petalRadius(theta: number, bloom: number): number {
  let best = coreRadius(bloom);
  for (const ring of RINGS) {
    const open = ringOpen(ring, bloom);
    const a = local(theta, ring, open);
    if (Math.abs(a) < halfWidth(ring.count, 0.5)) best = Math.max(best, ringLength(ring, open));
  }
  return best * stretch(theta);
}

function coreRadius(bloom: number): number {
  return lerp(0.46, 0.24, bloom);
}

function local(theta: number, ring: Ring, open: number): number {
  const twist = 0.22 * (1 - open);
  const period = (2 * Math.PI) / ring.count;
  const a = theta - ring.offset - twist;
  return ((((a + period / 2) % period) + period) % period) - period / 2;
}

function halfWidth(count: number, u: number): number {
  const shape = Math.sqrt(Math.max(0, 1 - Math.pow(u, 2.6)));
  return ((Math.PI / count) * 0.8) * shape;
}

// ---------------------------------------------------------------------------
// Sizing

/** Pick a flower size that fits, keeping a 2:1 character aspect for the head. */
export function orbSize(availableWidth: number, availableHeight: number): { width: number; height: number } {
  const height = Math.max(5, Math.min(28, availableHeight - 2, Math.floor((availableWidth - 4) / 2)));
  const width = height * 2 + 1;
  return { width, height };
}

export const flowerSize = orbSize;

// ---------------------------------------------------------------------------
// Shading

/** Lambert + Blinn-Phong for a normal; returns brightness in [0.16, 1.35]. */
function shade(nx: number, ny: number, nz: number, L: readonly [number, number, number]): number {
  const n = Math.hypot(nx, ny, nz) || 1;
  const x = nx / n;
  const y = ny / n;
  const z = nz / n;
  const diffuse = Math.max(0, x * L[0] + y * L[1] + z * L[2]);
  // Half vector between the light and the viewer (0,0,1).
  const hx = L[0];
  const hy = L[1];
  const hz = L[2] + 1;
  const hn = Math.hypot(hx, hy, hz);
  const spec = Math.pow(Math.max(0, (x * hx + y * hy + z * hz) / hn), 28);
  return 0.16 + 0.64 * diffuse + 0.55 * spec;
}

/** Lit brightness of the head at normalised polar coords, or -1 when outside. */
function headBrightness(r: number, theta: number, ny: number, bloom: number, L: readonly [number, number, number], px: number, py: number): number {
  const rr = r / stretch(theta);
  const grain = 0.06 * (hash(px, py, 5) - 0.5);
  const dx = Math.cos(theta);
  const dy = Math.sin(theta);
  // Innermost ring on top: the first ring containing the pixel wins. A petal
  // seen through the gap between two petals of a ring above it is in shadow.
  let shadow = 0;
  for (const ring of RINGS) {
    const open = ringOpen(ring, bloom);
    const len = ringLength(ring, open);
    if (rr < PETAL_BASE || rr > len) continue;
    const u = (rr - PETAL_BASE) / (len - PETAL_BASE);
    const a = local(theta, ring, open);
    const hw = halfWidth(ring.count, u);
    if (Math.abs(a) >= hw) {
      if (u < 0.85) shadow = 0.45;
      continue;
    }
    // A convex tubular petal: the surface normal tilts sideways towards the
    // edges and along the petal as it curls up at the tip.
    const lat = a / hw;
    const along = (u - 0.35) * lerp(0.2, 0.9, open);
    const nx = -dy * lat * 0.9 + dx * along;
    const nyv = dx * lat * 0.9 + dy * along;
    let b = shade(nx, nyv, 1, L) * ring.tone;
    // Petal bases sit under the ring above them.
    b *= 1 - 0.35 * (1 - u) * open;
    b *= 1 - shadow;
    return b + grain - 0.06 * ny;
  }
  const core = coreRadius(bloom);
  if (rr <= core) {
    // A tight sphere: wrapped spiral texture when closed, dense disc when open.
    const k = rr / core;
    const nz = Math.sqrt(Math.max(0, 1 - k * k));
    const spiral = 0.5 + 0.5 * Math.sin(theta * 3 + k * 9 - bloom * 2);
    const b = shade(dx * k, dy * k, nz, L) * lerp(0.9, 0.6, bloom);
    return b * (0.8 + 0.3 * spiral * (1 - 0.5 * bloom)) + grain;
  }
  return -1;
}

export interface PixelField {
  /** Pixel columns (2 per cell) and rows (4 per cell). */
  px: number;
  py: number;
  /** Brightness per pixel in [0,1], or -1 for empty; row-major. */
  data: Float32Array;
}

/** Shade the flower at Braille sub-cell resolution. */
export function renderPixels(t: number, width: number, height: number): PixelField {
  const { bloom, presence } = phaseAt(t);
  const px = width * 2;
  const py = height * 4;
  const data = new Float32Array(px * py).fill(-1);
  const L = lightDirection(t);
  const cx = (px - 1) / 2;
  const ryUnit = (py - 1) / (DOWN_EXTENT + UP_EXTENT);
  const cy = UP_EXTENT * ryUnit;
  const rxUnit = Math.min(cx, ryUnit * 1.08);
  const scale = lerp(0.82, 1, bloom);
  const squeeze = lerp(0.8, 1, bloom);
  const lean = windLean(t);
  const maxShear = Math.max(1, rxUnit * 0.14);
  const fade = presence >= 1 ? 0 : (1 - presence) * 0.3;

  for (let y = 0; y < py; y++) {
    // Lean grows with distance from the bottom of the head.
    const h = (py - 1 - y) / Math.max(1, py - 1);
    const shear = lean * maxShear * Math.pow(h, 1.4);
    for (let x = 0; x < px; x++) {
      if (presence < 1 && hash(x, y, 11) >= presence) continue;
      const nx = (x - cx - shear) / (rxUnit * scale * squeeze);
      const ny = (y - cy) / (ryUnit * scale);
      const r = Math.hypot(nx, ny);
      if (r > DOWN_EXTENT + 0.05) continue;
      const theta = Math.atan2(ny, nx);
      const b = headBrightness(r, theta, ny, bloom, L, x, y);
      if (b < 0) continue;
      data[y * px + x] = clamp01(b - fade);
    }
  }
  return { px, py, data };
}

// ---------------------------------------------------------------------------
// Braille quantisation

/** 4×4 Bayer matrix thresholds in [0,1) for ordered dithering. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
const DOT_BITS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
] as const;

/** Brightness levels for colour runs; quantised so adjacent cells can merge. */
const LEVELS = 14;
const DARK = mixHex(flowerColors.body, palette.bg, 0.62);
/** Level at which the accent blue starts blending towards white (aligned to LEVELS). */
export const LIGHT_FROM = 10 / LEVELS;

/** Colour for a brightness: deep blue → accent blue → warm white. */
export function brightnessColor(b: number): string {
  const q = Math.round(clamp01(b) * LEVELS) / LEVELS;
  if (q >= LIGHT_FROM) return mixHex(flowerColors.body, flowerColors.light, (q - LIGHT_FROM) / (1 - LIGHT_FROM));
  return mixHex(DARK, flowerColors.body, q / LIGHT_FROM);
}

/** Dot density for a brightness: always some dots inside the shape, all when bright. */
function density(b: number): number {
  return 0.3 + 0.7 * b;
}

export function renderOrb(t: number, width: number, height: number): OrbFrame {
  const field = renderPixels(t, width, height);
  const rows: OrbRun[][] = [];
  for (let cy = 0; cy < height; cy++) {
    const runs: OrbRun[] = [];
    let cur: OrbRun | null = null;
    for (let cx = 0; cx < width; cx++) {
      let bits = 0;
      let sum = 0;
      let n = 0;
      for (let dy = 0; dy < 4; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const x = cx * 2 + dx;
          const y = cy * 4 + dy;
          const b = field.data[y * field.px + x]!;
          if (b < 0) continue;
          sum += b;
          n++;
          if (density(b) > BAYER[(y & 3) * 4 + (x & 3)]!) bits |= DOT_BITS[dy]![dx]!;
        }
      }
      const ch = bits === 0 ? " " : String.fromCharCode(0x2800 + bits);
      const color = bits === 0 ? palette.bg : brightnessColor(sum / n);
      if (cur && cur.color === color) cur.text += ch;
      else {
        cur = { text: ch, color };
        runs.push(cur);
      }
    }
    rows.push(runs);
  }
  return { rows, width, height };
}

export const renderFlower = renderOrb;

/** Plain-text projection of a frame (for tests and logs). */
export function orbToString(frame: OrbFrame): string {
  return frame.rows.map((r) => r.map((run) => run.text).join("")).join("\n");
}

export const flowerToString = orbToString;

/** Number of raised dots in a Braille glyph (0 for anything else). */
export function dotCount(ch: string): number {
  const code = ch.charCodeAt(0) - 0x2800;
  if (code < 0 || code > 0xff) return 0;
  let n = 0;
  for (let b = code; b; b >>= 1) n += b & 1;
  return n;
}
