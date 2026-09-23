import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphAgentController } from "../src/planner/agent";
import { executeGraph } from "../src/core/executor";
import { graphSchema } from "../src/core/schema";

const originalFetch = globalThis.fetch;
const dirs: string[] = [];
afterEach(async () => {
  globalThis.fetch = originalFetch;
  await Promise.all(dirs.splice(0).map(path=>rm(path,{recursive:true,force:true})));
});
const encode = (data: unknown) => new TextEncoder().encode(`data: ${typeof data==="string"?data:JSON.stringify(data)}\n\n`);

async function setup(mode:"success"|"truncated"|"renamed"|"broken"|"stray") {
  const cwd = await mkdtemp(join(tmpdir(),"jev-stream-planner-")); dirs.push(cwd);
  let finishWriter!: () => void;
  let writerFinished = false, earlyFinished = false, executions = 0, fetches = 0;
  const bodies: any[] = [];
  const first = JSON.stringify({type:"bash",script:"echo once >> count; printf first"});
  const second = JSON.stringify({type:"bash",needs:["first"],script:"printf second"});
  const prefix = `{"version":1,"label":"While writing",${mode === "broken" ? '"returns":["first","second"],' : ""}"nodes":{"first":${first}`;
  const suffix = mode==="broken" ? `,"second":${second}},"output":null}`
    : mode==="stray" ? `},"second":${second},"returns":["first","second"]}`
    : `,"second":${second}},"returns":["first","second"]}`;
  globalThis.fetch = (async (_input:unknown,init?:RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    if (++fetches > 1) return new Response(new Uint8Array([
      ...encode({choices:[{delta:{content:"Finished."},finish_reason:"stop"}]}),...encode("[DONE]"),
    ]));
    let timer: ReturnType<typeof setTimeout>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        timer = setTimeout(()=>controller.error(new Error("early execution did not start")),2000);
        controller.enqueue(encode({choices:[{delta:{tool_calls:[{index:0,id:"call-early",function:{name:"execute_graph",arguments:prefix}}]}}]}));
        finishWriter = () => {
          writerFinished = true; clearTimeout(timer);
          if(mode==="truncated") {
            controller.enqueue(encode({choices:[{delta:{},finish_reason:"length"}]}));
          } else controller.enqueue(encode({choices:[{delta:{tool_calls:[{index:0,function:{arguments:suffix,...(mode==="renamed"?{name:"_other"}:{})}}]},finish_reason:"tool_calls"}]}));
          controller.enqueue(encode("[DONE]")); controller.close();
        };
      },cancel(){clearTimeout(timer);},
    });
    return new Response(stream);
  }) as unknown as typeof fetch;
  const agent = new GraphAgentController({cwd,sessionId:"streaming",model:"test/model",apiKey:"fixture",toolSchema:graphSchema,
    supportsStreaming:true,getPluginCatalog:async()=>"",execute:async(graph,signal,onEvent,streaming)=>{
      executions++;
      return executeGraph(graph,{cwd,signal,...streaming,onEvent:event=>{
        onEvent(event);
        if(event.type==="node.finished"&&event.nodeId==="first") {
          earlyFinished = !writerFinished;
          finishWriter();
        }
      }});
    },
  });
  await agent.ready();
  await agent.submit("Run the graph as it is written");
  return {agent,cwd,earlyFinished,executions,bodies};
}

test("planner streams real execution before final tool arguments and records one tool result", async () => {
  const {agent,cwd,earlyFinished,executions,bodies}=await setup("success");
  expect(agent.getSnapshot().error).toBeUndefined();
  expect(earlyFinished).toBe(true);
  expect(executions).toBe(1);
  expect(await readFile(join(cwd,"count"),"utf8")).toBe("once\n");
  const events=agent.getSnapshot().events;
  expect(new Set(events.map(event=>event.graphId)).size).toBe(1);
  expect(events.findIndex(event=>event.type==="node.finished"&&event.nodeId==="first")).toBeLessThan(events.findIndex(event=>event.type==="graph.building.finished"));
  expect(events.filter(event=>event.type==="node.started"&&event.nodeId==="first")).toHaveLength(1);
  expect(bodies[1].messages.filter((message:any)=>message.role==="tool")).toHaveLength(1);
  expect(JSON.parse(bodies[1].messages.find((message:any)=>message.role==="tool").content).status).toBe("done");
});

test("truncated generation preserves early effects as evidence without a fake completed tool call", async () => {
  const {agent,cwd,earlyFinished,executions}=await setup("truncated");
  expect(earlyFinished).toBe(true); expect(executions).toBe(1);
  expect(agent.getSnapshot().error).toContain("length");
  expect(await readFile(join(cwd,"count"),"utf8")).toBe("once\n");
  const messages=agent.store.plannerMessageEvents().map(event=>event.data.message);
  expect(messages.filter(message=>message.role==="tool")).toHaveLength(0);
  expect(messages.some(message=>message.content?.includes("Completed effects may already exist"))).toBe(true);
  const terminal=agent.getSnapshot().events.find(event=>event.type==="graph.finished");
  expect((terminal?.data.report as any).status).toBe("cancelled");
});

test("changing a committed tool name cancels and drains early work before any later planning", async () => {
  const {agent,cwd,executions,bodies}=await setup("renamed");
  expect(executions).toBe(1);
  expect(bodies).toHaveLength(1);
  expect(agent.getSnapshot().error).toContain("committed execute_graph name");
  expect(await readFile(join(cwd,"count"),"utf8")).toBe("once\n");
  expect((agent.getSnapshot().events.find(event=>event.type==="graph.finished")?.data.report as any).status).toBe("cancelled");
});

test("arguments that stop parsing after a commitment end the call, not the turn", async () => {
  const {agent,cwd,executions,bodies}=await setup("broken");
  expect(executions).toBe(1);
  // The planner got another round instead of the user having to ask it to continue.
  expect(bodies).toHaveLength(2);
  expect(await readFile(join(cwd,"count"),"utf8")).toBe("once\n");
  const result=bodies[1].messages.filter((message:any)=>message.role==="tool");
  expect(result).toHaveLength(1);
  const content=JSON.parse(result[0].content);
  expect(content.error).toContain("header is frozen");
  expect(content.error).toContain("were not replayed");
  expect(content.status).toBe("cancelled");
  expect(content.requested.first.status).toBe("done");
  expect(agent.getSnapshot().error).toContain("header is frozen");
  const building=agent.getSnapshot().events.find(event=>event.type==="graph.building.finished");
  expect(building?.data.status).toBe("failed");
});

test("a node written past a closed nodes map is committed instead of ending the call", async () => {
  const {agent,cwd,executions,bodies}=await setup("stray");
  expect(agent.getSnapshot().error).toBeUndefined();
  expect(executions).toBe(1);
  expect(await readFile(join(cwd,"count"),"utf8")).toBe("once\n");
  const content=JSON.parse(bodies[1].messages.find((message:any)=>message.role==="tool").content);
  expect(content.status).toBe("done");
  expect(content.requested.second.output.stdout).toBe("second");
  expect(content.repairs).toEqual(["/second: moved into /nodes; the nodes map was closed before this definition. Send the corrected shape next time."]);
});

test("arguments delivered whole in arbitrary key order run as one validated graph", async () => {
  const cwd = await mkdtemp(join(tmpdir(),"jev-stream-planner-")); dirs.push(cwd);
  // Gemini's shape: an empty fragment, then the finished call re-serialized with shuffled keys,
  // settings after nodes, a node before its dependencies, and an unset optional field as null.
  const args = JSON.stringify({
    returns:["summarize","chart","commit"],
    nodes:{
      commit:{when:null,needs:["report","chart"],type:"bash",script:"cat report chart > commit; printf committed"},
      report:{needs:["summarize"],type:"bash",script:"cat summary > report"},
      summarize:{type:"bash",script:"printf summary > summary"},
      chart:{needs:["summarize"],type:"bash",script:"cat summary > chart"},
    },
    limits:{maxJevCalls:0}, version:1, label:"Publish and commit",
  });
  const bodies: any[] = [];
  let executions = 0;
  globalThis.fetch = (async (_input:unknown,init?:RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    if (bodies.length > 1) return new Response(new Uint8Array([
      ...encode({choices:[{delta:{content:"Finished."},finish_reason:"stop"}]}),...encode("[DONE]"),
    ]));
    return new Response(new Uint8Array([
      ...encode({choices:[{delta:{tool_calls:[{index:0,id:"call-whole",type:"function",function:{name:"execute_graph",arguments:""}}]}}]}),
      ...encode({choices:[{delta:{tool_calls:[{index:0,function:{arguments:args}}]},finish_reason:"tool_calls"}]}),
      ...encode("[DONE]"),
    ]));
  }) as unknown as typeof fetch;
  const agent = new GraphAgentController({cwd,sessionId:"whole",model:"test/model",apiKey:"fixture",toolSchema:graphSchema,
    supportsStreaming:true,getPluginCatalog:async()=>"",execute:async(graph,signal,onEvent,streaming)=>{
      executions++;
      return executeGraph(graph,{cwd,signal,...streaming,onEvent});
    },
  });
  await agent.ready();
  await agent.submit("Publish the report");

  expect(agent.getSnapshot().error).toBeUndefined();
  expect(executions).toBe(1);
  expect(await readFile(join(cwd,"commit"),"utf8")).toBe("summarysummary");
  const events = agent.getSnapshot().events;
  expect(new Set(events.map(event=>event.graphId)).size).toBe(1);
  expect(events.find(event=>event.type==="graph.building.finished")?.data.status).toBe("ready");
  const content = JSON.parse(bodies[1].messages.find((message:any)=>message.role==="tool").content);
  expect(content.status).toBe("done");
  expect(content.requested.commit.output.stdout).toBe("committed");
  expect(content.repairs).toEqual(["/nodes/commit/when: dropped null; leave out optional fields that are not set. Send the corrected shape next time."]);
});
