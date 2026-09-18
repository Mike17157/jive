import { createCliRenderer, type CliRenderer, type KeyEvent, type ScrollBoxRenderable, type TextareaRenderable } from "@opentui/core";
import { createRoot, useKeyboard, useTerminalDimensions, useRenderer } from "@opentui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentController } from "../core/types.ts";
import { COMMANDS, filterCommands, parseComposerInput, slashQuery, type CommandSpec, type ComposerCommand } from "./commands.ts";
import { CommandPopup } from "./components/CommandPopup.tsx";
import { Composer, COMPOSER_CHROME_ROWS } from "./components/Composer.tsx";
import { Conversation, type GraphPlacement } from "./components/Conversation.tsx";
import { Inspector } from "./components/Inspector.tsx";
import { ModelPicker } from "./components/ModelPicker.tsx";
import { Orb } from "./components/Orb.tsx";
import { StatusBar } from "./components/StatusBar.tsx";
import { EffortPicker, EFFORT_PANEL_ROWS } from "./components/EffortPicker.tsx";
import { ThinkingIndicator } from "./components/ThinkingIndicator.tsx";
import { attachSelectionCopy } from "./clipboard.ts";
import { foldableIds, layoutGraph, type LayoutRow } from "./graph/layout.ts";
import { reduceGraphs, type GraphModel } from "./graph/model.ts";
import { palette } from "./theme.ts";
import { useAgentSnapshot } from "./useController.ts";

export type UIMode = "compose" | "graph" | "inspect" | "model" | "effort";

const QUIT_WINDOW_MS = 1500;

/**
 * State plus a ref mirror. The keyboard handler reads the ref so that several
 * key events delivered before React re-renders still see the latest value.
 */
function useStateRef<T>(initial: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void, { current: T }] {
  const [value, setValue] = useState<T>(initial);
  const ref = useRef<T>(value);
  const set = useCallback((next: T | ((prev: T) => T)) => {
    const resolved = typeof next === "function" ? (next as (prev: T) => T)(ref.current) : next;
    ref.current = resolved;
    setValue(resolved);
  }, []);
  return [value, set, ref];
}

export interface AppProps {
  controller: AgentController;
  onQuit: () => void;
}

export function App(props: AppProps) {
  const { controller } = props;
  const renderer = useRenderer();
  const snapshot = useAgentSnapshot(controller);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const { width, height } = useTerminalDimensions();
  const graphs = useMemo(() => reduceGraphs(snapshot.events), [snapshot.events]);

  const [mode, setModeState, modeRef] = useStateRef<UIMode>("compose");
  const [expanded, setExpanded, expandedRef] = useStateRef<ReadonlySet<string>>(() => new Set());
  const [folded, setFolded, foldedRef] = useStateRef<ReadonlySet<string>>(() => new Set());
  const [graphCursor, setGraphCursor, graphCursorRef] = useStateRef(0);
  const [rowCursor, setRowCursor, rowCursorRef] = useStateRef(0);
  const [notice, setNotice] = useState<string | undefined>();
  const [effortLoading,setEffortLoading]=useState(false);
  const [effortError,setEffortError]=useState<string>();
  const [composerText, setComposerText, composerTextRef] = useStateRef("");
  const [composerLines, setComposerLines] = useState(1);
  const [popupCursor, setPopupCursor, popupCursorRef] = useStateRef(0);
  const [helpOpen, setHelpOpen, helpOpenRef] = useStateRef(false);
  const [thinkingOpen, setThinkingOpen, thinkingOpenRef] = useStateRef(false);
  const [dismissedQuery, setDismissedQuery, dismissedQueryRef] = useStateRef<string | null>(null);
  const lastCtrlC = useRef(0);
  const textareaRef = useRef<TextareaRenderable | null>(null);
  const setMode = useCallback((next:UIMode)=>{
    setModeState(next);
    // Restore native input focus immediately, before the next React commit.
    // Otherwise a fast keystroke after dismissing a selector can be lost.
    if(next==="compose")textareaRef.current?.focus();
  },[setModeState]);
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const anchors = useRef<Map<string, number>>(new Map());
  const initialised = useRef(false);
  const anchorSession = useRef(snapshot.sessionId);

  useEffect(()=>attachSelectionCopy(renderer,setNotice),[renderer]);

  // Place each graph relative to the conversation the first time it appears.
  const placements = useMemo<GraphPlacement[]>(() => {
    if(anchorSession.current!==snapshot.sessionId){anchors.current.clear();initialised.current=false;anchorSession.current=snapshot.sessionId;}
    const msgs = snapshot.messages;
    const firstLoad = !initialised.current;
    for (const g of graphs) {
      if (!anchors.current.has(g.id)) {
        let anchor = msgs.length;
        if (firstLoad) {
          let lastUser = -1;
          msgs.forEach((m, i) => {
            if (m.role === "user") lastUser = i;
          });
          anchor = lastUser + 1;
        }
        anchors.current.set(g.id, anchor);
      }
    }
    initialised.current = true;
    return graphs.map((g, index) => ({ graph: g, anchor: anchors.current.get(g.id) ?? msgs.length, index }));
  }, [graphs, snapshot.messages, snapshot.sessionId]);

  const focusedGraph: GraphModel | null = mode === "graph" || mode === "inspect" ? (graphs[Math.min(graphCursor, graphs.length - 1)] ?? null) : null;
  const focusedLayout = useMemo(() => (focusedGraph ? layoutGraph(focusedGraph, { expanded, folded }) : null), [focusedGraph, expanded, folded]);
  const selectedRow = focusedLayout ? focusedLayout.rows[Math.min(rowCursor, focusedLayout.rows.length - 1)] : undefined;

  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(undefined), 4000);
    return () => clearTimeout(id);
  }, [notice]);

  const messages = snapshot.messages;

  // Slash-command popup: derived from the composer text, or forced open by /help.
  const query = slashQuery(composerText);
  const popupVisible = mode === "compose" && (helpOpen || (query !== null && dismissedQuery !== composerText));
  const popupCommands = useMemo<CommandSpec[]>(() => (helpOpen ? [...COMMANDS] : query !== null ? filterCommands(query) : []), [helpOpen, query]);
  const popupRows = popupVisible ? Math.max(1, popupCommands.length) + 3 : 0;
  const onComposerText = useCallback(
    (text: string) => {
      setComposerText(text);
      setPopupCursor(0);
      if (dismissedQueryRef.current !== null && dismissedQueryRef.current !== text) setDismissedQuery(null);
    },
    [setComposerText, setPopupCursor, setDismissedQuery, dismissedQueryRef],
  );

  const enterGraphMode = useCallback(() => {
    if (graphs.length === 0) {
      setNotice("no graph to inspect yet");
      return;
    }
    setGraphCursor(graphs.length - 1);
    setRowCursor(0);
    setMode("graph");
  }, [graphs.length]);

  const dispatch = useCallback(
    (cmd: ComposerCommand) => {
      switch (cmd.kind) {
        case "new":
        case "clear":
          void controller.newSession().then(()=>{
            setMode("compose");setExpanded(new Set());setFolded(new Set());setGraphCursor(0);setRowCursor(0);
            setHelpOpen(false);setDismissedQuery(null);setNotice("New session");
          }).catch(error=>setNotice(`Could not start session: ${String(error)}`));
          return;
        case "effort":
          if(cmd.level){
            void controller.setEffort(cmd.level).then(()=>{
              if(!controller.getSnapshot().error)setNotice(`effort → ${controller.getSnapshot().effort??"auto"}`);
            }).catch(error=>setNotice(String(error)));
          }else{
            setEffortError(undefined);setMode("effort");
            const model=controller.getSnapshot().models.find(model=>model.id===controller.getSnapshot().model);
            if(model?.reasoningEfforts===undefined&&controller.refreshModels){
              setEffortLoading(true);
              void controller.refreshModels(AbortSignal.timeout(10000)).catch(error=>setEffortError(String(error))).finally(()=>setEffortLoading(false));
            }
          }
          return;
        case "empty":
          return;
        case "submit":
          // Re-engage sticky-bottom before new content changes the layout.
          scrollRef.current?.scrollTo(scrollRef.current.scrollHeight);
          void controller.submit(cmd.text).catch((err) => setNotice(`submit failed: ${String(err)}`));
          return;
        case "model":
          if (cmd.id) {
            controller.setModel(cmd.id);
            setNotice(`model → ${cmd.id}`);
          } else {
            setMode("model");
          }
          return;
        case "pin":
          controller.pin(cmd.text);
          setNotice("pinned");
          return;
        case "quit":
          props.onQuit();
          return;
        case "help":
          setHelpOpen(true);
          setPopupCursor(0);
          return;
        case "graph":
          enterGraphMode();
          return;
        case "unknown":
          setNotice(`unknown command /${cmd.name} — try /help`);
          return;
      }
    },
    [controller, props, enterGraphMode, setHelpOpen, setPopupCursor],
  );

  const setComposer = useCallback(
    (text: string) => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.setText(text);
      ta.gotoBufferEnd();
      onComposerText(text);
    },
    [onComposerText],
  );

  /** Run the popup's highlighted command, or leave it in the composer for editing. */
  const selectPopupCommand = useCallback(
    (spec: CommandSpec, complete: boolean) => {
      if (spec.select === "edit" || complete) {
        setHelpOpen(false);
        setComposer(`/${spec.name} `);
        return;
      }
      setHelpOpen(false);
      setComposer("");
      dispatch(parseComposerInput(`/${spec.name}`));
    },
    [dispatch, setComposer, setHelpOpen],
  );

  const submit = useCallback(() => {
    const ta = textareaRef.current;
    const raw = ta?.plainText ?? "";
    const cmd = parseComposerInput(raw);
    if (cmd.kind === "empty") return;
    setComposer("");
    dispatch(cmd);
  }, [dispatch, setComposer]);

  const latestUserId=snapshot.messages.findLast(message=>message.role==="user")?.id;
  useEffect(()=>{
    if(!latestUserId)return;
    scrollRef.current?.scrollTo(scrollRef.current.scrollHeight);
  },[latestUserId]);

  // Groups open by default and finished iterations fold by default, so a toggle records an
  // explicit choice in whichever set overrides the row's current state.
  const toggleFold = useCallback(
    (row: LayoutRow) => {
      const without = (prev: ReadonlySet<string>) => {
        const next = new Set(prev);
        next.delete(row.id);
        return next;
      };
      const withId = (prev: ReadonlySet<string>) => new Set(prev).add(row.id);
      setExpanded(row.expanded ? without : withId);
      setFolded(row.expanded ? withId : without);
    },
    [],
  );

  useKeyboard((key: KeyEvent) => {
    const consume = () => {
      key.preventDefault();
      key.stopPropagation();
    };
    const mode = modeRef.current;
    const expanded = expandedRef.current;
    const folded = foldedRef.current;
    const rowCursor = rowCursorRef.current;
    const graphCursor = graphCursorRef.current;
    const currentGraph: GraphModel | null = graphs[Math.min(graphCursor, graphs.length - 1)] ?? null;
    const currentLayout = currentGraph ? layoutGraph(currentGraph, { expanded, folded }) : null;
    if (key.ctrl && key.name === "c") {
      consume();
      const now = Date.now();
      // Read through the ref: the controller may have notified between renders.
      if (snapshotRef.current.busy || controller.getSnapshot().busy) {
        controller.interrupt();
        setNotice("interrupt requested · Ctrl+C twice to quit");
        // An interrupt press does not arm the quit window; quitting always needs two idle presses.
        lastCtrlC.current = 0;
        return;
      }
      if (now - lastCtrlC.current < QUIT_WINDOW_MS) {
        props.onQuit();
        return;
      }
      lastCtrlC.current = now;
      setNotice("press Ctrl+C again to quit");
      return;
    }
    if (key.ctrl && key.name === "g") {
      consume();
      if (mode === "compose") enterGraphMode();
      else setMode("compose");
      return;
    }
    if (key.ctrl && key.name === "p") {
      consume();
      setMode(mode === "model" ? "compose" : "model");
      return;
    }
    if (key.ctrl && key.name === "o") {
      consume();
      const open = !thinkingOpenRef.current;
      if (open && !snapshotRef.current.messages.some((message) => message.role === "thinking")) {
        setNotice("no reasoning recorded yet");
        return;
      }
      setThinkingOpen(open);
      setNotice(open ? "reasoning shown · Ctrl+O to collapse" : "reasoning collapsed");
      return;
    }
    if(mode === "effort")return; // The slider owns its keys, including Escape.
    // Read native input here: a fast Enter can arrive before React has
    // published the final text-change notification used to render the popup.
    const currentText = textareaRef.current?.plainText ?? composerTextRef.current;
    if (mode === "compose" && (helpOpenRef.current || (slashQuery(currentText) !== null && dismissedQueryRef.current !== currentText))) {
      const q = slashQuery(currentText);
      const list = helpOpenRef.current ? [...COMMANDS] : q !== null ? filterCommands(q) : [];
      const cursor = Math.min(popupCursorRef.current, Math.max(0, list.length - 1));
      switch (key.name) {
        case "up":
          consume();
          setPopupCursor(Math.max(0, cursor - 1));
          return;
        case "down":
          consume();
          setPopupCursor(Math.min(list.length - 1, cursor + 1));
          return;
        case "tab": {
          consume();
          const spec = list[cursor];
          if (spec) selectPopupCommand(spec, true);
          return;
        }
        case "return":
        case "kpenter": {
          if (key.shift || key.meta) break;
          consume();
          const spec = list[cursor];
          if (spec) selectPopupCommand(spec, false);
          else if (!helpOpenRef.current) submit();
          return;
        }
        case "escape":
          consume();
          if (helpOpenRef.current) setHelpOpen(false);
          else setDismissedQuery(currentText);
          return;
      }
    }
    if (key.name === "pageup" || key.name === "pagedown") {
      consume();
      const box = scrollRef.current;
      if (box) box.scrollBy(key.name === "pageup" ? -Math.max(1, height - 8) : Math.max(1, height - 8));
      return;
    }
    if (mode === "model") {
      if (key.name === "escape") {
        consume();
        setMode("compose");
      }
      return; // the select owns the remaining keys
    }
    if (mode === "inspect") {
      if (key.name === "escape" || key.name === "left" || key.name === "q") {
        consume();
        setMode("graph");
      }
      return; // the inspector scrollbox owns the remaining keys
    }
    if (mode === "graph") {
      if (!currentLayout || !currentGraph) {
        setMode("compose");
        return;
      }
      const rows = currentLayout.rows;
      switch (key.name) {
        case "escape":
          consume();
          setMode("compose");
          return;
        case "up":
        case "k":
          consume();
          setRowCursor((r) => Math.max(0, Math.min(r, rows.length - 1) - 1));
          return;
        case "down":
        case "j":
          consume();
          setRowCursor((r) => Math.min(rows.length - 1, r + 1));
          return;
        case "right":
        case "return":
        case "space":
        case "l": {
          consume();
          const row = rows[Math.min(rowCursor, rows.length - 1)];
          if (!row) return;
          // Enter inspects a node; Space and l toggle a group; Right opens a group, then inspects.
          // A body row without an instance yet has nothing to inspect, so every key toggles it.
          const inspectable = row.instance !== undefined;
          if (!inspectable) { if (row.group) toggleFold(row); }
          else if (key.name === "return" || !row.group) setMode("inspect");
          else if (key.name === "right" && row.expanded) setMode("inspect");
          else toggleFold(row);
          return;
        }
        case "left":
        case "h": {
          consume();
          const row = rows[Math.min(rowCursor, rows.length - 1)];
          if (!row) return;
          if (row.group && row.expanded) toggleFold(row);
          else if (row.parentId) {
            const parentIdx = rows.findIndex((r) => r.id === row.parentId);
            if (parentIdx >= 0) setRowCursor(parentIdx);
          }
          return;
        }
        case "[":
          consume();
          setGraphCursor((g) => Math.max(0, g - 1));
          setRowCursor(0);
          return;
        case "]":
          consume();
          setGraphCursor((g) => Math.min(graphs.length - 1, g + 1));
          setRowCursor(0);
          return;
        case "e":
          consume();
          setExpanded(new Set(foldableIds(currentGraph)));
          setFolded(new Set());
          return;
        case "c":
          consume();
          setExpanded(new Set());
          setFolded(new Set(foldableIds(currentGraph)));
          setRowCursor((r) => Math.min(r, rows.length - 1));
          return;
      }
      return;
    }
    // compose mode: Escape clears a stray notice only
    if (key.name === "escape" && notice) setNotice(undefined);
  });

  const empty = messages.length === 0 && graphs.length === 0;
  const modeLabel = mode === "compose" ? "compose" : mode === "graph" ? "graph ↑↓ → Esc" : mode === "inspect" ? "inspect Esc" : mode;
  // Rows left for the conversation: total minus status bar, composer card (+ margin) and the popup.
  const viewportHeight = Math.max(4, height - 1 - (composerLines + COMPOSER_CHROME_ROWS) - popupRows - (mode === "effort" ? EFFORT_PANEL_ROWS + 1 : 0) - (snapshot.busy?1:0));

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={palette.bg}>
      <scrollbox
        ref={scrollRef}
        flexGrow={1}
        flexShrink={1}
        minHeight={0}
        width="100%"
        stickyScroll
        stickyStart="bottom"
        scrollY
        viewportCulling
        rootOptions={{ backgroundColor: palette.bg }}
        wrapperOptions={{ backgroundColor: palette.bg }}
        viewportOptions={{ backgroundColor: palette.bg }}
        contentOptions={{ backgroundColor: palette.bg }}
      >
        {empty ? (
          <box flexDirection="column" width="100%" height={viewportHeight} justifyContent="center" alignItems="center">
            <Orb width={width} height={Math.max(8, viewportHeight - 4)} animate />
          </box>
        ) : (
          <Conversation
            messages={messages}
            placements={placements}
            width={width}
            minHeight={viewportHeight}
            expanded={expanded}
            folded={folded}
            focusedGraph={focusedGraph?.id ?? null}
            selectedRow={Math.min(rowCursor, (focusedLayout?.rows.length ?? 1) - 1)}
            streaming={snapshot.busy}
            showThinking={thinkingOpen}
          />
        )}
      </scrollbox>
      {popupVisible ? <CommandPopup commands={popupCommands} cursor={Math.min(popupCursor, Math.max(0, popupCommands.length - 1))} query={query ?? ""} help={helpOpen} width={width} /> : null}
      {mode === "effort"?<EffortPicker key={`${snapshot.model}:${effortLoading}`} model={snapshot.models.find(model=>model.id===snapshot.model)} current={snapshot.effort}
        width={width} loading={effortLoading} error={effortError}
        onCancel={()=>setMode("compose")} onChoose={level=>{
          void controller.setEffort(level).then(()=>{
            const current=controller.getSnapshot();
            if(current.error){setEffortError(current.error);return;}
            setMode("compose");setNotice(`effort → ${current.effort??"auto"}`);
          }).catch(error=>setEffortError(String(error)));
        }}/>:null}
      {snapshot.busy?<ThinkingIndicator snapshot={snapshot}/>:null}
      <StatusBar snapshot={snapshot} width={width} mode={modeLabel} notice={notice} />
      <Composer textareaRef={textareaRef} focused={mode === "compose"} busy={snapshot.busy} width={width} onSubmit={submit} onTextChange={onComposerText} onLinesChange={setComposerLines} />
      {mode === "model" ? (
        <ModelPicker
          models={snapshot.models}
          current={snapshot.model}
          width={width}
          height={height}
          onChoose={(id) => {
            controller.setModel(id);
            setNotice(`model → ${id}`);
            setMode("compose");
          }}
        />
      ) : null}
      {mode === "inspect" && focusedGraph && selectedRow ? <Inspector graph={focusedGraph} node={selectedRow.instance ?? selectedRow.node} width={width} height={height} now={Date.now()} /> : null}
    </box>
  );
}

/** Mount the app on an existing renderer; resolves when the user quits or the renderer is destroyed. */
export function runWithRenderer(controller: AgentController, renderer: CliRenderer): Promise<void> {
  return new Promise<void>((resolve) => {
    const root = createRoot(renderer);
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (controller.getSnapshot().busy) controller.interrupt();
      try {
        root.unmount();
      } catch {
        // renderer may already be gone
      }
      try {
        if (!renderer.isDestroyed) renderer.destroy();
      } catch {
        // ignore double-destroy
      }
      resolve();
    };
    renderer.once("destroy", finish);
    root.render(<App controller={controller} onQuit={finish} />);
  });
}

/** Launch the terminal UI for a controller; resolves after graceful shutdown. */
export async function launchUI(controller: AgentController): Promise<void> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    useMouse: true,
    backgroundColor: palette.bg,
    targetFps: 30,
  });
  await runWithRenderer(controller, renderer);
}
