import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { testRender } from "@opentui/react/test-utils";
import { Orb } from "../src/ui/components/Orb.tsx";
import { LOOP_SECONDS, flowerColors, headRows, orbSize, orbToString, petalRadius, phaseAt, renderOrb, windLean } from "../src/ui/orb.ts";
import { palette } from "../src/ui/theme.ts";

const filledCells = (line: string) => line.replace(/ /g, "").length;
const lines = (t: number, w: number, h: number) => orbToString(renderOrb(t, w, h)).split("\n");
const inkCount = (rows: string[]) => rows.reduce((n, r) => n + filledCells(r), 0);

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

/** Bounding box of drawn cells in the head rows, ignoring rows that are only stem. */
function headBox(rows: string[], head: number): { w: number; h: number } {
  let x0 = Infinity;
  let x1 = -1;
  let y0 = Infinity;
  let y1 = -1;
  rows.slice(0, head).forEach((row, y) => {
    if (filledCells(row) <= 4) return;
    for (let x = 0; x < row.length; x++) {
      if (row[x] === " ") continue;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
  });
  return { w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

const BUD = 0.8;
const FULL = 12;

describe("flower sizing", () => {
  test("fits the available space with a 2:1 aspect and clamps small terminals", () => {
    const big = orbSize(120, 40);
    expect(big.height).toBe(24);
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
    expect(headRows(24)).toBeLessThan(24);
    expect(headRows(24)).toBeGreaterThanOrEqual(7);
  });
});

describe("flower loop", () => {
  test("cycles bud → bloom → hold → dissolve → dark → grow in, and is periodic", () => {
    expect(phaseAt(0)).toEqual({ bloom: 0, presence: 1 });
    expect(phaseAt(BUD).bloom).toBe(0);
    expect(phaseAt(5).bloom).toBeGreaterThan(0.1);
    expect(phaseAt(5).bloom).toBeLessThan(0.9);
    expect(phaseAt(FULL)).toEqual({ bloom: 1, presence: 1 });
    expect(phaseAt(15.4).presence).toBeGreaterThan(0.1);
    expect(phaseAt(15.4).presence).toBeLessThan(0.9);
    expect(phaseAt(16.7).presence).toBe(0);
    expect(phaseAt(17.5).presence).toBeGreaterThan(0.1);
    expect(phaseAt(17.5).presence).toBeLessThan(0.9);
    expect(phaseAt(17.5).bloom).toBe(0);
    expect(phaseAt(LOOP_SECONDS + 3)).toEqual(phaseAt(3));
    expect(orbToString(renderOrb(LOOP_SECONDS + 3, 49, 24))).toBe(orbToString(renderOrb(3, 49, 24)));
    // Bloom is monotonic while opening.
    let last = 0;
    for (let t = 0; t <= 10; t += 0.25) {
      expect(phaseAt(t).bloom).toBeGreaterThanOrEqual(last);
      last = phaseAt(t).bloom;
    }
  });

  test("the bud is small and the full bloom fills the head, with the stem fixed", () => {
    const h = 24;
    const head = headRows(h);
    const bud = headBox(lines(BUD, 49, h), head);
    const full = headBox(lines(FULL, 49, h), head);
    expect(bud.w).toBeLessThan(full.w * 0.45);
    expect(bud.h).toBeLessThan(full.h * 0.6);
    expect(full.w).toBeGreaterThanOrEqual(36);
    expect(full.h).toBeGreaterThanOrEqual(head - 3);
    // Stem rows are a narrow digit column at every stage.
    for (const t of [BUD, 5, FULL]) {
      const rows = lines(t, 49, h);
      for (const r of rows.slice(head + 1)) {
        expect(r.trim().length).toBeLessThanOrEqual(4);
        expect(r.trim().length).toBeGreaterThanOrEqual(2);
        expect(Math.abs(r.indexOf(r.trim()) - 23)).toBeLessThanOrEqual(3);
      }
    }
  });

  test("opens outer petals first and grows steadily, never jumping between frames", () => {
    const h = 24;
    const head = headRows(h);
    const inks = [2, 4, 6, 8, 10].map((t) => inkCount(lines(t, 49, h).slice(0, head)));
    for (let i = 1; i < inks.length; i++) expect(inks[i]!).toBeGreaterThan(inks[i - 1]! * 1.05);
    for (let t = 0; t < LOOP_SECONDS; t += 0.1) {
      expect(cellDelta(lines(t, 49, h), lines(t + 0.1, 49, h))).toBeLessThan(0.15);
    }
    // Full bloom breathes only through highlights and lean: silhouette stays put.
    const a = inkCount(lines(11, 49, h));
    const b = inkCount(lines(14, 49, h));
    expect(Math.max(a, b) / Math.min(a, b)).toBeLessThan(1.15);
  });

  test("dissolves into scattered glyphs and comes back", () => {
    const h = 24;
    const full = inkCount(lines(FULL, 49, h));
    const mid = inkCount(lines(15.4, 49, h));
    expect(mid).toBeGreaterThan(full * 0.2);
    expect(mid).toBeLessThan(full * 0.8);
    expect(inkCount(lines(16.7, 49, h))).toBe(0);
    expect(inkCount(lines(17.9, 49, h))).toBeGreaterThan(0);
  });
});

describe("flower frames", () => {
  test("frames are deterministic, exactly sized and drawn in exactly two colours", () => {
    const a = renderOrb(FULL, 49, 24);
    const b = renderOrb(FULL, 49, 24);
    expect(orbToString(a)).toBe(orbToString(b));
    expect(a.rows).toHaveLength(24);
    for (const row of a.rows) {
      const text = row.map((r) => r.text).join("");
      expect(text.length).toBe(49);
      for (const run of row) expect(run.text.length).toBeGreaterThan(0);
      for (let i = 1; i < row.length; i++) expect(row[i]!.color).not.toBe(row[i - 1]!.color); // runs are merged
    }
    const colours = new Set(a.rows.flat().map((r) => r.color));
    expect(colours).toEqual(new Set([palette.bg, flowerColors.body, flowerColors.light]));
    // Highlights are the minority: a lit rim, not a white flower.
    let light = 0;
    let body = 0;
    for (const run of a.rows.flat()) {
      const n = filledCells(run.text);
      if (run.color === flowerColors.light) light += n;
      else if (run.color === flowerColors.body) body += n;
    }
    expect(light).toBeGreaterThan(body * 0.05);
    expect(light).toBeLessThan(body * 0.5);
  });

  test("uses only digits and light punctuation: no block glyphs or letters", () => {
    for (const t of [BUD, 5, FULL, 15.4]) {
      const text = lines(t, 49, 24).join("\n");
      expect(text).toMatch(/^[0-9·: \n]+$/);
      expect(text).toMatch(/[0-9]/);
    }
  });

  test("has a floral silhouette: a wide jagged head above a thin stem, sparser at the edges", () => {
    const rows = lines(FULL, 49, 24);
    const head = headRows(24);
    const widths = rows.map(filledCells);
    const widest = widths.indexOf(Math.max(...widths));
    expect(widest).toBeLessThan(head);
    // Petal tips make the outline jut and dip against neighbouring rows.
    let jagged = 0;
    const w = widths.slice(0, head);
    for (let i = 1; i < w.length - 1; i++) if (Math.abs(w[i]! - (w[i - 1]! + w[i + 1]!) / 2) >= 2) jagged++;
    expect(jagged).toBeGreaterThanOrEqual(3);
    // Edges are airier than the middle: light glyphs cluster near the outline.
    const text = rows.slice(0, head).join("\n");
    expect(text).toMatch(/[·:]/);
    expect((text.match(/[·:]/g) ?? []).length).toBeLessThan((text.match(/[0-9]/g) ?? []).length);
  });

  test("petal extent is irregular and bounded, and closed petals hug the bud", () => {
    const open = Array.from({ length: 64 }, (_, i) => petalRadius((i / 64) * Math.PI * 2 - Math.PI, 1));
    expect(Math.min(...open)).toBeGreaterThan(0.2);
    expect(Math.max(...open)).toBeLessThanOrEqual(1.35);
    expect(Math.max(...open) - Math.min(...open)).toBeGreaterThan(0.3);
    const closed = Array.from({ length: 64 }, (_, i) => petalRadius((i / 64) * Math.PI * 2 - Math.PI, 0));
    expect(Math.max(...closed)).toBeLessThan(Math.max(...open) * 0.6);
  });

  test("sways slowly and the lean is bounded", () => {
    const leans = Array.from({ length: 200 }, (_, i) => windLean(i * 0.1));
    expect(Math.max(...leans)).toBeLessThanOrEqual(1);
    expect(Math.min(...leans)).toBeGreaterThanOrEqual(-1);
    expect(Math.max(...leans) - Math.min(...leans)).toBeGreaterThan(1);
    expect(windLean(LOOP_SECONDS + 1)).toBeCloseTo(windLean(1), 6);
  });

  test("small and narrow sizes still draw a compact bloom inside bounds", () => {
    for (const [w, h] of [
      [13, 6],
      [11, 5],
      [21, 10],
    ] as const) {
      const rows = lines(FULL, w, h);
      expect(rows).toHaveLength(h);
      for (const r of rows) expect(r.length).toBe(w);
      const filled = inkCount(rows);
      expect(filled).toBeGreaterThan(w * h * 0.15);
      expect(rows[0]!.trim().length).toBeLessThan(rows[Math.floor(h / 3)]!.trim().length);
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
      expect(frame).toMatch(/[0-9]{3,}/);
      expect(frame).not.toMatch(/[▒▓█▌░╿┃]/);
    } finally {
      setup.renderer.destroy();
    }
  });
});
