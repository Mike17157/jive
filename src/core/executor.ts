import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { join, resolve as pathResolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { dependencies, validateGraph } from "./schema";
import { resolve, evaluate } from "./expressions";
import { runCommand } from "./process";
import { ExtractorRegistry } from "../plugins/registry";
import { JevAnswerError, JevClient, validateAnswer, validateQuestions } from "../jev/client";
import type { ExecutionEvent, Graph, GraphBody, GraphReport, Group, JevAdapter, JevResponse, Limits, Node, NodeResult } from "./types";

const defaults: Limits = { maxNodes: 300, concurrency: 6, timeoutMs: 300000, maxJevCalls: 100 };
class Semaphore {
  private used = 0;
  private queue: Array<() => void> = [];
  constructor(private capacity: number) {}
  async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.used >= this.capacity) await new Promise<void>((done, reject) => {
      const ready = () => { signal.removeEventListener("abort", abort); done(); };
      const abort = () => { this.queue = this.queue.filter(fn => fn !== ready); reject(signal.reason); };
      this.queue.push(ready); signal.addEventListener("abort", abort, { once: true });
    });
    // A release transfers its slot directly to the queued waiter.
    else this.used++;
    if (signal.aborted) { this.release(); signal.throwIfAborted(); }
    return () => this.release();
  }
  private release() { const next = this.queue.shift(); if (next) next(); else this.used--; }
}
export interface ExecuteOptions {
  cwd: string;
  graphId?: string;
  /** Validated, append-only root snapshots. Headers and existing definitions stay immutable. */
  updates?: AsyncIterable<Graph>;
  artifactRoot?: string;
  jev?: JevAdapter;
  plugins?: ExtractorRegistry;
  signal?: AbortSignal;
  onEvent?: (event: ExecutionEvent) => void;
}
interface ScopeResult { nodes: Record<string, NodeResult>; groups: Record<string, NodeResult>; output?: unknown; status: NodeResult["status"] }
async function nextWithSignal<T>(iterator: AsyncIterator<T>, signal: AbortSignal): Promise<IteratorResult<T>> {
  signal.throwIfAborted();
  let abort!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([iterator.next(), interrupted]); }
  finally { signal.removeEventListener("abort", abort); }
}
export async function executeGraph(input: unknown, options: ExecuteOptions): Promise<GraphReport> {
  validateGraph(input);
  const graph: Graph = structuredClone(input);
  const graphId = options.graphId ?? randomUUID();
  if (!/^[a-zA-Z0-9_-]+$/.test(graphId)) throw new Error("Invalid graph execution ID");
  const directory = join(options.artifactRoot ?? join(options.cwd, ".jev", "runs"), graphId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "graph.json"), JSON.stringify(graph, null, 2));
  const limits = { ...defaults, ...graph.limits };
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(new Error("Graph time budget exhausted")), limits.timeoutMs);
  const semaphore = new Semaphore(limits.concurrency);
  const records = new Map<string, NodeResult>();
  const plugins = options.plugins ?? await ExtractorRegistry.load(options.cwd);
  const jev = options.jev ?? new JevClient();
  let sequence = 0, totalNodes = 0, jevCalls = 0;
  let stoppingReason: string | undefined;
  const emit = (type: ExecutionEvent["type"], data: Record<string, unknown>, nodeId?: string) => {
    const event: ExecutionEvent = { sequence: ++sequence, time: Date.now(), graphId, type, nodeId, data };
    appendFileSync(join(directory, "events.jsonl"), JSON.stringify(event) + "\n");
    options.onEvent?.(event);
  };
  const stop = (reason: string) => { stoppingReason ??= reason; controller.abort(new Error(reason)); };
  const save = async (result: NodeResult) => {
    result.finishedAt = Date.now();
    result.artifact = join(directory, `result-${encodeURIComponent(result.id)}.json`);
    await writeFile(result.artifact, JSON.stringify(result, null, 2));
    emit("node.finished", { result }, result.id);
  };
  const childStatus = (results: NodeResult[]): NodeResult["status"] => {
    if (results.some(r => r.status === "yielded")) return "yielded";
    if (results.some(r => r.status === "cancelled")) return "cancelled";
    if (results.some(r => ["failed", "blocked", "exhausted"].includes(r.status))) return "failed";
    return "done";
  };
  async function scopeRun(body: GraphBody, prefix: string, variables: Record<string, unknown>, updates?: AsyncIterable<Graph>): Promise<ScopeResult> {
    const entries: Record<string, Node | Group> = Object.create(null);
    const nodes: Record<string, NodeResult> = Object.create(null), groups: Record<string, NodeResult> = Object.create(null);
    const scope = { context: graph.context ?? {}, ...variables, nodes, groups };
    function register(definitions: Record<string, Node | Group>) {
    for (const [key, definition] of Object.entries(definitions)) {
      if (Object.hasOwn(entries, key)) continue;
      if (++totalNodes > limits.maxNodes) { stop(`Graph node budget (${limits.maxNodes}) exhausted`); throw new Error(stoppingReason); }
      entries[key] = definition;
      const id = prefix + key;
      const record: NodeResult = { id, label: definition.label ?? key, type: "type" in definition ? definition.type : definition.kind, status: "pending" };
      ("type" in definition ? nodes : groups)[key] = record;
      records.set(id, record);
      emit("node.created", { id, label: record.label, type: record.type, needs: dependencies(definition).map(dep => prefix + dep), parent: prefix ? prefix.replace(/\[\d+\]\/$/, "") : undefined }, id);
    }
    }
    const tasks = new Map<string, Promise<void>>();
    const schedule = (key: string): Promise<void> => {
      if (tasks.has(key)) return tasks.get(key)!;
      const def = entries[key]!, result = nodes[key] ?? groups[key]!;
      const task = (async () => {
        const deps = dependencies(def);
        await Promise.all(deps.map(async dep => {
          await schedule(dep);
          const source = nodes[dep] ?? groups[dep]!;
          if (source.status === "done") emit("edge.ready", { from: source.id, to: result.id }, result.id);
        }));
        try {
          if (signal.aborted) { result.status = "cancelled"; result.error = String(signal.reason ?? "Interrupted"); return; }
          const dependencyResults = deps.map(dep => nodes[dep] ?? groups[dep]!);
          if (!def.allowFailedDependencies && dependencyResults.some(r => r.status !== "done")) {
            result.status = "blocked"; result.error = "A required dependency did not complete"; return;
          }
          if (def.when && !evaluate(def.when, scope)) { result.status = "skipped"; return; }
          if ("type" in def) await leaf(def, result, scope);
          else {
            result.status = "running"; result.startedAt = Date.now();
            emit("node.started", { label: result.label, type: result.type }, result.id);
            await group(def, result, scope);
          }
          if (result.status === "running") result.status = "done";
        } catch (error) {
          if (error && typeof error === "object" && "commandResult" in error) result.output = error.commandResult;
          result.status = signal.aborted ? "cancelled" : "failed";
          result.error = error instanceof Error ? error.message : String(error);
          if (def.onError === "stop") stop(`${result.id}: ${result.error}`);
        } finally { await save(result); }
      })();
      tasks.set(key, task);
      void task.catch(() => {}); // Errors are collected after the producer finishes.
      return task;
    };
    let inputError: unknown;
    try {
      register({ ...body.nodes, ...body.groups });
      for (const key of Object.keys(entries)) void schedule(key);
      if (updates) {
        const header = (g: Graph) => { const {nodes,groups,returns,...rest}=g; return rest; };
        const originalHeader = header(graph);
        const iterator = updates[Symbol.asyncIterator]();
        try {
          while (!signal.aborted) {
            const next = await nextWithSignal(iterator, signal);
            if (next.done) break;
            const incoming = structuredClone(next.value);
            validateGraph(incoming);
            if (!isDeepStrictEqual(header(incoming), originalHeader)) throw new Error("A streamed graph cannot change its committed header");
            for (const namespace of ["nodes", "groups"] as const) {
              for (const [key, value] of Object.entries(graph[namespace] ?? {})) {
                if (!isDeepStrictEqual(incoming[namespace]?.[key], value)) throw new Error(`A streamed graph cannot change committed ${namespace}/${key}`);
              }
            }
            graph.nodes = incoming.nodes;
            graph.groups = incoming.groups;
            graph.returns = incoming.returns;
            register({ ...graph.nodes, ...graph.groups });
            // Persist the committed program before starting its new effects.
            await writeFile(join(directory, "graph.json"), JSON.stringify(graph, null, 2));
            for (const key of Object.keys(entries)) void schedule(key);
          }
        } finally { void iterator.return?.(); }
      }
    } catch (error) { inputError = error; stop(error instanceof Error ? error.message : String(error)); }
    const settled = await Promise.allSettled(tasks.values());
    if (inputError) throw inputError;
    const failed = settled.find((item): item is PromiseRejectedResult => item.status === "rejected");
    if (failed) throw failed.reason;
    const outcome: ScopeResult = { nodes, groups, status: childStatus([...Object.values(nodes), ...Object.values(groups)]) };
    if (body.output !== undefined && outcome.status === "done") outcome.output = resolve(body.output, scope);
    return outcome;
  }
  async function leaf(def: Node, result: NodeResult, scope: Record<string, unknown>) {
    const release = await semaphore.acquire(signal);
    try {
      result.status = "running"; result.startedAt = Date.now();
      emit("node.started", { label: result.label, type: result.type }, result.id);
      if (def.type === "bash") {
        const env = Object.fromEntries(Object.entries(def.env ?? {}).map(([name, value]) => {
          const resolved = resolve(value, scope);
          if (typeof resolved !== "string" && typeof resolved !== "number" && typeof resolved !== "boolean") throw new Error(`Environment binding ${name} must resolve to a scalar`);
          return [name, String(resolved)];
        }));
        const stdin = resolve(def.stdin, scope);
        result.output = await runCommand({ script: def.script, cwd: def.cwd ? pathResolve(options.cwd, def.cwd) : options.cwd, env,
          stdin: stdin === undefined ? undefined : typeof stdin === "string" ? stdin : JSON.stringify(stdin), signal, timeoutMs: def.timeoutMs,
          outputPrefix: join(directory, `command-${encodeURIComponent(result.id)}`),
          onOutput: (stream, chunk) => emit("node.output", { stream, chunk: chunk.slice(0, 4000), omittedCharacters: Math.max(0, chunk.length - 4000) }, result.id),
        });
        if (!(def.acceptedExitCodes ?? [0]).includes((result.output as any).exitCode)) throw new Error(`Command exited with ${(result.output as any).exitCode}`);
        if (def.outputFormat === "json") {
          const output = result.output as any;
          if (output.stdoutTruncated) throw new Error("JSON output exceeds inline capture size; narrow the producer output");
          output.json = JSON.parse(output.stdout);
        }
      } else {
        const prepared: Record<string, unknown> = Object.create(null);
        const local = { ...scope, prepared };
        for (const step of def.prepare ?? []) {
          prepared[step.as] = await plugins.run(step.use, resolve(step.input, local), resolve(step.config, local), {
            cwd: options.cwd, signal, artifactDir: directory, onActivity: data => emit("plugin.activity", data, result.id),
          });
        }
        const request = { state: resolve(def.state, local), questions: resolve(def.questions, local) };
        validateQuestions(request.questions);
        if (++jevCalls > limits.maxJevCalls) { stop(`Jev request budget (${limits.maxJevCalls}) exhausted`); throw new Error(stoppingReason); }
        // Estimates, not a provider tokenizer. Both documented limits are checked.
        const stateEstimate = JSON.stringify(request.state).length / 3;
        const questionEstimates = Object.values(request.questions).map(q => JSON.stringify(q).length / 3);
        if (stateEstimate + Math.max(...questionEstimates) > 32000 || stateEstimate + questionEstimates.reduce((a,b)=>a+b,0) > 64000) throw new Error("Estimated Jev input exceeds its 32k per-question or 64k request budget; narrow or split the evidence");
        emit("jev.request", { ...request, estimatedStateTokens: Math.ceil(stateEstimate) }, result.id);
        let answer: JevResponse;
        try {
          answer = await jev.evaluate(request, signal);
          validateAnswer(request, answer);
        } catch (error) {
          // A refused answer is still evidence: log the raw payload instead of only the verdict.
          if (error instanceof JevAnswerError) emit("jev.response", { ...(error.payload as Record<string, unknown> ?? {}), rejected: error.message }, result.id);
          throw error;
        }
        emit("jev.response", { ...answer }, result.id);
        const answersScope = { ...local, answers: answer.answers };
        result.output = { ...answer, prepared };
        if (def.accept && !evaluate(def.accept, answersScope)) { result.status = "yielded"; result.error = "Jev decision did not meet acceptance criteria"; return; }
        const selected: Record<string, unknown> = Object.create(null);
        for (const [name, selection] of Object.entries(def.select ?? {})) {
          const from = resolve(selection.from, answersScope), key = resolve(selection.key, answersScope);
          if (from == null || typeof from !== "object" || typeof key !== "string" || !Object.hasOwn(from, key)) throw new Error(`Cannot resolve selected candidate ${String(key)}`);
          selected[name] = from[key];
        }
        result.output = { ...answer, prepared, selected };
      }
    } finally { release(); }
  }
  async function group(def: Group, result: NodeResult, scope: Record<string, unknown>) {
    const body = graph.templates![def.template]!;
    if (def.kind === "foreach") {
      const items = resolve(def.items, scope);
      if (!Array.isArray(items)) throw new Error("foreach items must resolve to an array");
      if (items.length > def.maxItems) throw new Error(`Expansion has ${items.length} items, exceeding maxItems=${def.maxItems}`);
      const outputs = new Array<ScopeResult>(items.length);
      let next = 0;
      const workers = await Promise.allSettled(Array.from({ length: Math.min(items.length, def.concurrency ?? limits.concurrency) }, async () => {
        while (next < items.length && !signal.aborted) {
          const index = next++, item = items[index];
          const input = def.input === undefined ? item : resolve(def.input, { ...scope, item, index });
          outputs[index] = await scopeRun(body, `${result.id}[${index}]/`, { input, item, index });
        }
      }));
      const finished = outputs.filter(Boolean);
      result.output = { items: outputs.map((value, index) => ({ index, ...value })), total: items.length, completed: finished.length, failed: finished.filter(o => o.status === "failed").length };
      const failedWorker = workers.find((worker): worker is PromiseRejectedResult => worker.status === "rejected");
      if (failedWorker) throw failedWorker.reason;
      // onItemFailure:"continue" keeps failed items as records the merge node can skip; yields and cancellation still propagate.
      const tolerated = def.onItemFailure === "continue";
      result.status = signal.aborted ? "cancelled" : childStatus(finished.map((o, i) => ({ id: String(i), label: String(i), type: "foreach", status: tolerated && o.status === "failed" ? "done" : o.status })));
    } else {
      let state = resolve(def.initial, scope);
      const iterations: ScopeResult[] = [];
      for (let index = 0; index < def.maxIterations; index++) {
        signal.throwIfAborted();
        const iteration = await scopeRun(body, `${result.id}[${index}]/`, { state, input: state, index });
        iterations.push(iteration);
        result.output = { iterations, state, output: iteration.output };
        if (iteration.status !== "done") { result.status = iteration.status; return; }
        const iterationScope = { context: graph.context ?? {}, state, input: state, index, nodes: iteration.nodes, groups: iteration.groups, output: iteration.output };
        if (evaluate(def.until, iterationScope)) return;
        state = resolve(def.next, iterationScope);
      }
      result.status = "exhausted"; result.error = `Loop reached maxIterations=${def.maxIterations}`;
    }
  }
  emit("graph.started", { label: graph.label, limits });
  let outcome: ScopeResult | undefined;
  try { outcome = await scopeRun(graph, "", {}, options.updates); }
  catch (error) { stoppingReason ??= error instanceof Error ? error.message : String(error); }
  finally { clearTimeout(timer); }
  const list = [...records.values()];
  for (const record of list) if (record.status === "pending" || record.status === "running") { record.status = "cancelled"; record.error = stoppingReason ?? "Graph interrupted"; await save(record); }
  const requested = Object.fromEntries((graph.returns ?? []).map(id => [id, records.get(id)!]).filter(([, result]) => result));
  const status: GraphReport["status"] = signal.aborted ? "cancelled" : list.some(r => r.status === "yielded") ? "yielded" : stoppingReason || outcome?.status !== "done" ? "partial" : "done";
  const report: GraphReport = {
    graphId, label: graph.label, status,
    // Tolerated item failures leave errors in the records of a graph that still completed.
    reason: stoppingReason ?? (signal.aborted ? String(signal.reason) : status === "done" ? undefined : list.find(r => r.error)?.error),
    previews: list.map(r => ({ id: r.id, type: r.type, status: r.status, preview: (r.error ?? JSON.stringify(r.output) ?? "").slice(0, 300), artifact: r.artifact })),
    requested, recordPath: directory,
  };
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2));
  emit("graph.finished", { report });
  return report;
}
