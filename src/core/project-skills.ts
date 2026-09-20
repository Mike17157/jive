import { YAML } from "bun";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface ProjectSkill {
  name: string;
  description: string;
  /** Absolute path to the live instructions, not a copy of their contents. */
  path: string;
}

export interface ProjectSkillsSnapshot {
  directory: string;
  skills: ProjectSkill[];
  diagnostics: string[];
}

export function emptyProjectSkills(cwd: string): ProjectSkillsSnapshot {
  return { directory: join(resolve(cwd), ".jive", "skills"), skills: [], diagnostics: [] };
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function skillMetadata(text: string, path: string): ProjectSkill {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const end = lines.findIndex((line, index) => index > 0 && line.trimEnd() === "---");
  if (lines[0]?.trimEnd() !== "---" || end < 0) {
    throw new Error("Expected YAML frontmatter enclosed by --- with name and description fields.");
  }
  const metadata = YAML.parse(lines.slice(1, end).join("\n"));
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("Skill frontmatter must be a mapping with name and description fields.");
  }
  const { name, description } = metadata as Record<string, unknown>;
  if (typeof name !== "string" || !name.trim() || /[\r\n]/.test(name)) {
    throw new Error("Skill name must be a nonempty, single-line string.");
  }
  if (typeof description !== "string" || !description.trim()) {
    throw new Error("Skill description must be a nonempty string.");
  }
  return { name: name.trim(), description: description.replace(/\s+/g, " ").trim(), path };
}

/** Discover immediate skill folders once. Graphs, scripts, and instruction bodies stay on disk. */
export async function loadProjectSkills(cwd: string): Promise<ProjectSkillsSnapshot> {
  const snapshot = emptyProjectSkills(cwd);
  let entries;
  try {
    entries = await readdir(snapshot.directory, { withFileTypes: true });
  } catch (error) {
    if (!isMissingFile(error)) {
      snapshot.diagnostics.push(`Could not discover project skills in ${snapshot.directory}: ${errorMessage(error)}`);
    }
    return snapshot;
  }

  // Code-point order is stable across machines and determines duplicate-name precedence.
  entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const names = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const directory = join(snapshot.directory, entry.name);
    const path = join(directory, "SKILL.md");
    try {
      if (entry.isSymbolicLink() && !(await stat(directory)).isDirectory()) continue;
      const skill = skillMetadata(await readFile(path, "utf8"), path);
      const previous = names.get(skill.name);
      if (previous) throw new Error(`Duplicate skill name ${JSON.stringify(skill.name)}; already supplied by ${previous}.`);
      names.set(skill.name, path);
      snapshot.skills.push(skill);
    } catch (error) {
      // Supporting folders without SKILL.md are not skills.
      if (!isMissingFile(error)) snapshot.diagnostics.push(`Skipped project skill ${path}: ${errorMessage(error)}`);
    }
  }
  return snapshot;
}

export function projectSkillsPrompt(snapshot: ProjectSkillsSnapshot): string {
  return [
    `Available project skills (catalog snapshotted at session creation from ${snapshot.directory}):`,
    snapshot.skills.length
      ? snapshot.skills.map(skill => `- ${skill.name}: ${skill.description}\n  Instructions: ${JSON.stringify(skill.path)}`).join("\n")
      : "(No project skills in this session's catalog.)",
    "Read a relevant skill's SKILL.md before using it. Load instructions, graphs, and supporting files from their current paths only when needed. They are editable starting points: adapt or combine them freely for the task, and execute graphs with execute_graph or execute_graph_mod.",
    "Resolve supporting files relative to the skill directory. Graph node paths still default to the session working directory; bind paths or set cwd explicitly when needed.",
    "Only this catalog is frozen. New skills can be used by path during this session; a new session discovers the updated catalog.",
  ].join("\n\n");
}
