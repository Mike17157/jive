/**
 * Procedural ASCII flower for the empty conversation.
 *
 * A layered, irregular petal silhouette (two rings of spiky lobes with fixed
 * per-lobe lengths and widths) filled with terminal-native texture patches:
 * vertical stripes, stippled grids and dense block cores, with a sparse
 * speckled rim. The whole plant leans slowly in a gentle wind and breathes,
 * and a slender stem with a small leaf grows from the base when there is room.
 *
 * Pure: given a time and a size it returns rows of colour runs, so it is
 * deterministic, unit-testable and renderer-independent. The historical
 * `renderOrb` / `orbSize` / `orbToString` names are kept as the public API.
 */
import { gradientAt, palette } from "./theme.ts";

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

// ---------------------------------------------------------------------------
// Deterministic helpers

/** Hash-based value noise in [0,1); stable for a given cell. */
function hash(x: number, y: number, seed = 0): number {
  const s = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Smooth 1-D periodic wobble built from a few incommensurate sines, in [-1,1]. */
function wobble(t: number, phase: number): number {
  return 0.62 * Math.sin(t * 0.42 + phase) + 0.28 * Math.sin(t * 0.97 + phase * 2.1) + 0.1 * Math.sin(t * 1.9 + phase * 0.7);
}

/** Irregular petal ring: `count` spiky lobes with fixed lengths and widths. */
interface Ring {
  count: number;
  base: number;
  lengths: number[];
  widths: number[];
  rotation: number;
}

const OUTER: Ring = { count: 9, base: 0.5, lengths: [1, 0.72, 0.94, 0.6, 1, 0.66, 0.88, 0.56, 0.8], widths: [2.4, 1.6, 3.2, 1.4, 2.8, 1.8, 3.6, 1.5, 2.2], rotation: 0.35 };
const INNER: Ring = { count: 6, base: 0.6, lengths: [0.92, 0.66, 0.98, 0.62, 0.8, 0.9], widths: [1.6, 1.2, 2.4, 1.3, 2, 1.5], rotation: 1.15 };

function ringRadius(ring: Ring, theta: number): number {
  const a = theta - ring.rotation;
  const k = ring.count;
  const lobe = Math.floor(((a / (2 * Math.PI)) * k + 0.5 + k * 4) % k);
  const len = ring.lengths[lobe]!;
  const width = ring.widths[lobe]!;
  const spike = Math.pow(Math.abs(Math.cos((k * a) / 2)), width);
  return ring.base + (1 - ring.base) * len * spike;
}

/** Silhouette radius (0..1) at polar angle theta for time t; layered rings and a little jaggedness. */
export function petalRadius(theta: number, t: number): number {
  const outer = ringRadius(OUTER, theta + 0.05 * wobble(t, 0.3));
  const inner = ringRadius(INNER, theta - 0.04 * wobble(t, 2.1)) * 0.86;
  const jag = 0.035 * Math.sin(theta * 23 + 1.3) + 0.025 * Math.sin(theta * 41 + 0.4);
  const breath = 1 + 0.025 * Math.sin(t * 0.31);
  return Math.max(outer, inner) * breath + jag;
}

/** Wind lean in [-1,1]: slow gusts, no fast oscillation. */
export function windLean(t: number): number {
  return 0.75 * Math.sin(t * 0.33) + 0.25 * Math.sin(t * 0.81 + 1.7);
}

// ---------------------------------------------------------------------------
// Sizing

/** Pick a flower size that fits, keeping a 2:1 character aspect for the head. */
export function orbSize(availableWidth: number, availableHeight: number): { width: number; height: number } {
  const height = Math.max(5, Math.min(18, availableHeight - 2, Math.floor((availableWidth - 4) / 2)));
  const width = height * 2 + 1;
  return { width, height };
}

export const flowerSize = orbSize;

/** Rows given to the flower head; the remainder is stem. */
export function headRows(height: number): number {
  if (height < 9) return height;
  return Math.max(7, Math.round(height * 0.72));
}

// ---------------------------------------------------------------------------
// Rendering

interface Cell {
  ch: string;
  color: string;
}

const STRIPES = ["▌", "│"];
const GRID = ["░", "▒"];
const CORE = ["▓", "█"];
const RIM = ["×", "·", "·", ":"];

function textureCell(nx: number, ny: number, d: number, x: number, y: number, layerInner: boolean): Cell {
  // Coarse patches decide the texture family so regions read as stripes, grids and blocks.
  const patch = hash(Math.floor(x / 5), Math.floor(y / 3), 7);
  const fine = hash(x, y, 3);
  let ch: string;
  let tone: number;
  if (d > 0.9) {
    ch = RIM[Math.floor(fine * RIM.length)]!;
    tone = 0.12;
  } else if (d < 0.26) {
    ch = fine > 0.3 ? CORE[1]! : CORE[0]!;
    tone = 0.92;
  } else if (patch < 0.42 || layerInner) {
    ch = STRIPES[x & 1]!;
    tone = 0.62 - d * 0.35;
  } else if (patch < 0.8) {
    ch = GRID[(x + y) & 1]!;
    tone = 0.5 - d * 0.3;
  } else {
    ch = fine > 0.5 ? CORE[0]! : GRID[1]!;
    tone = 0.75 - d * 0.35;
  }
  // Light from above-left, gently.
  tone += -0.08 * ny - 0.04 * nx;
  return { ch, color: gradientAt(Math.max(0.05, Math.min(0.95, tone))) };
}

export function renderOrb(t: number, width: number, height: number): OrbFrame {
  const head = headRows(height);
  const stemRows = height - head;
  const cx = (width - 1) / 2;
  const cy = (head - 1) / 2;
  const ry = Math.max(1, cy);
  const rx = Math.max(1, Math.min(cx, ry * 1.85));
  const lean = windLean(t);
  const maxShear = Math.max(1, rx * 0.24);
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

  // Flower head.
  for (let y = 0; y < head; y++) {
    const shear = shearAt(y);
    for (let x = 0; x < width; x++) {
      const nx = (x - cx - shear) / rx;
      const ny = (y - cy) / ry;
      const r = Math.hypot(nx, ny);
      if (r > 1.05) continue;
      const theta = Math.atan2(ny, nx);
      const R = petalRadius(theta, t);
      if (r > R) continue;
      const d = r / R;
      const innerOnly = ringRadius(OUTER, theta + 0.05 * wobble(t, 0.3)) < r && r < R;
      grid[y]![x] = textureCell(nx, ny, d, x, y, innerOnly);
    }
  }

  // Stem and leaf, starting right under the lowest petal near the axis.
  if (stemRows > 0) {
    let stemStart = head;
    for (let y = head - 1; y >= Math.floor(cy); y--) {
      const sx = Math.round(cx + shearAt(y));
      const filled = [sx - 1, sx, sx + 1].some((x) => x >= 0 && x < width && grid[y]![x]!.ch !== " ");
      if (filled) {
        stemStart = y + 1;
        break;
      }
      stemStart = y;
    }
    const leafRow = stemStart + Math.floor((height - stemStart) / 2);
    for (let y = stemStart; y < height; y++) {
      const sx = Math.round(cx + shearAt(y));
      if (sx >= 0 && sx < width) grid[y]![sx] = { ch: y === stemStart ? "╿" : "┃", color: gradientAt(0.22) };
      if (height - stemStart >= 3 && (y === leafRow || y === leafRow - 1)) {
        const off = y === leafRow ? 1 : 2;
        const lx = sx + off;
        if (lx < width) grid[y]![lx] = { ch: "╱", color: gradientAt(0.38) };
      }
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
