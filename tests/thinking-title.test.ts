import { describe, expect, test } from "bun:test";
import { borderRing, GLIMMER_COVERAGE, rayIntensity, rayState, SWEEP_PERIOD_S } from "../src/ui/glimmer.ts";
import { thinkingTitle } from "../src/ui/thinking.ts";

describe("thinkingTitle", () => {
  test("uses the opening words of the newest paragraph and strips markdown", () => {
    const text = "**Analyzing Execution Failures**\n\nI'm currently reviewing the specific execution outcomes and error logs from the initial attempt.";
    expect(thinkingTitle(text)).toBe("I'm currently reviewing the specific execution outcomes and…");
    expect(thinkingTitle("**Analyzing Execution Failures**")).toBe("Analyzing Execution Failures");
    expect(thinkingTitle("## Plan:\n\n- check `tests/` for *expiry* cases")).toBe("check tests/ for expiry cases");
  });

  test("advances as paragraphs stream in but waits for a stub paragraph to grow", () => {
    let text = "Checking the session store before reading tests.";
    expect(thinkingTitle(text)).toBe("Checking the session store before reading tests.");
    text += "\n\nNow";
    expect(thinkingTitle(text)).toBe("Checking the session store before reading tests.");
    text += " comparing the expiry";
    expect(thinkingTitle(text)).toBe("Now comparing the expiry");
  });

  test("has a placeholder for empty reasoning and caps very long words", () => {
    expect(thinkingTitle("")).toBe("Thinking…");
    expect(thinkingTitle("   \n\n  ")).toBe("Thinking…");
    const long = thinkingTitle("x".repeat(200));
    expect(long.length).toBeLessThanOrEqual(72);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("composer glimmer", () => {
  test("the ring walks the border clockwise without repeating a cell", () => {
    const ring = borderRing(6, 4);
    expect(ring).toHaveLength(2 * (6 + 4 - 2));
    expect(ring[0]).toEqual({ x: 0, y: 0 });
    expect(ring[5]).toEqual({ x: 5, y: 0 });
    expect(ring[ring.length - 1]).toEqual({ x: 0, y: 1 });
    expect(new Set(ring.map((c) => `${c.x},${c.y}`)).size).toBe(ring.length);
    expect(ring.every((c) => c.x === 0 || c.y === 0 || c.x === 5 || c.y === 3)).toBe(true);
  });

  test("the ray lights the top and bottom edges together and covers about forty percent of the width", () => {
    const width = 100, height = 6;
    const ray = { centre: 50, tilt: 0 };
    const litTop = Array.from({ length: width }, (_, x) => rayIntensity(x, 0, width, height, ray)).filter((k) => k > 0).length;
    expect(Math.abs(litTop / width - GLIMMER_COVERAGE)).toBeLessThan(0.03);
    expect(rayIntensity(50, 0, width, height, ray)).toBeCloseTo(1);
    expect(rayIntensity(50, height - 1, width, height, ray)).toBeCloseTo(1);
    expect(rayIntensity(0, 0, width, height, ray)).toBe(0);
    // The side borders glow once the ray reaches an edge.
    expect(rayIntensity(0, 3, width, height, { centre: 2, tilt: 0 })).toBeGreaterThan(0.9);
  });

  test("tilt slants the ray so the bottom edge is lit offset from the top edge", () => {
    const width = 100, height = 6;
    const ray = { centre: 50, tilt: 2 };
    const peak = (y: number) => Array.from({ length: width }, (_, x) => rayIntensity(x, y, width, height, ray)).indexOf(1);
    expect(peak(0)).toBe(45);
    expect(peak(height - 1)).toBe(55);
  });

  test("the ray sweeps from the left edge to the right and back, easing at the ends, while its tilt keeps changing", () => {
    const width = 101;
    expect(rayState(0, width).centre).toBeCloseTo(50);
    expect(rayState(SWEEP_PERIOD_S / 4, width).centre).toBeGreaterThan(width - 1);
    expect(rayState((3 * SWEEP_PERIOD_S) / 4, width).centre).toBeLessThan(0);
    expect(rayState(SWEEP_PERIOD_S, width).centre).toBeCloseTo(50);
    const nearEdge = Math.abs(rayState(SWEEP_PERIOD_S / 4 + 0.1, width).centre - rayState(SWEEP_PERIOD_S / 4, width).centre);
    const midway = Math.abs(rayState(0.1, width).centre - rayState(0, width).centre);
    expect(nearEdge).toBeLessThan(midway / 10);
    const tilts = [0, 1, 2, 3, 4].map((t) => rayState(t, width).tilt);
    expect(new Set(tilts.map((t) => t.toFixed(2))).size).toBe(tilts.length);
  });
});
