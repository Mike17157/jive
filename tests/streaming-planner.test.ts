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

async function setup(mode:"success"|"truncated"|"renamed") {
  const cwd = await mkdtemp(join(tmpdir(),"jev-stream-planner-")); dirs.push(cwd);
  let finishWriter!: () => void;
  let writerFinished = false, earlyFinished = false, executions = 0, fetches = 0;
  const bodies: any[] = [];
  const first = JSON.stringify({type:"bash",script:"echo once >> count; printf first"});
  const second = JSON.stringify({type:"bash",needs:["first"],script:"printf second"});
  const prefix = `{"eager":true,"version":1,"label":"While writing","context":{},"templates":{},"limits":{},"returns":["first","second"],"nodes":{"first":${first}`;
  const suffix = `,"second":${second}}}`;
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
