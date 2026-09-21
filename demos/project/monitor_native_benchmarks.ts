/** Watch the existing capture batch and render each task only when all 3 finish. */
import { readdir } from "node:fs/promises";
import { readRun } from "../../taskground/app/runner";
import { captureRunView as taskRunView } from "./capture_run_view";
const root="/Users/mericungor/.local/share/taskground/f1269136c384/runs";
const tasks=["conversation_eval","error_handling_audit","product_matching","search_latency","sembench_movie","slow_trace_search"];
const done=new Set(process.argv.slice(2));
let prior="";
async function run(command:string[]) {
  const child=Bun.spawn(command,{cwd:import.meta.dir,stdout:"inherit",stderr:"inherit"});
  if(await child.exited) throw new Error(`Failed: ${command.join(" ")}`);
}
while(done.size<tasks.length){
  const runs=await Promise.all((await readdir(root)).filter(id=>/^20260921T193[67]/.test(id)).map(async id=>taskRunView(await readRun(id,root))));
  const state=runs.map(r=>`${r.task}/${r.agent}: ${r.status}`).sort().join("\n");
  if(state!==prior){console.log(new Date().toISOString(),state);prior=state;}
  for(const task of tasks){
    const group=runs.filter(r=>r.task===task);
    if(done.has(task)||group.length!==3||group.some(r=>r.status!=="completed"))continue;
    await run([process.execPath,"export_tui_frames.ts",task]);
    await run([`${import.meta.dir}/.venv/bin/python`,"render_native_tui.py",task]);
    done.add(task);console.log(`RENDERED ${task} (${done.size}/6)`);
  }
  if(done.size<tasks.length)await Bun.sleep(30000);
}
console.log("All six native TUI videos rendered.");
