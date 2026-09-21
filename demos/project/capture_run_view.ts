import { readFile } from "node:fs/promises";
import { taskRunView } from "../../taskground/app/activity";
import { nativeSessionPaths } from "../../taskground/app/native-sessions";
import type { RunRecord } from "../../taskground/app/runner";

/** A native turn can end while background jobs are still part of the task. */
export async function captureRunView(run:RunRecord) {
  const view=await taskRunView(run);
  if(run.agent!=="claude")return view;
  const pending=new Set<string>();
  let lastNotificationAt=0;
  for(const path of await nativeSessionPaths(run)) {
    for(const line of (await readFile(path,"utf8")).trim().split("\n")) {
      let row;try{row=JSON.parse(line);}catch{continue;}
      if(row.isSidechain)continue;
      const background=row.toolUseResult?.backgroundTaskId;
      if(background)pending.add(background);
      const prompt=row.attachment?.commandMode==="task-notification"?row.attachment.prompt:
        row.type==="user"&&typeof row.message?.content==="string"&&row.message.content.startsWith("<task-notification>")?row.message.content:"";
      if(/<status>(completed|failed|killed)<\/status>/.test(prompt)) {
        lastNotificationAt=Math.max(lastNotificationAt,Date.parse(row.timestamp)||0);
        const id=prompt.match(/<task-id>([^<]+)<\/task-id>/)?.[1];
        if(id)pending.delete(id);
      }
    }
  }
  if(pending.size||lastNotificationAt>Date.parse(view.finishedAt??"1970-01-01")){
    view.status="running";delete view.finishedAt;delete view.elapsedMs;
  }
  return view;
}
