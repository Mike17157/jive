import { ExtractorRegistry } from "../plugins/registry";

/** Changes arrive as new planner events, keeping earlier message prefixes intact. */
export async function runtimeCatalog(cwd: string): Promise<string> {
  const registry = await ExtractorRegistry.load(cwd);
  return registry.catalog();
}
