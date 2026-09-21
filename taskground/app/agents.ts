import { join } from "node:path";
import { REPO_ROOT } from "./tasks";

export const AGENTS = ["jive", "codex", "claude"] as const;
export type Agent = typeof AGENTS[number];
export const OPENROUTER_NOTE = "Optional: you may use OpenRouter for LLM calls with DeepSeek V4 Flash (`deepseek/deepseek-v4-flash`, API base `https://openrouter.ai/api/v1`); `OPENROUTER_API_KEY` is in `.env`. Make at most 200 OpenRouter helper API calls in total per task run, including calibration and retries. This is an instruction, not an enforced quota. Keep the key private.";

export function agentCommand(options: { agent: Agent; workspace: string; prompt: string; headless: boolean; model?: string; effort?: string; executable?: string; extraArgs?: string[]; finalPath: string }): string[] {
  const { agent, workspace, prompt, headless, model, effort, executable, extraArgs = [], finalPath } = options;
  if (agent === "jive") return [executable ?? join(REPO_ROOT, "bin/jive"), "--cwd", workspace, ...(headless ? ["--headless", "--json"] : []), ...(model ? ["--model", model] : []), ...(effort ? ["--effort", effort] : []), ...extraArgs, headless ? "--prompt" : "--prefill", prompt];
  // Codex's positional prompt submits immediately; without a native prefill flag,
  // open an empty composer and leave the task in TASK.md for manual submission.
  if (agent === "codex") return [executable ?? "codex", ...(headless ? ["exec", "--json", "--output-last-message", finalPath] : []), "--cd", workspace, "--sandbox", "workspace-write", "-c", "sandbox_workspace_write.network_access=true", ...(model ? ["--model", model] : []), ...(effort ? ["-c", `model_reasoning_effort=${JSON.stringify(effort)}`] : []), ...extraArgs, ...(headless ? [prompt] : [])];
  // Claude Code 2.1.278 supports --prefill, although it is hidden from --help.
  return [executable ?? "claude", ...(headless ? ["--print", "--output-format", "stream-json", "--verbose", "--allowedTools", "Read,Edit,Write,Bash,Glob,Grep"] : []), ...(model ? ["--model", model] : []), ...(effort ? ["--effort", effort] : []), ...extraArgs, ...(headless ? ["--", prompt] : ["--prefill", prompt])];
}
