/**
 * Procedural lit dahlia for the empty conversation, drawn in shaded blocks.
 *
 * A bud unfolds, sways in changing wind, and occasionally folds and reopens.
 * Seeded events vary the timing and duration of each rest without erasing the
 * flower. Petals flutter independently, under a slowly drifting light.
 * Sampling at 2×4 sub-cell resolution smooths the silhouette; brightness
 * chooses both the block density and its blue-to-white colour.
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

export interface Phase {
  /** 0 = closed bud, 1 = fully open. */
  bloom: number;
  /** The flower stays present throughout its life. */
  presence: number;
}

/** Random-access lifecycle: no accumulated state, frame dependence or reset. */
export function phaseAt(t: number, seed = 0): Phase {
  if (t < 12) return { bloom: smooth((t - 1.6) / 8.4), presence: 1 };
  // Each event fits fully inside its window and meets the next at full bloom.
  // Every rest reaches a closed bud; only its timing varies. The first closure
  // finishes within 24 seconds, so it is visible during a short idle pause.
  const window = Math.floor((t - 12) / 32);
  const u = t - 12 - window * 32;
  const start = 2 + 4 * hash(window, 1, seed);
  const close = 4 + 2 * hash(window, 2, seed);
  const rest = 2 + 2 * hash(window, 3, seed);
  const reopen = 5 + 3 * hash(window, 4, seed);
  const fold = smooth((u - start) / close);
  const unfold = smooth((u - start - close - rest) / reopen);
  return { bloom: 1 - fold * (1 - unfold), presence: 1 };
}

/** Smooth gusts in [-1,1], layered at independent time scales. */
export function windLean(t: number, seed = 0): number {
  return 0.55 * Math.sin(t * 0.39 + seed + 0.4)
    + 0.27 * noise(t / 6, seed + 7) + 0.18 * noise(t / 2.3, seed + 19);
}

/** Unit direction towards the light (upper left, in front of the flower), drifting slowly. */
export function lightDirection(t: number, seed = 0): [number, number, number] {
  const x = -0.5 + 0.2 * Math.sin(t * 0.113 + 0.9 + seed);
  const y = -0.65 + 0.1 * noise(t / 17, seed + 31);
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

/** Continuous value noise; zero slope where intervals meet. */
function noise(t: number, seed: number): number {
  const i = Math.floor(t);
  return 2 * lerp(hash(i, 0, seed), hash(i + 1, 0, seed), smooth(t - i)) - 1;
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
  const height = Math.max(5, Math.min(40, availableHeight - 2, Math.floor((availableWidth - 4) / 2)));
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
function headBrightness(r: number, theta: number, ny: number, bloom: number, L: readonly [number, number, number], px: number, py: number, rings: readonly Ring[]): number {
  const rr = r / stretch(theta);
  const grain = 0.06 * (hash(px, py, 5) - 0.5);
  const dx = Math.cos(theta);
  const dy = Math.sin(theta);
  // Innermost ring on top: the first ring containing the pixel wins. A petal
  // seen through the gap between two petals of a ring above it is in shadow.
  let shadow = 0;
  for (const ring of rings) {
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

/** Shade the flower at 2×4 sub-cell resolution. */
export function renderPixels(t: number, width: number, height: number, seed = 0): PixelField {
  const { bloom } = phaseAt(t, seed);
  const px = width * 2;
  const py = height * 4;
  const data = new Float32Array(px * py).fill(-1);
  const L = lightDirection(t, seed);
  const rings = RINGS.map((ring, i) => ({
    ...ring,
    offset: ring.offset + bloom * 0.035 * noise(t / (3 + i * 0.7), seed + i + 41),
    length: ring.length * (1 - bloom * 0.025 * (1 + noise(t / (4 + i), seed + i + 53))),
  }));
  const cx = (px - 1) / 2;
  const ryUnit = (py - 1) / (DOWN_EXTENT + UP_EXTENT);
  const cy = UP_EXTENT * ryUnit;
  const rxUnit = Math.min(cx, ryUnit * 1.08);
  const scale = lerp(0.82, 1, bloom);
  const squeeze = lerp(0.8, 1, bloom);
  const lean = windLean(t, seed);
  const maxShear = Math.max(1, rxUnit * 0.14);

  for (let y = 0; y < py; y++) {
    // Lean grows with distance from the bottom of the head.
    const h = (py - 1 - y) / Math.max(1, py - 1);
    const shear = lean * maxShear * Math.pow(h, 1.4);
    for (let x = 0; x < px; x++) {
      const nx = (x - cx - shear) / (rxUnit * scale * squeeze);
      const ny = (y - cy) / (ryUnit * scale);
      const r = Math.hypot(nx, ny);
      if (r > DOWN_EXTENT + 0.05) continue;
      const angle = Math.atan2(ny, nx);
      // A travelling ripple bends neighbouring petal tips at different times.
      const theta = angle + 0.018 * bloom * Math.min(1, r) * Math.sin(angle * 5 - t * 0.8 + seed);
      const b = headBrightness(r, theta, ny, bloom, L, x, y, rings);
      if (b < 0) continue;
      data[y * px + x] = clamp01(b);
    }
  }
  return { px, py, data };
}

// ---------------------------------------------------------------------------
// Character and colour quantisation

/** Block shades with a sparse, faint step between the background and ░. */
export const GLYPH_RAMP = " ·░▒▓█";

export function brightnessGlyph(b: number): string {
  const v = clamp01(b);
  if (v < 0.025) return " ";
  if (v < 0.14) return "·";
  if (v < 0.28) return "░";
  if (v < 0.5) return "▒";
  if (v < 0.8) return "▓";
  return "█";
}

/** Brightness levels for colour runs; quantised so adjacent cells can merge. */
const LEVELS = 40;
const DARK = mixHex(flowerColors.body, palette.bg, 0.88);
/** Level at which the accent blue starts blending towards white (aligned to LEVELS). */
export const LIGHT_FROM = 28 / LEVELS;

/** Colour for a brightness: deep blue → accent blue → warm white. */
export function brightnessColor(b: number): string {
  const q = Math.round(clamp01(b) * LEVELS) / LEVELS;
  if (q >= LIGHT_FROM) return mixHex(flowerColors.body, flowerColors.light, (q - LIGHT_FROM) / (1 - LIGHT_FROM));
  return mixHex(DARK, flowerColors.body, smooth(q / LIGHT_FROM));
}

export function renderOrb(t: number, width: number, height: number, seed = 0): OrbFrame {
  const field = renderPixels(t, width, height, seed);
  const rows: OrbRun[][] = [];
  for (let cy = 0; cy < height; cy++) {
    const runs: OrbRun[] = [];
    let cur: OrbRun | null = null;
    for (let cx = 0; cx < width; cx++) {
      let sum = 0;
      let covered = 0;
      for (let dy = 0; dy < 4; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const x = cx * 2 + dx;
          const y = cy * 4 + dy;
          const b = field.data[y * field.px + x]!;
          if (b < 0) continue;
          sum += b;
          covered++;
        }
      }
      // Lift the lit surface, then apply coverage separately: boosting partial
      // coverage made the edges too bright and erased the fade to background.
      const brightness = covered === 0 ? 0 : Math.pow(sum / covered, 0.78) * covered / 8;
      const ch = brightnessGlyph(brightness);
      const color = ch === " " ? palette.bg : brightnessColor(brightness);
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

/** Two glyphs across and down per terminal cell: four times the detail. */
export const FLOWER_RESOLUTION = 2;
const GLYPH_WIDTH = 4;
const GLYPH_HEIGHT = 8;

export interface FlowerRaster {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Rasterise the block palette so terminal graphics can display smaller glyphs.
 * The faint shade uses 12.5% coverage, followed by 25/50/75/100% blocks.
 * Geometry is sampled on the denser grid before rasterising, not upscaled.
 */
export function renderFlowerRaster(t: number, width: number, height: number, seed = 0): FlowerRaster {
  return rasterizeFlower(renderOrb(t, width * FLOWER_RESOLUTION, height * FLOWER_RESOLUTION, seed));
}

export function rasterizeFlower(frame: OrbFrame): FlowerRaster {
  const width = frame.width * GLYPH_WIDTH;
  const height = frame.height * GLYPH_HEIGHT;
  const data = new Uint8Array(width * height * 4);
  const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const bg = rgb(palette.bg);
  const pattern = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  const coverage = [0, 2, 4, 8, 12, 16];
  frame.rows.forEach((runs, cy) => {
    let cx = 0;
    for (const run of runs) {
      const fg = rgb(run.color);
      for (const ch of run.text) {
        const level = coverage[GLYPH_RAMP.indexOf(ch)] ?? 0;
        for (let y = 0; y < GLYPH_HEIGHT; y++) {
          for (let x = 0; x < GLYPH_WIDTH; x++) {
            const color = pattern[(y % 4) * 4 + x % 4]! < level ? fg : bg;
            const i = ((cy * GLYPH_HEIGHT + y) * width + cx * GLYPH_WIDTH + x) * 4;
            data[i] = color[0]!;
            data[i + 1] = color[1]!;
            data[i + 2] = color[2]!;
            data[i + 3] = 255;
          }
        }
        cx++;
      }
    }
  });
  return { width, height, data };
}
