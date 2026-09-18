import type { Condition } from "./types";

export function pointer(root: unknown, path: string): unknown {
  if (path === "") return root;
  if (!path.startsWith("/")) throw new Error(`Reference must be a JSON pointer: ${path}`);
  let value: any = root;
  const parts = path.slice(1).split("/").map(p => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  for (const part of parts) {
    if (value == null || typeof value !== "object" || !Object.hasOwn(value, part)) throw new Error(`Missing reference: ${path}`);
    if ((part === "stdout" || part === "stderr") && value[`${part}Truncated`]) {
      throw new Error(`${path} exceeds inline capture size; use ${part}Path to process the complete artifact`);
    }
    value = value[part];
  }
  return value;
}

export function resolve(value: unknown, scope: unknown): any {
  if (Array.isArray(value)) return value.map(v => resolve(v, scope));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Object.hasOwn(record, "$literal")) {
      if (Object.keys(record).length !== 1) throw new Error("$literal must be the only key");
      return record.$literal;
    }
    if (Object.hasOwn(record, "$ref")) {
      if (Object.keys(record).length !== 1 || typeof record.$ref !== "string") throw new Error("Invalid $ref expression");
      return pointer(scope, record.$ref);
    }
    return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, resolve(v, scope)]));
  }
  return value;
}

export function evaluate(condition: Condition, scope: unknown): boolean {
  const { op, args } = condition;
  const predicate = (arg: any) => arg && typeof arg === "object" && typeof arg.op === "string" ? evaluate(arg, scope) : resolve(arg, scope);
  if (op === "and") return args.every(a => predicate(a) === true);
  if (op === "or") return args.some(a => predicate(a) === true);
  if (op === "not") return !predicate(args[0]);
  if (op === "exists") { try { return resolve(args[0], scope) !== undefined; } catch { return false; } }
  const [a, b] = args.map(arg => resolve(arg, scope));
  switch (op) {
    case "eq": return JSON.stringify(a) === JSON.stringify(b);
    case "ne": return JSON.stringify(a) !== JSON.stringify(b);
    case "in": return Array.isArray(b) ? b.some(v => JSON.stringify(v) === JSON.stringify(a)) : false;
    case "gt": case "gte": case "lt": case "lte": {
      if (typeof a !== "number" || typeof b !== "number" || !Number.isFinite(a) || !Number.isFinite(b)) throw new Error(`${op} requires finite numbers`);
      return op === "gt" ? a > b : op === "gte" ? a >= b : op === "lt" ? a < b : a <= b;
    }
    default: throw new Error(`Unsupported condition: ${op}`);
  }
}

export function references(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(references);
  const object = value as Record<string, unknown>;
  if (Object.hasOwn(object, "$literal")) return [];
  if (Object.hasOwn(object, "$ref")) return [String(object.$ref)];
  return Object.values(object).flatMap(references);
}
