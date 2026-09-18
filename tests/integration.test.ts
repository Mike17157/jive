import { expect, test } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgent } from "../src/planner/agent";
import { executeGraph } from "../src/core/executor";
import { graphSchema } from "../src/core/schema";
import { ExtractorRegistry } from "../src/plugins/registry";

test("streamed planner graph executes in the real runtime and returns recorded evidence", async () => {
  const cwd=await mkdtemp(join(tmpdir(),"jev-integration-"));
  const original=globalThis.fetch;let requests=0;const sent:any[]=[];
  const graph={version:1,label:"Inspect fixture",nodes:{source:{type:"bash",script:"printf '%s' 'real execution output'"},copy:{type:"bash",stdin:{$ref:"/nodes/source/output/stdout"},script:"cat"}},returns:["copy"]};
  globalThis.fetch=(async(_url:any,init:any)=>{
    const body=JSON.parse(init.body);sent.push(body);requests++;
    const chunk=requests===1?{choices:[{delta:{tool_calls:[{index:0,id:"graph-call",type:"function",function:{name:"execute_graph",arguments:JSON.stringify(graph)}}]},finish_reason:"tool_calls"}]}:{choices:[{delta:{content:"Read the fixture and verified the copied evidence."},finish_reason:"stop"}]};
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,{headers:{"content-type":"text/event-stream"}});
  }) as typeof fetch;
  try{
    const agent=createAgent({cwd,model:"fixture/model",apiKey:"fixture-key",toolSchema:graphSchema,
      getPluginCatalog:async()=>(await ExtractorRegistry.load(cwd)).catalog(),
      execute:(g,signal,onEvent)=>executeGraph(g,{cwd,signal,onEvent}),
    });
    await agent.submit("Inspect the fixture");
    expect(requests).toBe(2);expect(agent.getSnapshot().error).toBeUndefined();
    expect(sent[0].tools.map((tool:any)=>tool.function.name)).toEqual(["execute_graph","execute_graph_mod"]);
    const tool=sent[1].messages.find((message:any)=>message.role==="tool");
    const report=JSON.parse(tool.content);
    expect(report.requested.copy.output.stdout).toBe("real execution output");
    expect(agent.getSnapshot().events.at(-1)?.type).toBe("graph.finished");
    const archive=await readFile(join(cwd,".jev/sessions",agent.getSnapshot().sessionId,"session.jsonl"),"utf8");
    expect(archive).toContain("real execution output");expect(archive).toContain("graph.finished");
  }finally{globalThis.fetch=original;await rm(cwd,{recursive:true,force:true});}
});
