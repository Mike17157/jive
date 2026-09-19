import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface ProjectInstructionsSnapshot {
  path: string;
  /** Null records that the file did not exist when the session was created. */
  text: string | null;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Read the working directory's instructions once so a session can persist a stable snapshot. */
export async function loadProjectInstructions(cwd: string): Promise<ProjectInstructionsSnapshot> {
  const path = join(resolve(cwd), "AGENTS.md");
  try {
    return { path, text: await readFile(path, "utf8") };
  } catch (error) {
    if (isMissingFile(error)) return { path, text: null };
    throw error;
  }
}
