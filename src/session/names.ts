/** Friendly offline names used until a generated or user-supplied name exists. */
export const FALLBACK_SESSION_NAMES = [
  "Amber Finch",
  "Blue Lantern",
  "Brisk Meadow",
  "Bronze Otter",
  "Cedar Comet",
  "Cloud Badger",
  "Copper Heron",
  "Coral Fox",
  "Dawn Sparrow",
  "Ember Harbor",
  "Fern Rabbit",
  "Frost Wren",
  "Golden Moss",
  "Green Kestrel",
  "Indigo Brook",
  "Ivory Lark",
  "Juniper Kite",
  "Lunar Robin",
  "Maple Moth",
  "Misty Acorn",
  "Ocean Thrush",
  "Olive Starling",
  "Opal Creek",
  "Orchid Lynx",
  "Quiet Birch",
  "Redwood Swift",
  "River Magpie",
  "Silver Bramble",
  "Solar Wren",
  "Stone Firefly",
  "Teal Marigold",
  "Velvet Pine",
] as const;

/** Stable across restarts without storing a second mutable index. */
export function fallbackSessionName(sessionId: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(sessionId)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return FALLBACK_SESSION_NAMES[(hash >>> 0) % FALLBACK_SESSION_NAMES.length]!;
}

export function normalizeSessionName(value: string, maxLength = 64): string {
  const firstLine = value
    .replace(/^\s*```(?:json|text)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .split(/\r?\n/, 1)[0] ?? "";
  const normalized = firstLine
    .replace(/^\s*[#*]+\s*/, "")
    .replace(/\s*[#*]+\s*$/, "")
    .replace(/^\s*["'`]+|["'`]+\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return [...normalized].slice(0, maxLength).join("").trim();
}
