import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { createTestRenderer } from "@opentui/core/testing";
import type { TestRendererSetup } from "@opentui/core/testing";
import type { AgentController, AgentSnapshot, ExecutionEvent } from "../src/core/types.ts";
import { App, runWithRenderer } from "../src/ui/app.tsx";
import { COMMANDS, filterCommands, parseComposerInput, slashQuery } from "../src/ui/commands.ts";
import { EDGE_SWEEP_MS_PER_CELL, edgeCellState, layoutGraph, layoutToText, sweepActive, visibleRows } from "../src/ui/graph/layout.ts";
import { countStatuses, edgeReady, reduceGraphs, statusTone, type UIExecutionEvent } from "../src/ui/graph/model.ts";
import { orbSize, orbToString, renderOrb } from "../src/ui/orb.ts";

// ---------------------------------------------------------------------------
// Fixtures

function eventFactory(graphId = "g1", baseTime = 1_000_000) {
  let seq = 0;
  return (type: ExecutionEvent["type"], nodeId: string | undefined, data: Record<string, unknown>, time?: number): ExecutionEvent => {
    seq += 1;
    return { sequence: seq, time: time ?? baseTime + seq * 10, graphId, type, nodeId, data };
  };
}

/** A join (pick needs scan+grep), a foreach group with children, and a downstream join on the group. */
function sampleEvents(): ExecutionEvent[] {
  const ev = eventFactory();
  return [
    ev("graph.started", undefined, { label: "investigate expiry" }),
    ev("node.created", "scan", { label: "scan repo", type: "bash", needs: [] }),
    ev("node.created", "grep", { label: "grep tests", type: "bash", needs: [] }),
    ev("node.created", "pick", { label: "pick file", type: "jev", needs: ["scan", "grep"] }),
    ev("node.created", "loop", { label: "per file", type: "foreach", needs: ["pick"] }),
    ev("node.created", "loop/0/read", { label: "read a.ts", type: "bash", needs: ["pick"], parent: "loop" }),
    ev("node.created", "loop/1/read", { label: "read b.ts", type: "bash", needs: ["pick"], parent: "loop" }),
    ev("node.created", "verify", { label: "verify", type: "bash", needs: ["loop", "scan"] }),
    ev("node.started", "scan", { label: "scan repo", type: "bash" }),
    ev("node.started", "grep", { type: "bash" }),
    ev("node.output", "scan", { chunk: "src/a.ts\n" }),
    ev("node.output", "scan", { chunk: "src/b.ts\n" }),
    ev("node.finished", "scan", { result: { id: "scan", label: "scan repo", type: "bash", status: "done", output: { stdout: "src/a.ts\nsrc/b.ts\n", exitCode: 0 }, artifact: ".jev/artifacts/scan.json" } }),
    ev("edge.ready", undefined, { from: "scan", to: "pick" }),
    ev("edge.ready", undefined, { from: "scan", to: "verify" }),
    ev("node.finished", "grep", { result: { id: "grep", label: "grep tests", type: "bash", status: "failed", error: "exit 2: no matches" } }),
    ev("node.finished", "pick", { result: { id: "pick", label: "pick file", type: "jev", status: "blocked" } }),
  ];
}

function jevEvents(): ExecutionEvent[] {
  const ev = eventFactory("g2");
  return [
    ev("graph.started", undefined, { label: "decide" }),
    ev("node.created", "judge", { label: "judge candidate", type: "jev", needs: [] }),
    ev("node.started", "judge", { type: "jev" }),
    ev("jev.request", "judge", { model: "jev-1.13.0", state: { observation: { test: "refreshes an expired session" } }, questions: { pick: { type: "choice", instructions: "Select the file", choices: ["a", "b", "none"] } } }),
    ev("jev.response", "judge", { model: "jev-1.13.0", answers: { pick: { choice: "a", probability: 0.8 } } }),
    ev("node.finished", "judge", { result: { id: "judge", label: "judge candidate", type: "jev", status: "yielded", output: { pick: "a" } } }),
    ev("graph.finished", undefined, { status: "yielded", reason: "acceptance criteria not met" }),
  ];
}

/** Streaming construction preview followed by the real run, sharing graphId "g3". */
function previewEvents(base = 1_000_000): UIExecutionEvent[] {
  let seq = 0;
  const ev = (type: UIExecutionEvent["type"], nodeId: string | undefined, data: Record<string, unknown>): UIExecutionEvent => {
    seq += 1;
    return { sequence: seq, time: base + seq * 10, graphId: "g3", type, nodeId, data };
  };
  return [
    ev("graph.building", undefined, { label: "draft plan" }),
    ev("graph.preview", undefined, { graph: { nodes: { scan: { type: "bash", label: "scan repo", script: "ls" } } } }),
    ev("graph.preview", undefined, {
      graph: {
        nodes: { scan: { type: "bash", label: "scan repo", script: "ls" }, pick: { type: "jev", label: "pick file", needs: ["scan"], state: {}, questions: {} } },
        groups: { loop: { kind: "foreach", label: "per file", needs: ["pick"], items: [], template: "t", maxItems: 3 } },
      },
    }),
  ];
}

function previewRuntimeEvents(base = 1_000_000): UIExecutionEvent[] {
  let seq = 100;
  const ev = (type: UIExecutionEvent["type"], nodeId: string | undefined, data: Record<string, unknown>): UIExecutionEvent => {
    seq += 1;
    return { sequence: seq, time: base + seq * 10, graphId: "g3", type, nodeId, data };
  };
  return [
    ev("graph.building.finished", undefined, { status: "ready" }),
    ev("graph.started", undefined, { label: "draft plan" }),
    ev("node.created", "scan", { label: "scan repo", type: "bash", needs: [] }),
    ev("node.created", "pick", { label: "pick file", type: "jev", needs: ["scan"] }),
    ev("node.created", "loop", { label: "per file", type: "foreach", needs: ["pick"] }),
    ev("node.started", "scan", { type: "bash" }),
  ];
}

/** Events typed as the core union so they fit AgentSnapshot; the reducer accepts both. */
const asCore = (events: UIExecutionEvent[]): ExecutionEvent[] => events as unknown as ExecutionEvent[];

interface MockController extends AgentController {
  calls: string[];
  update(patch: Partial<AgentSnapshot>): void;
}

function makeController(initial: Partial<AgentSnapshot> = {}): MockController {
  let state: AgentSnapshot = {
    messages: [],
    busy: false,
    model: "anthropic/claude-sonnet-5",
    models: [
      { id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5", contextLength: 200_000 },
      { id: "openai/gpt-6-astra", name: "GPT-6 Astra", contextLength: 400_000, reasoningEfforts: ["low", "high"] },
    ],
    events: [],
    sessionId: "sess-1234abcd",
    contextTokens: 1234,
    contextLimit: 200_000,
    cachedTokens: 800,
    ...initial,
  };
  const listeners = new Set<() => void>();
  const calls: string[] = [];
  const notify = () => listeners.forEach((l) => l());
  return {
    calls,
    // A fresh object each call, like a real controller might do.
    getSnapshot: () => ({ ...state, messages: [...state.messages], events: [...state.events] }),
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    submit: async (text) => {
      calls.push(`submit:${text}`);
    },
    interrupt: () => {
      calls.push("interrupt");
    },
    setModel: (id) => {
      calls.push(`model:${id}`);
      state = { ...state, model: id };
      notify();
    },
    pin: (text) => {
      calls.push(`pin:${text}`);
    },
    setEffort: async (effort) => {
      calls.push(`effort:${effort}`);state={...state,effort:effort==="auto"?undefined:effort,error:undefined};notify();
    },
    newSession: async () => {
      calls.push("new");state={...state,sessionId:crypto.randomUUID(),messages:[],events:[],busy:false,error:undefined};notify();
    },
    update: (patch) => {
      state = { ...state, ...patch };
      notify();
    },
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function mount(controller: MockController, width = 90, height = 30, onQuit: () => void = () => {}) {
  const setup = await testRender(<App controller={controller} onQuit={onQuit} />, { width, height, exitOnCtrlC: false });
  // Timers in the app update state outside act(); silence the act() warnings.
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = false;
  // React commits key-driven updates through its own macrotask scheduler, so
  // yield to it before asking the renderer to flush.
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await sleep(8);
      await setup.flush();
    }
  };
  const frame = async () => {
    await settle();
    return setup.captureCharFrame();
  };
  type Key = Parameters<TestRendererSetup["mockInput"]["pressKey"]>[0];
  type Mods = Parameters<TestRendererSetup["mockInput"]["pressKey"]>[1];
  const press = async (key: Key, modifiers?: Mods) => {
    setup.mockInput.pressKey(key, modifiers);
    await settle();
  };
  const arrow = async (direction: "up" | "down" | "left" | "right") => {
    setup.mockInput.pressArrow(direction);
    await settle();
  };
  const enter = async () => {
    setup.mockInput.pressEnter();
    await settle();
  };
  const escape = async () => {
    setup.mockInput.pressEscape();
    // Legacy terminals wait 20 ms to distinguish bare Esc from Alt+key.
    // Let that parser boundary finish before testing the resulting UI state.
    await sleep(22);
    await settle();
  };
  const tab = async () => {
    setup.mockInput.pressTab();
    await settle();
  };
  const type = async (text: string) => {
    await setup.mockInput.typeText(text);
    await settle();
  };
  return { setup, settle, frame, press, arrow, enter, escape, tab, type };
}

// ---------------------------------------------------------------------------
// Pure helpers

describe("reduceGraphs", () => {
  test("derives node status, edges and readiness from events", () => {
    const [g] = reduceGraphs(sampleEvents());
    expect(g).toBeDefined();
    expect(g!.label).toBe("investigate expiry");
    expect(g!.order).toEqual(["scan", "grep", "pick", "loop", "loop/0/read", "loop/1/read", "verify"]);
    expect(g!.nodes.scan!.status).toBe("done");
    expect(g!.nodes.grep!.status).toBe("failed");
    expect(g!.nodes.pick!.status).toBe("blocked");
    expect(g!.nodes.verify!.status).toBe("pending");
    expect(g!.nodes.scan!.artifact).toBe(".jev/artifacts/scan.json");
    expect(g!.nodes.scan!.output).toBe("src/a.ts\nsrc/b.ts\n");
    expect(g!.nodes.grep!.error).toBe("exit 2: no matches");
    expect(g!.nodes["loop/0/read"]!.parent).toBe("loop");
    expect(edgeReady(g!, "scan", "pick")).toBe(true);
    expect(edgeReady(g!, "grep", "pick")).toBe(false);
    expect(edgeReady(g!, "scan", "verify")).toBe(true);
    expect(g!.edges.filter((e) => e.to === "verify").map((e) => e.from).sort()).toEqual(["loop", "scan"]);
    const counts = countStatuses(g!);
    expect(counts).toEqual({ total: 7, done: 1, running: 0, warn: 1, blocked: 1, pending: 4, building: 0 });
  });

  test("keeps the exact jev request and response, and the graph outcome", () => {
    const [g] = reduceGraphs(jevEvents());
    const judge = g!.nodes.judge!;
    expect(judge.status).toBe("yielded");
    expect(judge.jevRequests).toHaveLength(1);
    expect(judge.jevRequests[0]!.data.state).toEqual({ observation: { test: "refreshes an expired session" } });
    expect(judge.jevResponses[0]!.data.answers).toEqual({ pick: { choice: "a", probability: 0.8 } });
    expect(g!.status).toBe("yielded");
    expect(g!.reason).toBe("acceptance criteria not met");
  });

  test("separates graphs and tolerates events for unknown nodes", () => {
    const events = [...sampleEvents(), ...jevEvents()];
    const ev = eventFactory("g1");
    events.push({ ...ev("node.started", "ghost", { type: "bash" }), sequence: 999 });
    const graphs = reduceGraphs(events);
    expect(graphs.map((g) => g.id)).toEqual(["g1", "g2"]);
    expect(graphs[0]!.nodes.ghost!.status).toBe("running");
  });

  test("maps statuses to the design's colour tones", () => {
    expect(statusTone("done")).toBe("done");
    expect(statusTone("failed")).toBe("warn");
    expect(statusTone("yielded")).toBe("warn");
    expect(statusTone("exhausted")).toBe("warn");
    expect(statusTone("blocked")).toBe("blocked");
    expect(statusTone("skipped")).toBe("blocked");
    expect(statusTone("cancelled")).toBe("blocked");
    expect(statusTone("running")).toBe("running");
    expect(statusTone("pending")).toBe("pending");
  });
});

describe("construction previews", () => {
  test("preview nodes are 'building' and runtime events overwrite them without duplicates", () => {
    const [g] = reduceGraphs(previewEvents());
    expect(g!.phase).toBe("building");
    expect(g!.label).toBe("draft plan");
    expect(g!.order).toEqual(["scan", "pick", "loop"]);
    expect(g!.nodes.scan!.status).toBe("building");
    expect(g!.nodes.scan!.revealedAt).toBe(1_000_020);
    expect(g!.nodes.pick!.revealedAt).toBe(1_000_030);
    expect(g!.nodes.loop!.type).toBe("foreach");
    expect(g!.edges.map((e) => `${e.from}>${e.to}`)).toEqual(["scan>pick", "pick>loop"]);
    expect(countStatuses(g!).building).toBe(3);

    const [after] = reduceGraphs([...previewEvents(), ...previewRuntimeEvents()]);
    expect(after!.phase).toBe("running");
    expect(after!.order).toEqual(["scan", "pick", "loop"]);
    expect(after!.nodes.scan!.status).toBe("running");
    expect(after!.nodes.pick!.status).toBe("pending");
    expect(after!.nodes.loop!.status).toBe("pending");
    expect(after!.nodes.scan!.revealedAt).toBe(1_000_020); // reveal time is kept, status is not
    expect(after!.edges).toHaveLength(2);
  });

  test("building.finished records ready, interrupted and failed outcomes", () => {
    const fin = (status: string, error?: string): UIExecutionEvent => ({ sequence: 50, time: 1_000_500, graphId: "g3", type: "graph.building.finished", data: error ? { status, error } : { status } });
    expect(reduceGraphs([...previewEvents(), fin("ready")])[0]!.phase).toBe("ready");
    expect(reduceGraphs([...previewEvents(), fin("interrupted")])[0]!.phase).toBe("interrupted");
    const failed = reduceGraphs([...previewEvents(), fin("failed", "invalid reference /nodes/nope")])[0]!;
    expect(failed.phase).toBe("failed");
    expect(failed.buildError).toBe("invalid reference /nodes/nope");
    expect(statusTone("building")).toBe("building");
  });
});

describe("layoutGraph", () => {
  test("draws joins, branches and folded groups in creation order", () => {
    const [g] = reduceGraphs(sampleEvents());
    const layout = layoutGraph(g!, { expanded: new Set() });
    expect(layout.rows.map((r) => r.id)).toEqual(["scan", "grep", "pick", "loop", "verify"]);
    expect(layout.hidden).toBe(2);
    const text = layoutToText(layout);
    expect(text).toBe(["●   scan repo [done]", "│ ✖ grep tests [failed]", "├─○ pick file [blocked]", "│ ○ ▸ per file [pending]", "○─╯ verify [pending]"].join("\n"));
  });

  test("expanding a group inserts its children without reordering existing rows", () => {
    const [g] = reduceGraphs(sampleEvents());
    const folded = layoutGraph(g!, { expanded: new Set() });
    const open = layoutGraph(g!, { expanded: new Set(["loop"]) });
    expect(open.rows.map((r) => r.id)).toEqual(["scan", "grep", "pick", "loop", "loop/0/read", "loop/1/read", "verify"]);
    expect(open.rows.filter((r) => r.depth === 1).map((r) => r.id)).toEqual(["loop/0/read", "loop/1/read"]);
    // Rows above the group keep their columns.
    for (const id of ["scan", "grep", "pick"]) {
      expect(open.rows.find((r) => r.id === id)!.col).toBe(folded.rows.find((r) => r.id === id)!.col);
    }
    expect(visibleRows(g!, new Set(["loop"])).length).toBe(7);
  });

  test("dynamically created nodes append rows and leave earlier rows in place", () => {
    const events = sampleEvents();
    const before = layoutGraph(reduceGraphs(events)[0]!, { expanded: new Set() });
    const ev = eventFactory();
    const extra = { ...ev("node.created", "report", { label: "report", type: "bash", needs: ["verify"] }), sequence: 500 };
    const after = layoutGraph(reduceGraphs([...events, extra])[0]!, { expanded: new Set() });
    expect(after.rows.map((r) => r.id)).toEqual([...before.rows.map((r) => r.id), "report"]);
    before.rows.forEach((row, i) => expect(after.rows[i]!.col).toBe(row.col));
  });

  test("edge cells sweep green outward from the completed node over time", () => {
    const [g] = reduceGraphs(sampleEvents());
    const layout = layoutGraph(g!, { expanded: new Set() });
    const readyAt = g!.edges.find((e) => e.from === "scan" && e.to === "pick")!.readyAt!;
    const pickRow = layout.rows.find((r) => r.id === "pick")!;
    const corner = pickRow.cells[0]!; // "├" where scan's lane meets pick
    expect(corner.from).toBe("scan");
    expect(corner.dist).toBe(2);
    expect(edgeCellState(g!, corner, readyAt - 1)).toBe("sweeping");
    expect(edgeCellState(g!, corner, readyAt)).toBe("sweeping");
    expect(edgeCellState(g!, corner, readyAt + corner.dist * EDGE_SWEEP_MS_PER_CELL)).toBe("ready");
    // grep failed, so its edge into pick never became ready.
    const grepCell = pickRow.cells[1]!;
    expect(grepCell.kind).toBe("node");
    const grepRow = layout.rows.find((r) => r.id === "grep")!;
    const passThrough = grepRow.cells[0]!;
    expect(passThrough.kind).toBe("pass");
    expect(edgeCellState(g!, passThrough, readyAt + 10_000)).toBe("ready");
    expect(sweepActive(g!, layout, readyAt)).toBe(true);
    expect(sweepActive(g!, layout, readyAt + 60_000)).toBe(false);
    const idle = layoutGraph(reduceGraphs(sampleEvents().filter((e) => e.type !== "edge.ready"))[0]!, { expanded: new Set() });
    expect(edgeCellState(idle.rows[2]!.node && reduceGraphs(sampleEvents().filter((e) => e.type !== "edge.ready"))[0]!, idle.rows[2]!.cells[0]!, readyAt + 60_000)).toBe("idle");
  });
});

describe("parseComposerInput", () => {
  test("recognises commands and plain prompts", () => {
    expect(parseComposerInput("hello world")).toEqual({ kind: "submit", text: "hello world" });
    expect(parseComposerInput("   ")).toEqual({ kind: "empty" });
    expect(parseComposerInput("/model")).toEqual({ kind: "model" });
    expect(parseComposerInput("/model openai/gpt-6-astra")).toEqual({ kind: "model", id: "openai/gpt-6-astra" });
    expect(parseComposerInput("/pin keep tests green")).toEqual({ kind: "pin", text: "keep tests green" });
    expect(parseComposerInput("/quit")).toEqual({ kind: "quit" });
    expect(parseComposerInput("/nope")).toEqual({ kind: "unknown", name: "nope" });
    expect(parseComposerInput("/g")).toEqual({ kind: "graph" });
  });

  test("slash popup query and filtering", () => {
    expect(slashQuery("hello")).toBeNull();
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/mo")).toBe("mo");
    expect(slashQuery("/model x")).toBeNull();
    expect(slashQuery("/pin\nmore")).toBeNull();
    expect(filterCommands("").map((c) => c.name)).toEqual(COMMANDS.map((c) => c.name));
    expect(filterCommands("gr").map((c) => c.name)).toEqual(["graph"]);
    expect(filterCommands("q").map((c) => c.name)).toEqual(["quit"]);
    expect(filterCommands("zzz")).toEqual([]);
  });
});

describe("orb", () => {
  test("renders a flower that fits the available space and animates", () => {
    const size = orbSize(80, 20);
    expect(size.width).toBe(size.height * 2 + 1);
    const frame = renderOrb(12, size.width, size.height);
    const lines = orbToString(frame).split("\n");
    expect(lines).toHaveLength(size.height);
    const filled = (line: string) => line.replace(/ /g, "").length;
    expect(filled(lines[Math.floor(size.height / 3)]!)).toBeGreaterThan(filled(lines[0]!));
    expect(orbToString(renderOrb(13.5, size.width, size.height))).not.toBe(orbToString(frame));
    const colours = new Set(frame.rows.flat().map((r) => r.color));
    expect(colours.size).toBeGreaterThan(4); // background plus shaded brightness levels
  });
});

// ---------------------------------------------------------------------------
// Rendered UI

describe("App", () => {
  test("effort slider and shorthand commands apply exact levels", async () => {
    const c=makeController({models:[{id:"anthropic/claude-sonnet-5",name:"Test model",reasoningEfforts:["low","medium","high","xhigh"]}]});
    const {setup,type,enter,frame,press,escape}=await mount(c);
    try{
      await type("/effort");await enter();
      expect(await frame()).toContain("←/→ adjust");
      await press("END");
      expect(await frame()).toContain("xhigh reasoning effort");
      await enter();expect(c.calls).toContain("effort:xhigh");
      await type("/effort high");await enter();expect(c.calls).toContain("effort:high");
      await type("/effort");await enter();await press("HOME");await escape();
      expect(c.getSnapshot().effort).toBe("high");
      await type("/effort auto");await enter();expect(c.getSnapshot().effort).toBeUndefined();
    }finally{setup.renderer.destroy();}
  });

  test("new and clear both replace the session and clear the displayed conversation", async () => {
    const c=makeController({messages:[{id:"old",role:"user",text:"old task"}],events:sampleEvents()});
    const {setup,type,enter,frame}=await mount(c);
    try{
      let session=c.getSnapshot().sessionId;
      await type("/new");await enter();
      expect(c.getSnapshot().sessionId).not.toBe(session);
      expect(await frame()).not.toContain("old task");
      expect(await frame()).not.toContain("scan repo");
      session=c.getSnapshot().sessionId;c.update({messages:[{id:"second",role:"user",text:"second task"}]});
      await type("/clear");await enter();
      expect(c.getSnapshot().sessionId).not.toBe(session);
      expect(await frame()).not.toContain("second task");
      expect(c.calls.filter(call=>call==="new")).toHaveLength(2);
    }finally{setup.renderer.destroy();}
  });

  test("thinking indicators track activity and disappear when the turn ends", async () => {
    const c=makeController({busy:true,phase:"thinking",activityStartedAt:Date.now()-1000});
    const {setup,frame}=await mount(c);
    try{
      expect(await frame()).toContain("Thinking ·");
      c.update({phase:"responding"});expect(await frame()).toContain("Writing ·");
      c.update({busy:false,phase:"idle"});expect(await frame()).not.toContain("Writing ·");
    }finally{setup.renderer.destroy();}
  });

  test("sending a message snaps back to the latest content after scrolling up", async () => {
    const history=Array.from({length:30},(_,index)=>({id:`m${index}`,role:"user" as const,text:`Earlier question ${index}`}));
    const c=makeController({messages:history});
    c.submit=async(text)=>{c.calls.push(`submit:${text}`);c.update({messages:[...history,{id:"newest",role:"user",text}]});};
    const {setup,frame,press,type,enter}=await mount(c,80,24);
    try{
      expect(await frame()).toContain("Earlier question 29");
      for(let i=0;i<8;i++)await press("\u001b[5~");
      expect(await frame()).not.toContain("Earlier question 29");
      await type("My newest question");await enter();
      expect(await frame()).toContain("My newest question");
      expect(await frame()).toContain("Earlier question 29");
    }finally{setup.renderer.destroy();}
  });

  test("planner reasoning stays collapsed to a title that follows the newest paragraph", async () => {
    const c = makeController({
      messages: [
        { id: "u1", role: "user", text: "find the expiry bug" },
        { id: "t1", role: "thinking", text: "**Checking the store**\n\nThe session store is read before any test runs, so the expiry path matters." },
        { id: "a1", role: "assistant", text: "The expiry check runs before the refresh." },
      ],
    });
    const { setup, frame } = await mount(c, 80, 24);
    try {
      let f = await frame();
      expect(f).toContain("▸ The session store is read before any test…");
      expect(f).not.toContain("Checking the store");
      expect(f).not.toContain("expiry path matters");
      expect(f).toContain("The expiry check runs before the refresh.");
      expect(f).toContain("find the expiry bug");
      c.update({ messages: [...c.getSnapshot().messages.map((m) => (m.id === "t1" ? { ...m, text: `${m.text}\n\nNow reading the refresh tests.` } : m))] });
      f = await frame();
      expect(f).toContain("▸ Now reading the refresh tests.");
      expect(f).not.toContain("The session store is read");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("a reply with no text yet leaves no bare marker in the transcript", async () => {
    const c = makeController({
      messages: [
        { id: "u1", role: "user", text: "go" },
        { id: "a1", role: "assistant", text: "" },
      ],
      busy: true,
    });
    const { setup, frame } = await mount(c, 80, 24);
    try {
      expect(await frame()).not.toContain("◆");
      c.update({ messages: [{ id: "u1", role: "user", text: "go" }, { id: "a1", role: "assistant", text: "Done." }] });
      expect(await frame()).toContain("◆ Done.");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("a long message wraps inside the composer card instead of scrolling one row", async () => {
    const c = makeController();
    const { setup, frame, type } = await mount(c, 60, 20);
    try {
      await type("this is a really long message that should wrap onto more than one line in the composer box");
      const lines = (await frame()).split("\n");
      const first = lines.findIndex((l) => l.includes("❯ this is a really long"));
      expect(first).toBeGreaterThan(-1);
      // The continuation sits on the next row, indented under the text, and the
      // card's right border survives: nothing painted over it.
      expect(lines[first + 1]).toContain("composer box");
      expect(lines[first]!.trimEnd()).toMatch(/│$/);
      expect(lines[first + 1]!.trimEnd()).toMatch(/│$/);
      expect(lines[first + 1]).toMatch(/│ {3}\S/);
    } finally {
      setup.renderer.destroy();
    }
  });

  test("empty session shows the orb with the composer pinned at the bottom", async () => {
    const c = makeController();
    const { setup, frame } = await mount(c);
    try {
      const f = await frame();
      const lines = f.split("\n").filter((l) => l.length > 0);
      expect(lines.length).toBe(30);
      // Composer card: side margins of 2, bottom margin row, rounded border,
      // and a blank padding row under the top border.
      expect(lines[29]!.trim()).toBe("");
      expect(lines[28]).toMatch(/^ {2}╰─+╯ {2}$/);
      expect(lines[27]).toContain("Enter sends");
      expect(lines[26]).toContain("│ ❯ Ask, or type / for commands");
      expect(lines[25]).toMatch(/^ {2}│ +│ {2}$/);
      expect(lines[24]).toMatch(/^ {2}╭─+╮ {2}$/);
      expect(lines[23]).toContain("Claude Sonnet 5");
      expect(f).not.toContain("graph · bash · jev");
      expect(f).not.toContain("Describe a task");
      expect(f).toMatch(/[\u2801-\u28ff]{3,}/); // Braille-dot flower
      expect(f).not.toMatch(/[▒▓█▌░╿┃]/); // no block glyphs
    } finally {
      setup.renderer.destroy();
    }
  });

  test("shows messages and graph rows with their states", async () => {
    const c = makeController({
      messages: [
        { id: "m1", role: "user", text: "Find where sessions expire" },
        { id: "m2", role: "assistant", text: "Scanning the repository first." },
      ],
      busy: true,
      events: sampleEvents(),
    });
    const { setup, frame } = await mount(c);
    try {
      const f = await frame();
      const lines = f.split("\n");
      const youLine = lines.find((l) => /│\s+you\s*$/.test(l))!;
      expect(youLine).toBeDefined();
      expect(youLine.indexOf("│")).toBe(3); // left aligned with the conversation padding
      expect(lines.find((l) => l.includes("Find where sessions expire"))).toMatch(/^ {3}│ {2}Find where sessions expire/);
      expect(f).toContain("◆ Scanning the repository first.");
      expect(f).toContain("investigate expiry");
      expect(f).toMatch(/scan repo\s+bash\s+done/);
      expect(f).toMatch(/✖ grep tests\s+bash\s+failed/);
      expect(f).toMatch(/├─○ pick file\s+jev\s+blocked/);
      expect(f).toMatch(/▸ per file \(2\)\s+foreach\s+pending/);
      expect(f).toMatch(/○─╯ verify\s+bash\s+pending/);
      expect(f).toContain("2 folded");
      expect(f).toContain("working… Ctrl+C interrupts");
      expect(f).toContain("⎘"); // artifact marker
    } finally {
      setup.renderer.destroy();
    }
  });

  test("graph focus expands groups and the inspector shows the exact jev request", async () => {
    const c = makeController({ messages: [{ id: "m1", role: "user", text: "go" }], events: [...sampleEvents(), ...jevEvents()] });
    const { setup, frame, press, arrow, enter, escape } = await mount(c);
    try {
      await press("g", { ctrl: true }); // focus the latest graph (g2)
      let f = await frame();
      expect(f).toContain("◆ decide");
      await press("[");
      f = await frame();
      expect(f).toContain("◆ investigate expiry");
      await arrow("down");
      await arrow("down");
      await arrow("down");
      await arrow("right");
      f = await frame();
      expect(f).toContain("▾ per file (2)");
      expect(f).toContain("read a.ts");
      expect(f).toContain("read b.ts");
      expect(f).not.toContain("folded");
      await arrow("left");
      f = await frame();
      expect(f).toContain("▸ per file (2)");
      await press("]");
      await enter();
      f = await frame();
      expect(f).toContain("judge candidate");
      expect(f).toContain("jev request · state");
      expect(f).toContain('"test": "refreshes an expired session"');
      expect(f).toContain("jev request · questions");
      expect(f).toContain('"instructions": "Select the file"');
      expect(f).toContain("yielded");
      for (let i = 0; i < 12; i++) await arrow("down"); // scroll the inspector
      f = await frame();
      expect(f).toContain("jev response · answers");
      expect(f).toContain('"choice": "a"');
      await escape();
      await escape();
      f = await frame();
      expect(f).not.toContain("jev request · state");
      expect(f).toContain("· compose");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("composer submits prompts, commands and handles Ctrl+C", async () => {
    let quit = 0;
    const c = makeController();
    const { setup, settle, frame, press, arrow, enter, type } = await mount(c, 90, 30, () => quit++);
    try {
      await type("hello there");
      await enter();
      expect(c.calls).toEqual(["submit:hello there"]);
      let f = await frame();
      expect(f).toContain("❯ Ask, or type / for commands"); // cleared after submit

      await type("/pin keep tests green");
      await enter();
      expect(c.calls).toContain("pin:keep tests green");

      await type("/model");
      await enter();
      f = await frame();
      expect(f).toContain(" model ");
      expect(f).toContain("Claude Sonnet 5");
      expect(f).toContain("GPT-6 Astra");
      expect(f).toContain("/model <id> for a custom id");
      // Name only: no ids, context sizes or effort levels in the list.
      expect(f).not.toContain("anthropic/claude-sonnet-5");
      expect(f).not.toContain("k ctx");
      await arrow("down");
      await enter();
      expect(c.calls).toContain("model:openai/gpt-6-astra");
      f = await frame();
      expect(f).not.toContain("/model <id> for a custom id");
      expect(f).toContain("GPT-6 Astra");

      // Ctrl+C while busy interrupts; twice while idle quits.
      c.update({ busy: true });
      await press("c", { ctrl: true });
      expect(c.calls).toContain("interrupt");
      expect(quit).toBe(0);
      c.update({ busy: false });
      await settle();
      await press("c", { ctrl: true });
      expect(quit).toBe(0);
      await press("c", { ctrl: true });
      expect(quit).toBe(1);
    } finally {
      setup.renderer.destroy();
    }
  });

  test("narrow terminals keep the graph readable", async () => {
    const c = makeController({ messages: [{ id: "m1", role: "user", text: "go" }], events: sampleEvents() });
    const { setup, frame } = await mount(c, 44, 24);
    try {
      const f = await frame();
      const lines = f.split("\n");
      expect(lines.every((l) => l.length <= 44)).toBe(true);
      expect(f).toContain("scan repo");
      expect(f).toContain("done");
      expect(f).toContain("failed");
      expect(f).not.toMatch(/scan repo\s+bash/); // type column hidden when narrow
      expect(lines.slice(-6).some((l) => l.includes("❯"))).toBe(true);
    } finally {
      setup.renderer.destroy();
    }
  });

  test("runWithRenderer interrupts active work and destroys the renderer on /quit", async () => {
    const setup = await createTestRenderer({ width: 60, height: 16, exitOnCtrlC: false });
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = false;
    const c = makeController({ busy: true });
    let resolved = false;
    const done = runWithRenderer(c, setup.renderer).then(() => {
      resolved = true;
    });
    await sleep(10);
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("❯ Ask, or type / for commands");
    await setup.mockInput.typeText("/quit");
    setup.mockInput.pressEnter();
    await done;
    expect(resolved).toBe(true);
    expect(c.calls).toEqual(["interrupt"]);
    expect(setup.renderer.isDestroyed).toBe(true);
  });

  test("a short history sits at the bottom and grows upward in order", async () => {
    const c = makeController({ messages: [{ id: "m1", role: "user", text: "first question" }] });
    const { setup, frame } = await mount(c, 80, 24);
    try {
      let f = await frame();
      let lines = f.split("\n");
      const q1 = lines.findIndex((l) => l.includes("first question"));
      expect(q1).toBeGreaterThanOrEqual(15); // bottom-aligned above the status bar and composer
      expect(lines.slice(0, 10).every((l) => l.trim() === "")).toBe(true);
      c.update({ messages: [{ id: "m1", role: "user", text: "first question" }, { id: "m2", role: "assistant", text: "first answer" }, { id: "m3", role: "user", text: "second question" }] });
      f = await frame();
      lines = f.split("\n");
      const i1 = lines.findIndex((l) => l.includes("first question"));
      const i2 = lines.findIndex((l) => l.includes("first answer"));
      const i3 = lines.findIndex((l) => l.includes("second question"));
      expect(i1).toBeLessThan(q1); // older content moved up
      expect(i1).toBeLessThan(i2);
      expect(i2).toBeLessThan(i3);
      expect(i3).toBeGreaterThanOrEqual(15);
      expect(lines[i3]!.indexOf("│")).toBe(3);
    } finally {
      setup.renderer.destroy();
    }
  });

  test("slash popup filters, navigates and dispatches commands", async () => {
    let quit = 0;
    const c = makeController();
    const { setup, frame, arrow, enter, escape, tab, type, press } = await mount(c, 90, 30, () => quit++);
    try {
      await type("/");
      let f = await frame();
      for (const spec of COMMANDS) expect(f).toContain(spec.usage);
      expect(f).toMatch(/▸ \/model/);
      await arrow("down");
      f = await frame();
      expect(f).toMatch(/▸ \/graph/);
      await arrow("up");
      await arrow("up");
      f = await frame();
      expect(f).toMatch(/▸ \/model/);
      await escape();
      f = await frame();
      expect(f).not.toContain("/quit ");
      expect(f).toContain("❯ /");
      await type("gr");
      f = await frame();
      expect(f).toContain("/graph");
      expect(f).not.toContain("/model [id]");
      await tab();
      f = await frame();
      expect(f).toContain("❯ /graph ");
      expect(f).not.toContain("browse and inspect");

      // /pin stays editable; nothing is dispatched.
      await press("u", { ctrl: true }); // delete to line start
      await type("/p");
      await enter();
      f = await frame();
      expect(f).toContain("❯ /pin ");
      expect(c.calls).toEqual([]);
      await type("keep tests green");
      await enter();
      expect(c.calls).toEqual(["pin:keep tests green"]);

      // /model opens the picker; /help opens the command list; /quit quits.
      await type("/mo");
      await enter();
      f = await frame();
      expect(f).toContain(" model ");
      expect(f).toContain("GPT-6 Astra");
      await escape();
      await type("/help");
      await enter();
      f = await frame();
      expect(f).toContain(" commands ");
      expect(f).toContain("↑/↓ choose · Enter run");
      for (let i = 0; i < COMMANDS.findIndex(command=>command.name==="quit"); i++) await arrow("down");
      f = await frame();
      expect(f).toMatch(/▸ \/quit/);
      await enter();
      expect(quit).toBe(1);
    } finally {
      setup.renderer.destroy();
    }
  });

  test("streaming previews render as drafted rows and hand over to runtime without duplicates", async () => {
    const c = makeController({ messages: [{ id: "m1", role: "user", text: "plan it" }] });
    const { setup, frame } = await mount(c, 90, 30);
    try {
      const base = Date.now();
      c.update({ events: asCore(previewEvents(base)) });
      let f = await frame();
      expect(f).toContain("draft plan");
      expect(f).toMatch(/assembling\.{0,3}/);
      expect(f).toContain("3 nodes");
      expect(f).toMatch(/scan repo\s+bash\s+drafted/);
      expect(f).toMatch(/pick file\s+jev\s+drafted/);
      expect(f).toMatch(/▸ per file\s+foreach\s+drafted/);
      expect(f).not.toContain("running");
      await sleep(350);
      f = await frame();
      expect(f).toMatch(/◌ scan repo/); // reveal finished: settled glyph
      c.update({ events: asCore([...previewEvents(base), ...previewRuntimeEvents(base)]) });
      f = await frame();
      expect(f).not.toContain("drafted");
      expect(f).not.toContain("assembling");
      expect(f.split("scan repo").length - 1).toBe(1);
      expect(f.split("pick file").length - 1).toBe(1);
      expect(f.split("per file").length - 1).toBe(1);
      expect(f).toMatch(/scan repo\s+bash\s+running/);
      expect(f).toMatch(/pick file\s+jev\s+pending/);
      expect(f).toContain("1 running");
      // A failed assembly reports its error instead of pretending to execute.
      const failed: UIExecutionEvent = { sequence: 60, time: base + 900, graphId: "g3", type: "graph.building.finished", data: { status: "failed", error: "cycle detected" } };
      c.update({ events: asCore([...previewEvents(base), failed]) });
      f = await frame();
      expect(f).toContain("assembly failed · cycle detected");
      expect(f).not.toContain("running");
    } finally {
      setup.renderer.destroy();
    }
  });
});
