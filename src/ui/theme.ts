/**
 * Visual identity: neutral dark surfaces, warm white text and borders, and a
 * vivid baby-blue accent used sparingly (glyphs, focus borders, the orb).
 * Everything in the UI pulls colours from here so the palette stays coherent.
 */
export const palette = {
  bg: "#141414",
  surface: "#1a1a1a",
  surfaceRaised: "#222222",
  input: "#1b1b1b",
  border: "#fcfcfb",
  borderSoft: "#3a3a3a",
  text: "#fcfcfb",
  textDim: "#a8a7a3",
  textFaint: "#6b6a66",
  /** Reply body copy: a step below the warm white so prose sits back from the chrome. */
  prose: "#cfcdc8",
  /** Emphasis inside prose (bold, links): the accent laid over `prose` as a wash, never the full baby blue. */
  proseAccent: "#a1c8e6",
  accent: "#7cc4ff",
  accentSoft: "#4f9be0",
  accentDeep: "#2f6fb0",
  user: "#7fdca0",
  green: "#7fdca0",
  greenDim: "#3f7a55",
  yellow: "#f2d17a",
  yellowDim: "#8a7a44",
  grey: "#6b6a66",
  greyDim: "#3a3a3a",
  red: "#ff8c9a",
  /** Jev judgements: a completed decision reads as purple, not green. */
  purple: "#c9a2ff",
} as const;

/** Gradient stops from deep blue through baby blue to warm white; used by the orb and sweeps. */
export const gradientStops: readonly string[] = ["#2f6fb0", "#3f8fd6", "#5cb0f5", "#7cc4ff", "#a5d8ff", "#d2ecff", "#fcfcfb"];

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Linear interpolation between two hex colours, t in [0,1]. */
export function mixHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  const k = Math.max(0, Math.min(1, t));
  return rgbToHex(ar + (br - ar) * k, ag + (bg - ag) * k, ab + (bb - ab) * k);
}

/** Sample the blue→white gradient at t in [0,1]. */
export function gradientAt(t: number): string {
  const k = Math.max(0, Math.min(1, t));
  const pos = k * (gradientStops.length - 1);
  const i = Math.floor(pos);
  const j = Math.min(gradientStops.length - 1, i + 1);
  return mixHex(gradientStops[i]!, gradientStops[j]!, pos - i);
}

/** Shade a colour toward the background; amount in [0,1]. */
export function dimHex(color: string, amount: number): string {
  return mixHex(color, palette.bg, amount);
}
