/**
 * Slash commands: registry, filtering for the composer popup, and parsing.
 * Pure and renderer-independent.
 */
export type CommandName = "model" | "graph" | "pin" | "help" | "quit" | "new" | "clear" | "effort" | "provider" | "resume" | "sessions" | "name" | "rename";

export interface CommandSpec {
  name: CommandName;
  usage: string;
  description: string;
  /** Selecting it from the popup: run immediately, or leave text in the composer for the user to finish. */
  select: "run" | "edit";
  aliases: string[];
}

export const COMMANDS: readonly CommandSpec[] = [
  { name: "model", usage: "/model [id]", description: "choose the planning model (Ctrl+P)", select: "run", aliases: ["models"] },
  { name: "graph", usage: "/graph", description: "browse and inspect executed graphs (Ctrl+G)", select: "run", aliases: ["g"] },
  { name: "pin", usage: "/pin <text>", description: "keep text verbatim across compaction", select: "edit", aliases: [] },
  { name: "effort", usage: "/effort [level]", description: "adjust reasoning effort", select: "run", aliases: [] },
  { name: "provider", usage: "/provider [choice]", description: "force anthropic or openrouter for direct models", select: "run", aliases: [] },
  { name: "resume", usage: "/resume [id]", description: "resume a saved session", select: "run", aliases: [] },
  { name: "sessions", usage: "/sessions", description: "browse saved sessions", select: "run", aliases: [] },
  { name: "name", usage: "/name <text>", description: "name the current session", select: "edit", aliases: [] },
  { name: "rename", usage: "/rename <text>", description: "rename the current session", select: "edit", aliases: [] },
  { name: "new", usage: "/new", description: "start a fresh session; keep the archive", select: "run", aliases: [] },
  { name: "clear", usage: "/clear", description: "clear the view and start a fresh session", select: "run", aliases: [] },
  { name: "help", usage: "/help", description: "list commands and keys", select: "run", aliases: ["?"] },
  { name: "quit", usage: "/quit", description: "leave the session (Ctrl+C twice)", select: "run", aliases: ["exit", "q"] },
];

export function findCommand(name: string): CommandSpec | undefined {
  const n = name.toLowerCase();
  return COMMANDS.find((c) => c.name === n || c.aliases.includes(n));
}

/**
 * The popup query for the current composer text: the partial command name when
 * the text is a single line starting with "/" and no argument has been typed yet.
 * Returns null when the popup should be hidden.
 */
export function slashQuery(text: string): string | null {
  if (!text.startsWith("/")) return null;
  if (text.includes("\n")) return null;
  const body = text.slice(1);
  if (/\s/.test(body)) return null;
  return body.toLowerCase();
}

/** Commands whose name or alias starts with the query. */
export function filterCommands(query: string): CommandSpec[] {
  const q = query.toLowerCase();
  return COMMANDS.filter((c) => c.name.startsWith(q) || c.aliases.some((a) => a.startsWith(q)));
}

export type ComposerCommand =
  | { kind: "submit"; text: string }
  | { kind: "model"; id?: string }
  | { kind: "pin"; text: string }
  | { kind: "quit" }
  | { kind: "help" }
  | { kind: "graph" }
  | { kind: "new" }
  | { kind: "clear" }
  | { kind: "effort"; level?: string }
  | { kind: "provider"; choice?: string }
  | { kind: "resume"; id?: string }
  | { kind: "sessions" }
  | { kind: "name"; text: string }
  | { kind: "unknown"; name: string }
  | { kind: "empty" };

export function parseComposerInput(raw: string): ComposerCommand {
  const text = raw.replace(/\s+$/, "");
  if (text.trim().length === 0) return { kind: "empty" };
  if (!text.startsWith("/")) return { kind: "submit", text };
  const match = /^\/([a-zA-Z?]+)\s*([\s\S]*)$/.exec(text);
  if (!match) return { kind: "submit", text };
  const spec = findCommand(match[1]!);
  const rest = (match[2] ?? "").trim();
  if (!spec) return { kind: "unknown", name: match[1]!.toLowerCase() };
  switch (spec.name) {
    case "model":
      return rest ? { kind: "model", id: rest } : { kind: "model" };
    case "effort":
      return rest ? { kind: "effort", level: rest.toLowerCase() } : { kind: "effort" };
    case "provider":
      return rest ? { kind: "provider", choice: rest.toLowerCase() } : { kind: "provider" };
    case "resume":
      return rest ? { kind: "resume", id: rest } : { kind: "resume" };
    case "sessions":
      return { kind: "sessions" };
    case "name":
    case "rename":
      return rest ? { kind: "name", text: rest } : { kind: "unknown", name: `${spec.name} (needs text)` };
    case "new": return {kind:"new"};
    case "clear": return {kind:"clear"};
    case "pin":
      return rest ? { kind: "pin", text: rest } : { kind: "unknown", name: "pin (needs text)" };
    case "quit":
      return { kind: "quit" };
    case "help":
      return { kind: "help" };
    case "graph":
      return { kind: "graph" };
  }
}

export const keyHelp = [
  "Enter sends · Shift+Enter or Ctrl+J newline · Ctrl+C interrupts a running turn",
  "Graph focus: ↑/↓ select · → or Enter expand/inspect · ← collapse · e/c open/fold all · [ ] switch graph · Esc back",
];

export const helpText = [...COMMANDS.map((c) => `${c.usage.padEnd(14)}${c.description}`), ...keyHelp].join("\n");
