import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ExtractorRegistry } from "../plugins/registry";

/** Changes arrive as new planner events, keeping earlier message prefixes intact. */
export async function runtimeCatalog(cwd: string): Promise<string> {
  const registry = await ExtractorRegistry.load(cwd);
  const path = join(cwd, "AGENTS.md");
  let instructions: string | undefined;
  try { instructions = await readFile(path, "utf8"); }
  catch (error: any) { if (error.code !== "ENOENT") throw error; }
  return JSON.stringify({ ...JSON.parse(registry.catalog()), ...(instructions === undefined ? {} : { projectInstructions: { path, text: instructions } }) });
}
