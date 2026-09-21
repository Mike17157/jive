import { expect, test } from "bun:test";
import type { ExecutionEvent } from "../src/core/types";
import { reduceGraphs } from "../src/ui/graph/model";
import { phaseCaption } from "../src/ui/components/GraphView";

test("graph construction stays visible while committed nodes are already running", () => {
  const events: ExecutionEvent[] = [
    {sequence:1,time:1,graphId:"g",type:"graph.building",data:{label:"Building"}},
    {sequence:2,time:2,graphId:"g",type:"graph.preview",data:{graph:{nodes:{
      first:{type:"bash",script:"true"},second:{type:"bash",stdin:{$ref:"/nodes/first/output/stdout"},script:"cat"},
    }}}},
    {sequence:3,time:3,graphId:"g",type:"graph.started",data:{}},
    {sequence:4,time:4,graphId:"g",type:"node.started",nodeId:"first",data:{}},
  ];
  let graph=reduceGraphs(events)[0]!;
  expect(graph.nodes.first?.status).toBe("running");
  expect(graph.nodes.second?.status).toBe("building");
  expect(graph.edges).toEqual([{from:"first",to:"second"}]);
  expect(graph.building).toBe(true);
  expect(phaseCaption(graph)).toBeNull();
  graph=reduceGraphs([...events,{sequence:5,time:5,graphId:"g",type:"graph.building.finished",data:{status:"interrupted"}}])[0]!;
  expect(graph.building).toBe(false);
  expect(graph.nodes.second?.status).toBe("cancelled");
});
