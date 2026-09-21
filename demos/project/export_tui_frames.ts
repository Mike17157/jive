/** Replay original timed PTY bytes through xterm; emit styled native screen cells. */
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { Terminal } from "@xterm/headless";
import { captureRunView as taskRunView } from "./capture_run_view";
import { readRun } from "../../taskground/app/runner";
import { createWriteStream } from "node:fs";
import { once } from "node:events";

const root = "/Users/mericungor/.local/share/taskground/f1269136c384/runs";
const task = process.argv[2];
const out = `${import.meta.dir}/tui-generated`;
await mkdir(out, { recursive: true });
const ids = (await readdir(root)).filter(id => /^20260921T193[67]/.test(id));
const runs = [];
for (const id of ids) { const r = await readRun(id, root); if (r.task === task) runs.push(await taskRunView(r)); }
runs.sort((a,b) => ["jive","codex","claude"].indexOf(a.agent)-["jive","codex","claude"].indexOf(b.agent));
if (runs.length !== 3) throw new Error(`Expected 3 runs for ${task}`);
if (runs.some(r => r.status !== "completed")) throw new Error("All three runs must finish before export");
const panes = [];
for (const r of runs) {
  const lines = (await readFile(`${r.directory}/terminal.cast`, "utf8")).trim().split("\n");
  const header = JSON.parse(lines.shift()!);
  const events = lines.map(line => JSON.parse(line));
  const term = new Terminal({ cols: header.width, rows: header.height, scrollback: 2000, allowProposedApi: true });
  const env = await readFile(`${r.workspace}/.env`, "utf8").catch(() => "");
  const secrets = [...env.matchAll(/^[A-Z_]*(?:KEY|TOKEN)\s*=\s*["']?([^"'\n]+)/gm)].map(m=>m[1]!).filter(s=>s.length>12);
  panes.push({ r, term, events, cursor: 0, start: Date.parse(r.startedAt!)/1000-header.timestamp, secrets });
}
const durations = runs.map(r=>(r.elapsedMs ?? 0)/1000);
if (durations.some(t=>t<=0)) throw new Error("Run has no completed duration");
const switchAt = Math.min(...durations);
const end = Math.max(...durations);
const finish = switchAt/10+(end-switchAt)/50;
const fps = 12, duration = finish+6;
const metadata = { task, fps, duration, finish, switchAt, runs: runs.map((r,i)=>({ id:r.id,agent:r.agent,seconds:durations[i],model:r.model,effort:r.effort })) };
await writeFile(`${out}/${task}.json`,JSON.stringify(metadata,null,2));
const stream = createWriteStream(`${out}/${task}.frames.jsonl`);
function color(cell:any, fg:boolean) {
  const mode = fg?cell.getFgColorMode():cell.getBgColorMode();
  const value = fg?cell.getFgColor():cell.getBgColor();
  return mode===0?null:mode===0x3000000?`#${value.toString(16).padStart(6,"0")}`:value;
}
for(let frame=0; frame<Math.ceil(duration*fps);frame++){
  const t=frame/fps;
  const source=Math.min(end,t<switchAt/10?t*10:switchAt+(t-switchAt/10)*50);
  const screens=[];
  for(const pane of panes){
    const completedAt=(pane.r.elapsedMs??0)/1000;
    // Native completion events can precede the last terminal repaint slightly.
    const target=(source>=completedAt?completedAt+1:source)+pane.start;
    while(pane.cursor<pane.events.length && pane.events[pane.cursor][0]<=target){
      const [,kind,raw]=pane.events[pane.cursor++];
      if(kind==="o"){
        let data=raw;
        for(const secret of pane.secrets)data=data.replaceAll(secret,"[REDACTED]");
        await new Promise<void>(resolve=>pane.term.write(data,resolve));
      }else if(kind==="r"){const [cols,rows]=raw.split("x").map(Number);pane.term.resize(cols,rows);}
    }
    const rows=[];
    for(let y=0;y<pane.term.rows;y++){
      const line=pane.term.buffer.active.getLine(pane.term.buffer.active.baseY+y);
      const spans:any[]=[];
      for(let x=0;x<pane.term.cols;x++){
        const cell=line?.getCell(x);if(!cell || cell.getWidth()===0)continue;
        const chars=cell.getChars()||" ";
        const style=[color(cell,true),color(cell,false),!!cell.isBold(),!!cell.isInverse(),!!cell.isUnderline()];
        const last=spans.at(-1);
        if(last && /^[\x20-\x7e]+$/.test(chars) && /^[\x20-\x7e]+$/.test(last[1]) && JSON.stringify(last[2])===JSON.stringify(style) && last[0]+last[3]===x){last[1]+=chars;last[3]+=cell.getWidth();}
        else spans.push([x,chars,style,cell.getWidth()]);
      }
      rows.push(spans);
    }
    screens.push(rows);
  }
  if(!stream.write(JSON.stringify({source,screens})+"\n"))await once(stream,"drain");
}
stream.end(); await once(stream,"finish");
for(const p of panes)p.term.dispose();
console.log(`${task}: ${Math.ceil(duration*fps)} full terminal frames`);
