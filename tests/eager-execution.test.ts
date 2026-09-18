import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AsyncQueue } from "../src/core/async-queue";
import { executeGraph } from "../src/core/executor";
import type { Graph, ExecutionEvent } from "../src/core/types";
import { SessionStore } from "../src/session/store";
import { GraphBuildingRound } from "../src/planner/graph-building";

const dirs: string[] = [];
async function directory() { const cwd = await mkdtemp(join(tmpdir(), "jev-eager-")); dirs.push(cwd); return cwd; }
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, {recursive:true,force:true}))); });
function latch() { let resolve!: () => void; const promise = new Promise<void>(done => {resolve=done;}); return {promise,resolve}; }
const first: Graph = {eager:true,version:1,label:"stream",context:{},templates:{},limits:{},returns:["first"],nodes:{first:{type:"bash",script:"printf 'once\\n' >> count; printf 'hello'"}}};

test("a completed prefix executes while more nodes are still being generated, without replay", async () => {
  const cwd = await directory(), done = latch(), updates = new AsyncQueue<Graph>();
  const events: ExecutionEvent[] = [];
  const running = executeGraph(first, {cwd,updates,onEvent(event) {
    events.push(event); if(event.type==="node.finished"&&event.nodeId==="first")done.resolve();
  }});
  await done.promise;
  expect(events.some(event=>event.type==="graph.finished")).toBe(false);
  updates.push({...first,nodes:{...first.nodes,second:{type:"bash",stdin:{$ref:"/nodes/first/output/stdout"},script:"cat"}},returns:["first","second"]});
  updates.close();
  const report = await running;
  expect(report.status).toBe("done");
  expect((report.requested.second?.output as any).stdout).toBe("hello");
  expect(await readFile(join(cwd,"count"),"utf8")).toBe("once\n");
  expect(events.filter(event=>event.type==="node.started"&&event.nodeId==="first")).toHaveLength(1);
});

test("committed template groups expand before the producer closes", async () => {
  const cwd = await directory(), done = latch(), updates = new AsyncQueue<Graph>();
  const graph: Graph = {version:1,label:"early group",eager:true,nodes:{},limits:{concurrency:1},templates:{
    item:{nodes:{show:{type:"bash",env:{VALUE:{$ref:"/input"}},script:"printf '%s' \"$VALUE\""}},output:{$ref:"/nodes/show/output/stdout"}},
  },groups:{each:{kind:"foreach",items:["a","b"],template:"item",maxItems:2}},returns:["each"]};
  const running = executeGraph(graph,{cwd,updates,onEvent(event){if(event.type==="node.finished"&&event.nodeId==="each")done.resolve();}});
  await done.promise;
  updates.close();
  const report = await running;
  expect(report.status).toBe("done");
  expect((report.requested.each?.output as any).items.map((item:any)=>item.output)).toEqual(["a","b"]);
});

test("late attempts to change committed settings stop without undoing existing evidence", async () => {
  const cwd = await directory(), done = latch(), updates = new AsyncQueue<Graph>();
  const running = executeGraph(first,{cwd,updates,onEvent(event){if(event.type==="node.finished")done.resolve();}});
  await done.promise;
  updates.push({...first,context:{changed:true},nodes:{...first.nodes,late:{type:"bash",script:"echo twice >> count"}}});
  updates.close();
  const report = await running;
  expect(report.status).toBe("cancelled");
  expect(report.reason).toContain("committed header");
  expect(await readFile(join(cwd,"count"),"utf8")).toBe("once\n");
});

test("cancellation closes an executor waiting for the next graph fragment", async () => {
  const cwd = await directory(), done = latch(), updates = new AsyncQueue<Graph>(), abort = new AbortController();
  const running = executeGraph(first,{cwd,updates,signal:abort.signal,onEvent(event){if(event.type==="node.finished")done.resolve();}});
  await done.promise;
  abort.abort(new Error("writer interrupted"));
  const report = await running;
  expect(report.status).toBe("cancelled");
  expect(report.requested.first?.status).toBe("done");
});

test("restart preserves early effects when no complete assistant message was saved", async () => {
  const cwd = await directory();
  const store = new SessionStore({cwd,sessionId:"orphan"});
  await store.initialize();
  await store.append("graph.stream.started",{streamId:"early",graphId:"early",graph:first,recordPath:join(cwd,".jev/runs/early")});
  await store.append("execution.event",{event:{sequence:1,time:1,graphId:"early",type:"graph.started",data:{label:"stream"}}});
  await store.append("execution.event",{event:{sequence:2,time:2,graphId:"early",type:"node.created",nodeId:"first",data:{type:"bash",label:"first"}}});
  await store.append("execution.event",{event:{sequence:3,time:3,graphId:"early",type:"node.started",nodeId:"first",data:{}}});
  await store.append("graph.stream.finished",{streamId:"early",report:{status:"cancelled",previews:[{id:"first",status:"done"}]}});
  const restored = new SessionStore({cwd,sessionId:"orphan"});
  const recovered = await restored.recoverInterruptedToolCalls();
  expect(recovered).toHaveLength(1);
  const messages = restored.plannerMessageEvents().map(event=>event.data.message);
  expect(messages.some(message=>message.role==="tool")).toBe(false);
  expect(messages.at(-1)?.content).toContain("Completed effects may already exist");
  const repaired=restored.events.filter(event=>event.type==="execution.event").map(event=>event.data.event);
  expect(repaired.find(event=>event.type==="node.finished")?.data.result.status).toBe("cancelled");
  expect(repaired.at(-1)?.type).toBe("graph.finished");
  expect(await restored.recoverInterruptedToolCalls()).toHaveLength(0);
});

test("restored bound streams retain locators and bound oversized output", async () => {
  for (const completed of [false,true]) {
    const cwd=await directory(),store=new SessionStore({cwd,sessionId:"bound"});
    await store.initialize();
    const recordPath=join(cwd,".jev/runs/early");
    await store.append("graph.stream.started",{streamId:"early",graphId:"early",recordPath,graph:first});
    await store.append("graph.stream.bound",{streamId:"early",callId:"call",graphId:"early"});
    if(completed)await store.append("graph.stream.finished",{streamId:"early",report:{graphId:"early",recordPath,output:"x".repeat(100_000)}});
    await store.appendMessage({role:"assistant",content:null,tool_calls:[{id:"call",type:"function",function:{name:"execute_graph",arguments:JSON.stringify(first)}}]});
    await store.recoverInterruptedToolCalls();
    const content=store.plannerMessageEvents().at(-1)!.data.message.content!;
    expect(content.length).toBeLessThan(4500);
    if(completed)expect(content).toContain("OVERSIZED OUTPUT EXCERPT");
    else expect(JSON.parse(content).recordPath).toBe(recordPath);
    expect(await store.recoverInterruptedToolCalls()).toHaveLength(0);
  }
});

test("cancelling generation labels unstarted tool calls as user cancellation", async () => {
  const cwd=await directory(),store=new SessionStore({cwd,sessionId:"cancel"}),abort=new AbortController();
  await store.initialize();
  await store.appendMessage({role:"assistant",content:null,tool_calls:[{id:"pending",type:"function",function:{name:"execute_graph",arguments:JSON.stringify(first)}}]});
  abort.abort(new Error("user interrupted"));
  const round=new GraphBuildingRound({store,signal:abort.signal,execute:async()=>{throw new Error("must not replay");},onEvent:()=>{}});
  await round.interrupt("user interrupted");
  const result=JSON.parse(store.plannerMessageEvents().at(-1)!.data.message.content!);
  expect(result.status).toBe("cancelled");
  expect(result.reason).toContain("user interrupted");
  expect(result.reason).not.toContain("Session restarted");
});
