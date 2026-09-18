import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { testRender } from "@opentui/react/test-utils";
import { Orb } from "../src/ui/components/Orb.tsx";
import {
  LIGHT_FROM,
  LOOP_SECONDS,
  brightnessColor,
  dotCount,
  flowerColors,
  lightDirection,
  orbSize,
  orbToString,
  petalRadius,
  phaseAt,
  renderOrb,
  renderPixels,
  windLean,
} from "../src/ui/orb.ts";
import { palette } from "../src/ui/theme.ts";

const lines = (t: number, w: number, h: number) => orbToString(renderOrb(t, w, h)).split("\n");
const rowDots = (line: string) => [...line].reduce((n, c) => n + dotCount(c), 0);
const inkCount = (rows: string[]) => rows.reduce((n, r) => n + rowDots(r), 0);

/** Fraction of character cells that differ between two frames of equal size. */
function cellDelta(a: string[], b: string[]): number {
  let diff = 0;
  let total = 0;
  a.forEach((row, i) => {
    const ra = [...row];
    const rb = [...b[i]!];
    for (let x = 0; x < ra.length; x++) {
      total++;
      if (ra[x] !== rb[x]) diff++;
    }
  });
  return diff / total;
}

/** Bounding box of drawn cells. */
function box(rows: string[]): { w: number; h: number } {
  let x0 = Infinity;
  let x1 = -1;
  let y0 = Infinity;
  let y1 = -1;
  rows.forEach((row, y) => {
    [...row].forEach((c, x) => {
      if (c === " ") return;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    });
  });
  return { w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Mean brightness of drawn pixels inside a quadrant of the field. */
function quadrantMean(t: number, w: number, h: number, right: boolean, bottom: boolean): number {
  const f = renderPixels(t, w, h);
  let sum = 0;
  let n = 0;
  for (let y = 0; y < f.py; y++) {
    if (y >= f.py / 2 !== bottom) continue;
    for (let x = 0; x < f.px; x++) {
      if (x >= f.px / 2 !== right) continue;
      const b = f.data[y * f.px + x]!;
      if (b < 0) continue;
      sum += b;
      n++;
    }
  }
  return n === 0 ? 0 : sum / n;
}

const BUD = 0.8;
const FULL = 12;
const W = 57;
const H = 28;

describe("flower sizing", () => {
  test("fits the available space with a 2:1 aspect and clamps small terminals", () => {
    const big = orbSize(120, 40);
    expect(big.height).toBe(28);
    expect(big.width).toBe(big.height * 2 + 1);
    const short = orbSize(80, 9);
    expect(short.height).toBe(7);
    expect(short.width).toBe(15);
    const narrow = orbSize(20, 30);
    expect(narrow.width).toBeLessThanOrEqual(20);
    expect(narrow.height).toBe(Math.floor((narrow.width - 1) / 2));
    const tiny = orbSize(8, 3);
    expect(tiny.height).toBe(5); // floor, still renders
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
    expect(orbToString(renderOrb(LOOP_SECONDS + 3, W, H))).toBe(orbToString(renderOrb(3, W, H)));
    let last = 0;
    for (let t = 0; t <= 10; t += 0.25) {
      expect(phaseAt(t).bloom).toBeGreaterThanOrEqual(last);
      last = phaseAt(t).bloom;
    }
  });

  test("the bud is small and the full bloom fills the box, with no stem", () => {
    const bud = box(lines(BUD, W, H));
    const full = box(lines(FULL, W, H));
    expect(bud.w).toBeLessThan(full.w * 0.45);
    expect(bud.h).toBeLessThan(full.h * 0.5);
    expect(full.w).toBeGreaterThanOrEqual(W - 8);
    expect(full.h).toBeGreaterThanOrEqual(H - 2);
    // Nothing narrow hangs below the head at any stage: the lowest drawn rows
    // are petal tips, not a column.
    for (const t of [BUD, 5, FULL]) {
      const rows = lines(t, W, H);
      const widths = rows.map((r) => r.trim().length).filter((w) => w > 0);
      const bottom = widths.slice(-4);
      expect(bottom.reduce((a, b) => a + b, 0) / bottom.length).toBeGreaterThanOrEqual(5);
      expect(widths.slice(-8).filter((w) => w <= 3).length).toBeLessThanOrEqual(2);
    }
  });

  test("opens steadily and never jumps between frames", () => {
    const inks = [2, 4, 6, 8, 10].map((t) => inkCount(lines(t, W, H)));
    for (let i = 1; i < inks.length; i++) expect(inks[i]!).toBeGreaterThan(inks[i - 1]! * 1.05);
    for (let t = 0; t < LOOP_SECONDS; t += 0.1) {
      expect(cellDelta(lines(t, W, H), lines(t + 0.1, W, H))).toBeLessThan(0.2);
    }
    // Holding: the silhouette stays put while light and lean drift.
    const a = inkCount(lines(11, W, H));
    const b = inkCount(lines(14, W, H));
    expect(Math.max(a, b) / Math.min(a, b)).toBeLessThan(1.15);
    expect(orbToString(renderOrb(11, W, H))).not.toBe(orbToString(renderOrb(14, W, H)));
  });

  test("dissolves into scattered dots and comes back", () => {
    const full = inkCount(lines(FULL, W, H));
    const mid = inkCount(lines(15.4, W, H));
    expect(mid).toBeGreaterThan(full * 0.2);
    expect(mid).toBeLessThan(full * 0.8);
    expect(inkCount(lines(16.7, W, H))).toBe(0);
    expect(inkCount(lines(17.9, W, H))).toBeGreaterThan(0);
  });
});

describe("lighting", () => {
  test("light comes from the upper left, in front, and drifts slowly", () => {
    for (const t of [0, 5, 9, 13]) {
      const [x, y, z] = lightDirection(t);
      expect(x).toBeLessThan(0);
      expect(y).toBeLessThan(0);
      expect(z).toBeGreaterThan(0.4);
      expect(Math.hypot(x, y, z)).toBeCloseTo(1, 6);
    }
    expect(lightDirection(4)).not.toEqual(lightDirection(8));
    lightDirection(LOOP_SECONDS + 4).forEach((v, i) => expect(v).toBeCloseTo(lightDirection(4)[i]!, 6));
  });

  test("the lit side of the flower is brighter than the far side", () => {
    for (const t of [BUD, 6, FULL]) {
      expect(quadrantMean(t, W, H, false, false)).toBeGreaterThan(quadrantMean(t, W, H, true, true) * 1.15);
    }
  });

  test("brightness spans dark blue to white with speculars in the minority", () => {
    const f = renderPixels(FULL, W, H);
    const drawn = Array.from(f.data).filter((b) => b >= 0);
    expect(Math.min(...drawn)).toBeLessThan(0.2);
    expect(Math.max(...drawn)).toBeGreaterThan(0.9);
    const bright = drawn.filter((b) => b > 0.75).length;
    expect(bright).toBeGreaterThan(drawn.length * 0.02);
    expect(bright).toBeLessThan(drawn.length * 0.3);
    expect(brightnessColor(0)).not.toBe(flowerColors.body);
    expect(brightnessColor(1)).toBe(flowerColors.light);
    expect(brightnessColor(LIGHT_FROM)).toBe(flowerColors.body);
  });
});

describe("flower frames", () => {
  test("frames are deterministic, exactly sized, merged into runs and shaded in many levels", () => {
    const a = renderOrb(FULL, W, H);
    const b = renderOrb(FULL, W, H);
    expect(orbToString(a)).toBe(orbToString(b));
    expect(a.rows).toHaveLength(H);
    for (const row of a.rows) {
      const text = row.map((r) => r.text).join("");
      expect([...text].length).toBe(W);
      for (const run of row) expect(run.text.length).toBeGreaterThan(0);
      for (let i = 1; i < row.length; i++) expect(row[i]!.color).not.toBe(row[i - 1]!.color);
    }
    const colours = new Set(a.rows.flat().map((r) => r.color));
    expect(colours.has(palette.bg)).toBe(true);
    expect(colours.size).toBeGreaterThan(8);
    for (const c of colours) expect(/^#[0-9a-f]{6}$/.test(c)).toBe(true);
    // Blank cells are spaces on the background, never empty Braille.
    for (const run of a.rows.flat()) {
      if (run.color === palette.bg) expect(run.text).toMatch(/^ +$/);
      else expect(run.text).toMatch(/^[⠁-⣿]+$/);
    }
  });

  test("draws only Braille dots: no digits, letters or block glyphs", () => {
    for (const t of [BUD, 5, FULL, 15.4]) {
      const text = lines(t, W, H).join("\n");
      expect(text).toMatch(/^[⠁-⣿ \n]+$/);
    }
  });

  test("dot density follows brightness", () => {
    const frame = renderOrb(FULL, W, H);
    const f = renderPixels(FULL, W, H);
    let bright = 0;
    let brightN = 0;
    let dark = 0;
    let darkN = 0;
    frame.rows.forEach((runs, cy) => {
      let cx = 0;
      for (const run of runs) {
        for (const ch of run.text) {
          let sum = 0;
          let n = 0;
          for (let dy = 0; dy < 4; dy++)
            for (let dx = 0; dx < 2; dx++) {
              const b = f.data[(cy * 4 + dy) * f.px + cx * 2 + dx]!;
              if (b >= 0) {
                sum += b;
                n++;
              }
            }
          if (n === 8) {
            if (sum / n > 0.7) {
              bright += dotCount(ch);
              brightN++;
            } else if (sum / n < 0.3) {
              dark += dotCount(ch);
              darkN++;
            }
          }
          cx++;
        }
      }
    });
    expect(brightN).toBeGreaterThan(5);
    expect(darkN).toBeGreaterThan(5);
    expect(bright / brightN).toBeGreaterThan((dark / darkN) * 1.5);
  });

  test("has a floral silhouette: a jagged, roughly round head", () => {
    const rows = lines(FULL, W, H);
    const widths = rows.map((r) => r.trim().length);
    const widest = widths.indexOf(Math.max(...widths));
    expect(widest).toBeGreaterThan(H * 0.25);
    expect(widest).toBeLessThan(H * 0.8);
    let jagged = 0;
    for (let i = 1; i < widths.length - 1; i++) if (Math.abs(widths[i]! - (widths[i - 1]! + widths[i + 1]!) / 2) >= 2) jagged++;
    expect(jagged).toBeGreaterThanOrEqual(3);
  });

  test("petal extent is irregular and bounded, and closed petals hug the bud", () => {
    const open = Array.from({ length: 64 }, (_, i) => petalRadius((i / 64) * Math.PI * 2 - Math.PI, 1));
    expect(Math.min(...open)).toBeGreaterThan(0.2);
    expect(Math.max(...open)).toBeLessThanOrEqual(1.25);
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
      for (const r of rows) expect([...r].length).toBe(w);
      expect(inkCount(rows)).toBeGreaterThan(w * h * 8 * 0.15);
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
      expect(frame).not.toMatch(/[a-zA-Z0-9]/);
      expect(frame).toMatch(/[⠁-⣿]{3,}/);
      expect(frame).not.toMatch(/[▒▓█▌░╿┃]/);
    } finally {
      setup.renderer.destroy();
    }
  });
});
