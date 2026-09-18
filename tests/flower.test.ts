import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { testRender } from "@opentui/react/test-utils";
import { Orb } from "../src/ui/components/Orb.tsx";
import { headRows, orbSize, orbToString, petalRadius, renderOrb, windLean } from "../src/ui/orb.ts";
import { gradientStops, palette } from "../src/ui/theme.ts";

const filledCells = (line: string) => line.replace(/ /g, "").length;
const lines = (t: number, w: number, h: number) => orbToString(renderOrb(t, w, h)).split("\n");

/** Fraction of character cells that differ between two frames of equal size. */
function cellDelta(a: string[], b: string[]): number {
  let diff = 0;
  let total = 0;
  a.forEach((row, i) => {
    for (let x = 0; x < row.length; x++) {
      total++;
      if (row[x] !== b[i]![x]) diff++;
    }
  });
  return diff / total;
}

function centroidX(rows: string[]): number {
  let sum = 0;
  let n = 0;
  for (const row of rows) {
    for (let x = 0; x < row.length; x++) {
      if (row[x] !== " ") {
        sum += x;
        n++;
      }
    }
  }
  return n === 0 ? 0 : sum / n;
}

describe("flower sizing", () => {
  test("fits the available space with a 2:1 head aspect and clamps small terminals", () => {
    const big = orbSize(120, 40);
    expect(big.height).toBe(18);
    expect(big.width).toBe(big.height * 2 + 1);
    const short = orbSize(80, 9);
    expect(short.height).toBe(7);
    expect(short.width).toBe(15);
    const narrow = orbSize(20, 30);
    expect(narrow.width).toBeLessThanOrEqual(20);
    expect(narrow.height).toBe(Math.floor((narrow.width - 1) / 2));
    const tiny = orbSize(8, 3);
    expect(tiny.height).toBe(5); // floor, still renders
    expect(headRows(6)).toBe(6); // too short for a stem
    expect(headRows(16)).toBeLessThan(16);
    expect(headRows(16)).toBeGreaterThanOrEqual(7);
  });
});

describe("flower frames", () => {
  test("frames are deterministic for a fixed time and exactly sized", () => {
    const a = renderOrb(2.5, 33, 16);
    const b = renderOrb(2.5, 33, 16);
    expect(orbToString(a)).toBe(orbToString(b));
    expect(a.rows).toHaveLength(16);
    for (const row of a.rows) {
      const text = row.map((r) => r.text).join("");
      expect(text.length).toBe(33);
      for (const run of row) expect(run.text.length).toBeGreaterThan(0);
      for (let i = 1; i < row.length; i++) expect(row[i]!.color).not.toBe(row[i - 1]!.color); // runs are merged
    }
    // Every colour is the background or a stop on the theme gradient.
    const colours = new Set(a.rows.flat().map((r) => r.color));
    expect(colours.size).toBeGreaterThan(4);
    expect(colours.has(palette.bg)).toBe(true);
    for (const c of colours) if (c !== palette.bg) expect(/^#[0-9a-f]{6}$/.test(c)).toBe(true);
    expect(gradientStops.length).toBeGreaterThan(1);
  });

  test("has a visibly floral silhouette: bloom on top, stem below, irregular petals", () => {
    const rows = lines(0, 33, 16);
    const head = headRows(16);
    const widths = rows.map(filledCells);
    // Bloom: the widest rows sit in the head, and the head is much wider than the stem.
    const widest = widths.indexOf(Math.max(...widths));
    expect(widest).toBeLessThan(head);
    expect(Math.max(...widths)).toBeGreaterThanOrEqual(18);
    // Stem: a single thin line of stem glyphs on the bottom rows, roughly centred.
    const stemRows = rows.slice(head + 1);
    expect(stemRows.length).toBeGreaterThan(0);
    for (const r of stemRows) {
      expect(r.replace(/[ ╱]/g, "")).toMatch(/^[┃╿]$/);
      expect(Math.abs(r.indexOf("┃") - 16)).toBeLessThanOrEqual(3);
    }
    expect(rows.some((r) => r.includes("╱"))).toBe(true); // leaf
    // The head is not a smooth disc: several rows jut out or dip by 2+ cells
    // against their neighbours (petal spikes), at every sampled time.
    for (const t of [0, 2, 4.8, 9]) {
      const w = lines(t, 33, 16).slice(0, head).map(filledCells);
      let jagged = 0;
      for (let i = 1; i < w.length - 1; i++) if (Math.abs(w[i]! - (w[i - 1]! + w[i + 1]!) / 2) >= 2) jagged++;
      expect(jagged).toBeGreaterThanOrEqual(2);
    }
    // Texture: stripes, stipple, block core and a speckled rim all present.
    const text = rows.join("\n");
    expect(text).toMatch(/[▌│]/);
    expect(text).toMatch(/[░▒]/);
    expect(text).toMatch(/[▓█]/);
    expect(text).toMatch(/[×·:]/);
    // Nothing is drawn as text beneath the art.
    expect(text).not.toMatch(/[a-zA-Z]/);
  });

  test("petal radius is layered and irregular but bounded", () => {
    const samples = Array.from({ length: 64 }, (_, i) => petalRadius((i / 64) * Math.PI * 2 - Math.PI, 0));
    expect(Math.min(...samples)).toBeGreaterThan(0.35);
    expect(Math.max(...samples)).toBeLessThanOrEqual(1.1);
    expect(Math.max(...samples) - Math.min(...samples)).toBeGreaterThan(0.3);
    let peaks = 0;
    for (let i = 0; i < samples.length; i++) {
      const prev = samples[(i + samples.length - 1) % samples.length]!;
      const next = samples[(i + 1) % samples.length]!;
      if (samples[i]! > prev && samples[i]! > next) peaks++;
    }
    expect(peaks).toBeGreaterThanOrEqual(6); // several distinct petals
  });

  test("sways slowly: tiny change per frame, clear lean over seconds, never brisk", () => {
    const base = lines(0, 33, 16);
    expect(cellDelta(base, lines(0.12, 33, 16))).toBeLessThan(0.06); // one frame later
    expect(cellDelta(base, lines(4.8, 33, 16))).toBeGreaterThan(0.03); // a gust later
    for (let t = 0; t < 12; t += 0.12) {
      expect(cellDelta(lines(t, 33, 16), lines(t + 0.12, 33, 16))).toBeLessThan(0.08);
    }
    // Lean: the bloom's centre of mass drifts sideways over time while the base stays put.
    const centroids = [0, 2, 4, 6, 8, 10, 12].map((t) => centroidX(lines(t, 33, 16).slice(0, headRows(16))));
    expect(Math.max(...centroids) - Math.min(...centroids)).toBeGreaterThanOrEqual(1);
    const leans = Array.from({ length: 200 }, (_, i) => windLean(i * 0.1));
    expect(Math.max(...leans)).toBeLessThanOrEqual(1);
    expect(Math.min(...leans)).toBeGreaterThanOrEqual(-1);
    // Breathing keeps the head size within a narrow band (no pulsing).
    const sizes = [0, 3, 6, 9, 12].map((t) => lines(t, 33, 16).slice(0, headRows(16)).reduce((n, r) => n + filledCells(r), 0));
    expect(Math.max(...sizes) / Math.min(...sizes)).toBeLessThan(1.25);
  });

  test("small and narrow sizes still draw a compact bloom inside bounds", () => {
    for (const [w, h] of [
      [13, 6],
      [11, 5],
      [21, 10],
    ] as const) {
      const rows = lines(1, w, h);
      expect(rows).toHaveLength(h);
      for (const r of rows) expect(r.length).toBe(w);
      const filled = rows.reduce((n, r) => n + filledCells(r), 0);
      expect(filled).toBeGreaterThan(w * h * 0.15);
      expect(rows[0]!.trim().length).toBeLessThan(rows[Math.floor(h / 2)]!.trim().length);
    }
  });
});

describe("Orb component", () => {
  test("renders the flower only, with no captions", async () => {
    const setup = await testRender(createElement(Orb, { width: 60, height: 20, animate: false }), { width: 60, height: 20, exitOnCtrlC: false });
    try {
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).not.toMatch(/[a-zA-Z]/);
      expect(frame).toMatch(/[░▒▓█]/);
      expect(frame).toContain("┃");
    } finally {
      setup.renderer.destroy();
    }
  });
});
