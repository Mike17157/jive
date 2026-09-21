/** Main-agent usage from durable native sessions; no quality/grade metrics. */
import { readdir, readFile } from "node:fs/promises";
import { readRun } from "../../taskground/app/runner";
import { captureRunView as taskRunView } from "./capture_run_view";
import { getRunMetrics } from "../../taskground/app/metrics";
import { nativeSessionPaths } from "../../taskground/app/native-sessions";
const root = "/Users/mericungor/.local/share/taskground/f1269136c384/runs";
const results = [];
async function rows(path:string) {
  return (await readFile(path,"utf8")).trim().split("\n").flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
}
for (const id of (await readdir(root)).filter(id=>/^20260921T193[67]/.test(id))) {
  const run = await taskRunView(await readRun(id,root));
  if (run.status !== "completed") continue;
  let llmCalls=0, toolCalls=0, jevCalls=0, outputTokens=0;
  if (run.agent === "jive") {
    const metrics = await getRunMetrics(run);
    llmCalls=metrics.plannerTurns ?? 0; toolCalls=metrics.steps ?? 0; jevCalls=metrics.jevCalls ?? 0;
    const sessions = run.sessionArtifacts?.length ? run.sessionArtifacts :
      (await readdir(`${run.workspace}/.jev/sessions`)).map(s=>`${run.workspace}/.jev/sessions/${s}/session.jsonl`);
    for (const path of sessions) for (const row of await rows(path))
      if(row.type==="planner.message") outputTokens += row.data?.usage?.completionTokens ?? 0;
  } else {
    const calls = new Set<string>(), responses = new Map<string,number>();
    for(const path of await nativeSessionPaths(run)) for(const row of await rows(path)) {
      if(run.agent==="codex") {
        const p=row.payload;
        if(row.type==="token_usage_record" && p.response_id) responses.set(p.response_id, Math.max(responses.get(p.response_id)??0,p.usage?.output_tokens??0));
        if(row.type==="response_item" && ["function_call","custom_tool_call"].includes(p.type)) calls.add(p.call_id);
      } else if(row.type==="assistant" && row.message?.id && !row.isSidechain) {
        const m=row.message;
        responses.set(m.id, Math.max(responses.get(m.id)??0,m.usage?.output_tokens??0));
        for(const block of m.content??[]) if(block.type==="tool_use") calls.add(block.id);
      }
    }
    llmCalls=responses.size; toolCalls=calls.size; outputTokens=[...responses.values()].reduce((a,b)=>a+b,0);
  }
  results.push({task:run.task,agent:run.agent,id:run.id,elapsedMs:run.elapsedMs,llmCalls,toolCalls,jevCalls,outputTokens});
}
console.log(JSON.stringify(results,null,2));
