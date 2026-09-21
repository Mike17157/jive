(() => {
  "use strict";

  const POLL_MS = 2000;
  const ACTIVE_STATUSES = new Set(["preparing", "starting", "running"]);
  const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "timed_out"]);
  const state = {
    tasks: [],
    models: [],
    modelRequest: 0,
    runs: [],
    source: null,
    dataDirectory: "",
    token: "",
    loading: true,
    error: "",
    expanded: new Set(),
    details: new Map(),
    outputs: new Map(),
    outputViews: new Map(),
    outputErrors: new Map(),
    artifacts: new Map(),
    artifactErrors: new Map(),
    scrollPositions: new Map(),
    pendingFocusKey: "",
    maximizedOutput: "",
    pollTimer: null,
    requestInFlight: false,
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const elements = {
    connection: $("#connection-state"),
    connectionLabel: $("#connection-label"),
    sourceBranch: $("#source-branch"),
    sourceRevision: $("#source-revision"),
    dataDirectory: $("#data-directory"),
    active: $("#stat-active"),
    activeNote: $("#stat-active-note"),
    completed: $("#stat-completed"),
    passRate: $("#stat-pass-rate"),
    gradedNote: $("#stat-graded-note"),
    median: $("#stat-median"),
    resultCount: $("#result-count"),
    runList: $("#run-list"),
    search: $("#run-search"),
    statusFilter: $("#status-filter"),
    agentFilter: $("#agent-filter"),
    newRunButton: $("#new-run-button"),
    dialog: $("#new-run-dialog"),
    form: $("#new-run-form"),
    closeDialog: $("#close-dialog"),
    cancelDialog: $("#cancel-dialog"),
    taskSelect: $("#task-select"),
    taskDescription: $("#task-description"),
    model: $("#model-input"),
    modelNotice: $("#model-notice"),
    effort: $("#effort-select"),
    effortNotice: $("#effort-notice"),
    timeout: $("#timeout-input"),
    commitField: $("#commit-field"),
    commit: $("#commit-input"),
    recordingEnabled: $("#recording-enabled"),
    recordingOptions: $("#recording-options"),
    recordingPreset: $("#recording-preset"),
    recordingWidth: $("#recording-width"),
    recordingHeight: $("#recording-height"),
    recordingColumns: $("#recording-columns"),
    recordingRows: $("#recording-rows"),
    formError: $("#form-error"),
    submitRun: $("#submit-run"),
    toastRegion: $("#toast-region"),
  };

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function append(parent, ...children) {
    for (const child of children) if (child) parent.append(child);
    return parent;
  }

  function normalizeError(error, fallback = "Something went wrong") {
    return error instanceof Error && error.message ? error.message : fallback;
  }

  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.body !== undefined || options.mutation) headers.set("Content-Type", "application/json");
    if (options.mutation) {
      if (!state.token) throw new Error("The local mutation token is unavailable. Refresh and try again.");
      headers.set("X-Taskground-Token", state.token);
    }
    const response = await fetch(path, { ...options, headers });
    const contentType = response.headers.get("content-type") || "";
    let payload = null;
    if (contentType.includes("application/json")) {
      payload = await response.json().catch(() => null);
    } else if (!response.ok) {
      payload = await response.text().catch(() => "");
    }
    if (!response.ok) {
      const message = payload && typeof payload === "object" && payload.error
        ? String(payload.error)
        : typeof payload === "string" && payload.trim()
          ? payload.trim()
          : `Request failed (${response.status})`;
      throw new Error(message);
    }
    return payload;
  }

  function setConnection(kind, label) {
    elements.connection.classList.toggle("is-online", kind === "online");
    elements.connection.classList.toggle("is-error", kind === "error");
    elements.connectionLabel.textContent = label;
  }

  function captureScrollPositions() {
    for (const output of elements.runList.querySelectorAll("[data-output-id]")) {
      const distanceFromBottom = output.scrollHeight - output.scrollTop - output.clientHeight;
      state.scrollPositions.set(output.dataset.outputId, {
        top: output.scrollTop,
        left: output.scrollLeft,
        followTail: distanceFromBottom <= 12,
      });
    }
  }

  function captureViewState() {
    captureScrollPositions();
    const focused = document.activeElement && document.activeElement.closest
      ? document.activeElement.closest("[data-focus-key]")
      : null;
    if (focused) state.pendingFocusKey = focused.dataset.focusKey || "";
  }

  function restoreViewState() {
    for (const output of elements.runList.querySelectorAll("[data-output-id]")) {
      const position = state.scrollPositions.get(output.dataset.outputId);
      if (position) {
        output.scrollTop = position.followTail ? output.scrollHeight : position.top;
        output.scrollLeft = position.left;
      } else {
        output.scrollTop = output.scrollHeight;
      }
    }
    if (state.pendingFocusKey) {
      const target = [...elements.runList.querySelectorAll("[data-focus-key]")]
        .find((candidate) => candidate.dataset.focusKey === state.pendingFocusKey);
      if (target) {
        try { target.focus({ preventScroll: true }); } catch { target.focus(); }
      }
      state.pendingFocusKey = "";
    }
  }

  async function loadConfig() {
    try {
      const config = await api("/api/config");
      state.token = config && typeof config.token === "string" ? config.token : "";
    } catch (error) {
      state.token = "";
      showToast(`Controls unavailable: ${normalizeError(error)}`, true);
    }
  }

  async function refreshState({ announceError = false } = {}) {
    if (state.requestInFlight || document.hidden) return;
    state.requestInFlight = true;
    try {
      const payload = await api("/api/state");
      if (!payload || !Array.isArray(payload.tasks) || !Array.isArray(payload.runs)) {
        throw new Error("The server returned an invalid state response.");
      }
      captureViewState();
      state.tasks = payload.tasks;
      state.runs = payload.runs;
      state.source = payload.source || null;
      state.dataDirectory = payload.dataDirectory || "";
      if (!state.token && typeof payload.token === "string") state.token = payload.token;
      state.loading = false;
      state.error = "";
      updateTaskOptions();
      render();
      setConnection("online", "Live");
      await refreshExpandedRuns();
    } catch (error) {
      captureViewState();
      state.loading = false;
      state.error = normalizeError(error, "Could not reach the local Taskground server.");
      setConnection("error", "Disconnected");
      render();
      if (announceError) showToast(state.error, true);
    } finally {
      state.requestInFlight = false;
    }
  }

  async function refreshExpandedRuns() {
    const visibleIds = filteredRuns().map((run) => run.id).filter((id) => state.expanded.has(id));
    if (!visibleIds.length) return;
    await Promise.all(visibleIds.map(async (id) => {
      const [runResult, outputResult, artifactsResult] = await Promise.allSettled([
        api(`/api/runs/${encodeURIComponent(id)}`),
        api(`/api/runs/${encodeURIComponent(id)}/output`),
        api(`/api/runs/${encodeURIComponent(id)}/artifacts`),
      ]);
      if (runResult.status === "fulfilled" && runResult.value) state.details.set(id, runResult.value);
      if (outputResult.status === "fulfilled") {
        const output = outputResult.value;
        state.outputs.set(id, output && typeof output.text === "string" ? output.text : "");
        state.outputErrors.delete(id);
      } else {
        state.outputErrors.set(id, normalizeError(outputResult.reason, "Output unavailable."));
      }
      if (artifactsResult.status === "fulfilled") {
        const payload = artifactsResult.value;
        state.artifacts.set(id, payload && Array.isArray(payload.files) ? payload.files : []);
        state.artifactErrors.delete(id);
      } else {
        state.artifactErrors.set(id, normalizeError(artifactsResult.reason, "Deliverables unavailable."));
      }
    }));
    captureViewState();
    renderRuns();
  }

  function schedulePolling() {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
    if (!document.hidden) state.pollTimer = window.setInterval(() => refreshState(), POLL_MS);
  }

  function updateTaskOptions() {
    const previous = elements.taskSelect.value;
    const wasFocused = document.activeElement === elements.taskSelect;
    const signature = state.tasks.map((task) => `${task.id}:${task.title || ""}`).join("|");
    if (elements.taskSelect.dataset.signature === signature) return;
    elements.taskSelect.replaceChildren();
    const placeholder = node("option", "", state.tasks.length ? "Select a task…" : "No tasks available");
    placeholder.value = "";
    elements.taskSelect.append(placeholder);
    for (const task of state.tasks) {
      const option = node("option", "", task.title ? `${task.title} · ${task.id}` : task.id);
      option.value = task.id;
      elements.taskSelect.append(option);
    }
    elements.taskSelect.dataset.signature = signature;
    if (state.tasks.some((task) => task.id === previous)) elements.taskSelect.value = previous;
    elements.taskSelect.disabled = state.tasks.length === 0;
    updateTaskDescription();
    if (wasFocused) elements.taskSelect.focus();
  }

  function updateTaskDescription() {
    const task = state.tasks.find((item) => item.id === elements.taskSelect.value);
    elements.taskDescription.textContent = task ? (task.description || task.title || task.id) : "Choose a benchmark definition.";
  }

  function render() {
    renderSource();
    renderSummary();
    renderRuns();
  }

  function renderSource() {
    elements.sourceBranch.textContent = state.source && state.source.branch ? state.source.branch : "No branch";
    elements.sourceRevision.textContent = state.source && state.source.revision ? shortRevision(state.source.revision) : "No revision";
    elements.sourceRevision.title = state.source && state.source.revision ? state.source.revision : "";
    elements.dataDirectory.textContent = state.dataDirectory ? `Run storage  ${state.dataDirectory}` : "Run storage unavailable";
    elements.dataDirectory.title = state.dataDirectory || "";
  }

  function renderSummary() {
    const active = state.runs.filter((run) => ACTIVE_STATUSES.has(run.status));
    const completed = state.runs.filter((run) => TERMINAL_STATUSES.has(run.status));
    const graded = state.runs.filter((run) => run.grading && ["passed", "failed"].includes(run.grading.status));
    const passed = graded.filter((run) => run.grading.status === "passed");
    const durations = completed.map(runElapsed).filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
    const middle = Math.floor(durations.length / 2);
    const median = durations.length ? (durations.length % 2 ? durations[middle] : (durations[middle - 1] + durations[middle]) / 2) : null;
    elements.active.textContent = String(active.length);
    elements.activeNote.textContent = active.length === 1 ? "run in flight" : "runs in flight";
    elements.completed.textContent = String(completed.length);
    elements.passRate.textContent = graded.length ? `${Math.round((passed.length / graded.length) * 100)}%` : "—";
    elements.gradedNote.textContent = graded.length ? `${graded.length} verified ${graded.length === 1 ? "run" : "runs"}` : "no verified runs";
    elements.median.textContent = median === null ? "—" : formatDuration(median);
  }

  function filteredRuns() {
    const query = elements.search.value.trim().toLowerCase();
    const status = elements.statusFilter.value;
    const agent = elements.agentFilter.value;
    return [...state.runs]
      .filter((run) => {
        if (agent !== "all" && run.agent !== agent) return false;
        if (status === "active" && !ACTIVE_STATUSES.has(run.status)) return false;
        if (status === "failed" && !["failed", "timed_out"].includes(run.status)) return false;
        if (!["all", "active", "failed"].includes(status) && run.status !== status) return false;
        if (!query) return true;
        const haystack = [run.id, run.task, run.title, run.agent, run.model, run.status, run.source && run.source.branch, run.source && run.source.revision]
          .filter(Boolean).join(" ").toLowerCase();
        return haystack.includes(query);
      })
      .sort((a, b) => {
        const aActive = ACTIVE_STATUSES.has(a.status) ? 1 : 0;
        const bActive = ACTIVE_STATUSES.has(b.status) ? 1 : 0;
        return bActive - aActive || Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0);
      });
  }

  function renderRuns() {
    const runs = filteredRuns();
    if (state.maximizedOutput && (!state.expanded.has(state.maximizedOutput) || !runs.some((run) => run.id === state.maximizedOutput))) {
      state.maximizedOutput = "";
    }
    document.body.classList.toggle("has-maximized-output", Boolean(state.maximizedOutput));
    elements.runList.setAttribute("aria-busy", String(state.loading));
    elements.resultCount.textContent = state.loading
      ? "Loading run history…"
      : `${runs.length} of ${state.runs.length} ${state.runs.length === 1 ? "run" : "runs"}`;
    elements.runList.replaceChildren();
    if (state.loading) {
      elements.runList.append(stateCard("", "Loading Taskground", "Reading tasks and retained runs from this machine.", true));
      return;
    }
    if (state.error && !state.runs.length) {
      const card = stateCard("!", "Taskground is unavailable", state.error);
      const retry = node("button", "button button-secondary", "Retry connection");
      retry.type = "button";
      retry.addEventListener("click", () => refreshState({ announceError: true }));
      card.append(retry);
      elements.runList.append(card);
      return;
    }
    if (!state.runs.length) {
      const card = stateCard("＋", "No benchmark runs yet", state.tasks.length ? "Start a run to create the first retained workspace." : "No task definitions are currently available.");
      if (state.tasks.length) {
        const start = node("button", "button button-primary", "Start first run");
        start.type = "button";
        start.addEventListener("click", openDialog);
        card.append(start);
      }
      elements.runList.append(card);
      return;
    }
    if (!runs.length) {
      elements.runList.append(stateCard("⌕", "No matching runs", "Adjust the search or filters to see more history."));
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const run of runs) fragment.append(renderRun(run));
    elements.runList.append(fragment);
    // A detail poll can finish before the next frame; restore now so it never
    // saves the replacement pane's initial scroll position over the user's.
    restoreViewState();
    requestAnimationFrame(drawCharts);
  }

  function stateCard(icon, title, message, loading = false) {
    const card = node("div", `state-card${loading ? " loading-state" : ""}`);
    card.append(loading ? node("span", "loader") : node("span", "state-icon", icon));
    append(card, node("strong", "", title), node("p", "", message));
    return card;
  }

  function renderRun(summaryRun) {
    const expanded = state.expanded.has(summaryRun.id);
    const run = expanded ? { ...summaryRun, ...(state.details.get(summaryRun.id) || {}) } : summaryRun;
    const item = node("article", `run-item${expanded ? " is-expanded" : ""}`);
    item.dataset.runId = run.id;
    const button = node("button", "run-summary");
    button.type = "button";
    button.dataset.focusKey = `summary:${run.id}`;
    button.setAttribute("aria-expanded", String(expanded));
    button.setAttribute("aria-controls", `run-detail-${safeId(run.id)}`);
    button.addEventListener("click", () => toggleRun(run.id));

    const task = node("span", "run-task");
    const glyph = node("span", "agent-glyph", (run.agent || "?").slice(0, 1));
    glyph.setAttribute("aria-hidden", "true");
    const taskText = node("span");
    append(taskText, node("strong", "", taskTitle(run.task)), node("small", "", run.id));
    append(task, glyph, taskText);

    const agent = node("span", "agent-name", run.agent || "Unknown");
    const status = node("span", "run-status");
    const model = node("span", "status-model", run.model || "Agent default");
    model.title = `Model: ${run.model || "Agent default"}`;
    const effort = node("span", "status-effort", `Effort: ${run.effort || "default"}`);
    effort.title = `Reasoning effort: ${run.effort || "Agent default"}`;
    append(status, node("span", `status-badge status-${run.status || "unknown"}`, statusLabel(run.status)), model, effort);
    const elapsed = node("span", "run-time", formatDuration(runElapsed(run), ACTIVE_STATUSES.has(run.status)));
    const date = node("span", "run-date", formatDate(run.createdAt));
    date.append(node("small", "", formatTime(run.createdAt)));
    const chevron = node("span", "chevron", "⌄");
    chevron.setAttribute("aria-hidden", "true");
    append(button, task, agent, status, elapsed, date, chevron);
    item.append(button);
    if (expanded) item.append(renderDetail(run));
    return item;
  }

  function renderDetail(run) {
    const detail = node("div", "run-detail");
    detail.id = `run-detail-${safeId(run.id)}`;
    const head = node("div", "detail-head");
    const headLeft = node("div", "detail-head-left");
    const gradeStatus = run.grading && run.grading.status ? run.grading.status : "ungraded";
    append(headLeft, node("span", `grade-badge grade-${gradeStatus}`, gradeStatus), node("code", "", run.workspace || run.directory || "Workspace pending"));
    const actions = node("div", "detail-actions");
    renderActions(run, actions);
    append(head, headLeft, actions);
    detail.append(head);

    const metrics = run.metrics || {};
    const strip = node("div", "metric-strip");
    const values = [
      ["Elapsed", formatDuration(runElapsed(run), ACTIVE_STATUSES.has(run.status))],
      ["Planner turns", metric(metrics, "plannerTurns")],
      ["Steps", metric(metrics, "steps")],
      ["Graphs", graphMetric(metrics)],
      ["Avg graph", decimalMetric(metrics, "avgGraphSize")],
      ["JEV calls", metric(metrics, "jevCalls")],
      ["JEV attempts", metric(metrics, "jevAttempts")],
      ["JEV retries", metric(metrics, "jevRetries")],
      ["Parallel now", metric(metrics, "currentParallelism")],
      ["Parallel peak", metric(metrics, "peakParallelism")],
      ["Parallel avg", decimalMetric(metrics, "avgParallelism")],
      ["Loop work", loopMetric(metrics)],
    ];
    for (const [label, value] of values) {
      const cell = node("div", "metric");
      append(cell, node("span", "", label), node("strong", "", value));
      strip.append(cell);
    }
    detail.append(strip);

    const grid = node("div", "detail-grid");
    const main = node("div", "detail-stack");
    main.append(renderOutput(run), renderCharts(run));
    const side = node("div", "detail-stack");
    side.append(renderProvenance(run), renderArtifacts(run), renderGrading(run));
    append(grid, main, side);
    detail.append(grid);
    if (run.error) detail.append(node("p", "run-error", run.error));
    return detail;
  }

  function renderActions(run, parent) {
    if (ACTIVE_STATUSES.has(run.status)) parent.append(actionButton("Cancel", "button-danger", () => mutateRun(run.id, "stop", "Cancellation requested."), `cancel:${run.id}`));
    if (TERMINAL_STATUSES.has(run.status) || run.status === "ready") parent.append(actionButton("Verify", "button-secondary", () => mutateRun(run.id, "verify", "Verification finished."), `verify:${run.id}`));
    if (run.recording) {
      const exportState = run.export && run.export.status;
      if (exportState === "ready") {
        const download = node("a", "button button-primary", "Download MP4");
        download.href = `/api/runs/${encodeURIComponent(run.id)}/recording`;
        download.setAttribute("download", `${run.id}.mp4`);
        download.dataset.focusKey = `recording:${run.id}`;
        parent.append(download);
      } else {
        const exportButton = actionButton(exportState === "exporting" ? "Exporting…" : exportState === "error" ? "Retry export" : "Export recording", "button-quiet", () => mutateRun(run.id, "export", "Recording export started.", {}), `recording:${run.id}`);
        exportButton.disabled = exportState === "exporting" || !TERMINAL_STATUSES.has(run.status);
        if (exportState === "error" && run.export.error) exportButton.title = run.export.error;
        parent.append(exportButton);
      }
    }
  }

  function actionButton(label, className, handler, focusKey) {
    const button = node("button", `button ${className}`, label);
    button.type = "button";
    if (focusKey) button.dataset.focusKey = focusKey;
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      button.disabled = true;
      try { await handler(); } finally { button.disabled = false; }
    });
    return button;
  }

  function renderOutput(run) {
    const panel = detailPanel("Output", ACTIVE_STATUSES.has(run.status) ? "live tail" : "terminal log");
    const view = state.outputViews.get(run.id) || "logs";
    const viewId = `output-${safeId(run.id)}-${view}`;
    const maximized = state.maximizedOutput === run.id;
    panel.classList.add("output-panel");
    panel.classList.toggle("is-maximized", maximized);
    const maximize = node("button", "panel-control", maximized ? "Restore" : "Maximize");
    maximize.type = "button";
    maximize.dataset.focusKey = `maximize:${run.id}`;
    maximize.setAttribute("aria-pressed", String(maximized));
    maximize.setAttribute("aria-label", `${maximized ? "Restore" : "Maximize"} terminal output for ${run.id}`);
    maximize.addEventListener("click", () => {
      captureViewState();
      state.maximizedOutput = maximized ? "" : run.id;
      renderRuns();
    });
    $(".panel-header-tools", panel).append(maximize);
    const tabs = node("div", "output-tabs");
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", `Output views for ${run.id}`);
    const views = ["logs", "terminal"];
    for (const name of views) {
      const tab = node("button", "output-tab", name === "logs" ? "Logs" : "Terminal");
      tab.type = "button";
      tab.id = `output-tab-${safeId(run.id)}-${name}`;
      tab.dataset.focusKey = `output-tab:${run.id}:${name}`;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(view === name));
      tab.setAttribute("aria-controls", `output-${safeId(run.id)}-${name}`);
      tab.tabIndex = view === name ? 0 : -1;
      const select = target => {
        captureViewState();
        state.outputViews.set(run.id, target);
        state.pendingFocusKey = `output-tab:${run.id}:${target}`;
        renderRuns();
      };
      tab.addEventListener("click", () => select(name));
      tab.addEventListener("keydown", event => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        select(event.key === "Home" ? "logs" : event.key === "End" ? "terminal" : views[(views.indexOf(name) + 1) % views.length]);
      });
      tabs.append(tab);
    }
    panel.append(tabs);
    if (view === "terminal") {
      const bar = node("div", "terminal-toolbar");
      const label = node("span", "terminal-caption", `${run.agent || "Agent"} · ${run.model || "default model"}`);
      label.title = label.textContent;
      const tools = node("span", "terminal-tools");
      tools.append(node("span", "terminal-readonly", "Read only"));
      const latest = node("button", "panel-control", "Jump to latest");
      latest.type = "button";
      latest.dataset.focusKey = `output-latest:${run.id}`;
      latest.addEventListener("click", () => {
        const output = $(".terminal-output", panel);
        output.scrollTop = output.scrollHeight;
        state.scrollPositions.set(output.dataset.outputId, { top: output.scrollTop, left: output.scrollLeft, followTail: true });
      });
      tools.append(latest);
      append(bar, label, tools);
      panel.append(bar);
    }
    const output = node("pre", `terminal-output${view === "terminal" ? " terminal-screen" : ""}`);
    output.id = viewId;
    output.dataset.outputId = `${run.id}:${view}`;
    output.dataset.focusKey = `output:${run.id}:${view}`;
    output.tabIndex = 0;
    output.setAttribute("role", "tabpanel");
    output.setAttribute("aria-labelledby", `output-tab-${safeId(run.id)}-${view}`);
    const error = state.outputErrors.get(run.id);
    const text = state.outputs.get(run.id);
    if (error) {
      output.classList.add("terminal-empty");
      output.textContent = error;
    } else if (text === undefined) {
      output.classList.add("terminal-empty");
      output.textContent = "Loading output…";
    } else if (!text) {
      output.classList.add("terminal-empty");
      output.textContent = ACTIVE_STATUSES.has(run.status) ? "Waiting for agent output…" : "No terminal output was captured.";
    } else if (view === "terminal") {
      for (const line of text.split("\n")) {
        const row = node("span", /\[stderr\]/.test(line) ? "terminal-line terminal-stderr" : "terminal-line");
        const timestamp = /^(\[\+?\d{2}:\d{2}:\d{2}\.\d{3}\])/.exec(line);
        if (timestamp) {
          row.append(node("span", "terminal-timestamp", timestamp[1]));
          row.append(document.createTextNode(line.slice(timestamp[1].length) + "\n"));
        } else row.textContent = line + "\n";
        output.append(row);
      }
    } else {
      output.textContent = text;
    }
    panel.append(output);
    return panel;
  }

  function renderCharts(run) {
    const metrics = run.metrics || {};
    const series = Array.isArray(metrics.series) ? metrics.series : [];
    const panel = detailPanel("Activity & concurrency", series.length ? `${series.length} samples` : "no samples");
    if (metrics.available === false || !series.length) {
      panel.append(stateCard("∿", "Metrics not available", ACTIVE_STATUSES.has(run.status) ? "Activity samples will appear while the run progresses." : "This run did not publish a metric series."));
      return panel;
    }
    const charts = node("div", "charts");
    charts.append(
      chartBlock(run.id, "activity", "Work activity", `Steps ${metric(metrics, "steps")} · JEV ${metric(metrics, "jevCalls")}`, [["steps", "#ad7cff"], ["jevCalls", "#52d29b"]]),
      chartBlock(run.id, "parallel", "Concurrency", `Peak ${metric(metrics, "peakParallelism")} · Avg ${decimalMetric(metrics, "avgParallelism")}`, [["active", "#58a6ff"]]),
    );
    panel.append(charts);
    return panel;
  }

  function chartBlock(runId, kind, label, summary, legendItems) {
    const wrap = node("div", "chart-wrap");
    const heading = node("div", "chart-label");
    append(heading, node("span", "", label), node("b", "", summary));
    const canvas = node("canvas", "chart");
    canvas.dataset.chartRun = runId;
    canvas.dataset.chartKind = kind;
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", `${label} over time`);
    const legend = node("div", "chart-legend");
    for (const [key, color] of legendItems) {
      const labelNode = node("span", "", key === "jevCalls" ? "JEV calls" : key);
      labelNode.style.setProperty("--legend-color", color);
      legend.append(labelNode);
    }
    append(wrap, heading, canvas, legend);
    return wrap;
  }

  function drawCharts() {
    for (const canvas of elements.runList.querySelectorAll("canvas[data-chart-run]")) {
      const run = state.details.get(canvas.dataset.chartRun) || state.runs.find((item) => item.id === canvas.dataset.chartRun);
      const series = run && run.metrics && Array.isArray(run.metrics.series) ? run.metrics.series : [];
      if (!series.length) continue;
      const keys = canvas.dataset.chartKind === "parallel" ? [["active", "#58a6ff"]] : [["steps", "#ad7cff"], ["jevCalls", "#52d29b"]];
      drawLineChart(canvas, series, keys);
    }
  }

  function drawLineChart(canvas, series, keys) {
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(rect.width * ratio));
    const height = Math.max(1, Math.round(rect.height * ratio));
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    const context = canvas.getContext("2d");
    context.clearRect(0, 0, width, height);
    const pad = { top: 10 * ratio, right: 9 * ratio, bottom: 16 * ratio, left: 24 * ratio };
    const chartWidth = width - pad.left - pad.right;
    const chartHeight = height - pad.top - pad.bottom;
    const maxima = keys.flatMap(([key]) => series.map((point) => finiteNumber(point[key], 0)));
    const max = Math.max(1, ...maxima);
    context.strokeStyle = "#292f34";
    context.lineWidth = ratio;
    context.fillStyle = "#69727a";
    context.font = `${8 * ratio}px ${getComputedStyle(document.documentElement).getPropertyValue("--mono")}`;
    context.textAlign = "right";
    for (let line = 0; line <= 2; line += 1) {
      const y = pad.top + chartHeight * (line / 2);
      context.beginPath(); context.moveTo(pad.left, y); context.lineTo(width - pad.right, y); context.stroke();
      context.fillText(String(Math.round(max * (1 - line / 2))), pad.left - 4 * ratio, y + 3 * ratio);
    }
    for (const [key, color] of keys) {
      context.beginPath();
      context.strokeStyle = color;
      context.lineWidth = 1.5 * ratio;
      context.lineJoin = "round";
      series.forEach((point, index) => {
        const x = pad.left + (series.length === 1 ? chartWidth : chartWidth * index / (series.length - 1));
        const y = pad.top + chartHeight - (finiteNumber(point[key], 0) / max) * chartHeight;
        if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
      });
      context.stroke();
    }
    context.textAlign = "left";
    const first = series[0] && series[0].time;
    const last = series[series.length - 1] && series[series.length - 1].time;
    context.fillStyle = "#69727a";
    context.fillText(shortTime(first), pad.left, height - 4 * ratio);
    const lastText = shortTime(last);
    context.textAlign = "right";
    context.fillText(lastText, width - pad.right, height - 4 * ratio);
  }

  function renderProvenance(run) {
    const panel = detailPanel("Provenance", run.source && run.source.mode ? run.source.mode : "source");
    const source = run.source || {};
    panel.append(infoList([
      ["Mode", source.mode || run.sourceMode || "—"],
      ["Model", run.model || "Agent default"],
      ["Thinking effort", run.effort || "Agent default"],
      ["Branch", source.branch || "detached"],
      ["Revision", source.revision || "—"],
      ["Working tree", source.dirty === true ? "dirty" : source.dirty === false ? "clean" : "—", source.dirty === true ? "dirty" : source.dirty === false ? "clean" : ""],
      ["Code hash", source.codeHash || "—"],
      ["Started", formatDateTime(run.startedAt)],
      ["Last event", formatDateTime(run.metrics && run.metrics.lastEventAt)],
    ]));
    return panel;
  }

  function renderArtifacts(run) {
    const files = state.artifacts.get(run.id);
    const error = state.artifactErrors.get(run.id);
    const panel = detailPanel("Deliverables", files ? `${files.length} ${files.length === 1 ? "file" : "files"}` : "artifacts");
    if (error) {
      panel.append(node("p", "artifact-state artifact-error", error));
      return panel;
    }
    if (files === undefined) {
      panel.append(node("p", "artifact-state", "Loading deliverables…"));
      return panel;
    }
    if (!files.length) {
      panel.append(node("p", "artifact-state", "No deliverables were reported."));
      return panel;
    }
    const list = node("ul", "artifact-list");
    files.forEach((file, index) => {
      const item = node("li");
      const link = node("a", "artifact-link", file && file.path ? String(file.path) : "Unnamed file");
      const path = file && file.path ? String(file.path) : "";
      link.href = `/api/runs/${encodeURIComponent(run.id)}/artifact?path=${encodeURIComponent(path)}`;
      link.setAttribute("download", "");
      link.dataset.focusKey = `artifact:${run.id}:${index}`;
      const size = node("span", "", formatBytes(file && file.bytes));
      append(item, link, size);
      list.append(item);
    });
    panel.append(list);
    return panel;
  }

  function renderGrading(run) {
    const grading = run.grading || { status: "ungraded" };
    const attempts = Array.isArray(grading.attempts) ? grading.attempts : [];
    const panel = detailPanel("Grading", grading.status || "ungraded");
    const rows = [["Status", grading.status || "ungraded"], ["Attempts", String(attempts.length)]];
    panel.append(infoList(rows));
    if ((grading.status && grading.status !== "ungraded") || grading.report) {
      const links = node("div", "panel-links");
      const report = node("a", "button button-quiet", "View JSON report");
      report.href = `/api/runs/${encodeURIComponent(run.id)}/report`;
      report.target = "_blank";
      report.rel = "noopener";
      report.dataset.focusKey = `report:${run.id}`;
      links.append(report);
      panel.append(links);
    }
    return panel;
  }

  function detailPanel(title, meta) {
    const panel = node("section", "detail-panel");
    const header = node("header", "detail-panel-header");
    const tools = node("div", "panel-header-tools");
    tools.append(node("span", "", meta));
    append(header, node("h3", "", title), tools);
    panel.append(header);
    return panel;
  }

  function infoList(rows) {
    const list = node("dl", "info-list");
    for (const [label, value, className] of rows) {
      const row = node("div", "info-row");
      const description = node("dd", className || "", value === undefined || value === null || value === "" ? "—" : String(value));
      append(row, node("dt", "", label), description);
      list.append(row);
    }
    return list;
  }

  async function toggleRun(id) {
    captureViewState();
    if (state.expanded.has(id)) {
      if (state.maximizedOutput === id) state.maximizedOutput = "";
      state.expanded.delete(id);
      renderRuns();
      return;
    }
    state.expanded.add(id);
    renderRuns();
    await refreshOneRun(id);
  }

  async function refreshOneRun(id) {
    const [runResult, outputResult, artifactsResult] = await Promise.allSettled([
      api(`/api/runs/${encodeURIComponent(id)}`),
      api(`/api/runs/${encodeURIComponent(id)}/output`),
      api(`/api/runs/${encodeURIComponent(id)}/artifacts`),
    ]);
    if (runResult.status === "fulfilled" && runResult.value) state.details.set(id, runResult.value);
    if (outputResult.status === "fulfilled") {
      const output = outputResult.value;
      state.outputs.set(id, output && typeof output.text === "string" ? output.text : "");
      state.outputErrors.delete(id);
    } else {
      state.outputErrors.set(id, normalizeError(outputResult.reason, "Could not load terminal output."));
    }
    if (artifactsResult.status === "fulfilled") {
      const payload = artifactsResult.value;
      state.artifacts.set(id, payload && Array.isArray(payload.files) ? payload.files : []);
      state.artifactErrors.delete(id);
    } else {
      state.artifactErrors.set(id, normalizeError(artifactsResult.reason, "Could not load deliverables."));
    }
    captureViewState();
    renderRuns();
  }

  async function mutateRun(id, action, successMessage, body) {
    try {
      const options = { method: "POST", mutation: true };
      if (body !== undefined) options.body = JSON.stringify(body);
      const run = await api(`/api/runs/${encodeURIComponent(id)}/${action}`, options);
      if (run && run.id) state.details.set(id, run);
      showToast(successMessage);
      await refreshState({ announceError: true });
    } catch (error) {
      showToast(normalizeError(error), true);
    }
  }

  function openDialog() {
    elements.formError.hidden = true;
    if (!elements.dialog.open) elements.dialog.showModal();
    void loadModels();
    requestAnimationFrame(() => elements.taskSelect.focus());
  }

  function closeDialog() {
    if (elements.dialog.open) elements.dialog.close();
  }

  async function loadModels(reset = false) {
    const request = ++state.modelRequest;
    const agent = elements.form.elements.agent.value;
    const previous = reset ? "" : elements.model.value;
    const previousEffort = reset ? "" : elements.effort.value;
    state.models = [];
    const fallback = node("option", "", "Agent default"); fallback.value = "";
    elements.model.replaceChildren(fallback);
    elements.model.disabled = true;
    elements.modelNotice.textContent = "Loading available models…";
    updateEfforts();
    try {
      const catalog = await api(`/api/models?agent=${encodeURIComponent(agent)}`);
      if (request !== state.modelRequest) return;
      state.models = Array.isArray(catalog.models) ? catalog.models : [];
      for (const model of state.models) {
        const option = node("option", "", model.name || model.id); option.value = model.id;
        elements.model.append(option);
      }
      if (state.models.some(model => model.id === previous)) elements.model.value = previous;
      elements.modelNotice.textContent = catalog.notice || "";
      updateEfforts(previousEffort);
    } catch (error) {
      if (request === state.modelRequest) elements.modelNotice.textContent = normalizeError(error);
    } finally { if (request === state.modelRequest) elements.model.disabled = false; }
  }

  function updateEfforts(previous = "") {
    const model = state.models.find(model => model.id === elements.model.value);
    const efforts = model && Array.isArray(model.reasoningEfforts) ? model.reasoningEfforts : [];
    const fallback = node("option", "", "Agent default"); fallback.value = "";
    elements.effort.replaceChildren(fallback);
    const names = { none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Maximum", ultra: "Ultra" };
    for (const effort of efforts) {
      const option = node("option", "", names[effort] || effort); option.value = effort; elements.effort.append(option);
    }
    if (efforts.includes(previous)) elements.effort.value = previous;
    elements.effort.disabled = efforts.length === 0;
    elements.effortNotice.textContent = !model ? "Choose a model to see available effort levels." : model.reasoningEfforts === undefined ? "Effort metadata unavailable; using the agent default." : !efforts.length ? "This model has no adjustable thinking effort." : "Only this model’s supported levels are shown.";
  }

  function updateSourceMode() {
    const mode = elements.form.elements.sourceMode.value;
    elements.commitField.hidden = mode !== "commit";
    elements.commit.required = mode === "commit";
    if (mode !== "commit") elements.commit.setCustomValidity("");
  }

  function applyRecordingPreset() {
    const [width, height, columns, rows] = elements.recordingPreset.value.split(",");
    elements.recordingWidth.value = width;
    elements.recordingHeight.value = height;
    elements.recordingColumns.value = columns;
    elements.recordingRows.value = rows;
  }

  function updateRecording() {
    elements.recordingOptions.hidden = !elements.recordingEnabled.checked;
    elements.recordingEnabled.closest(".switch").classList.toggle("is-checked", elements.recordingEnabled.checked);
    for (const input of [elements.recordingWidth, elements.recordingHeight, elements.recordingColumns, elements.recordingRows]) input.disabled = !elements.recordingEnabled.checked;
    if (elements.recordingEnabled.checked && !elements.recordingWidth.value) applyRecordingPreset();
  }

  async function submitRun(event) {
    event.preventDefault();
    elements.formError.hidden = true;
    if (!elements.form.reportValidity()) return;
    const sourceMode = elements.form.elements.sourceMode.value;
    const agent = elements.form.elements.agent.value;
    const payload = { task: elements.taskSelect.value, agent, sourceMode };
    const model = elements.model.value.trim();
    const timeout = elements.timeout.value.trim();
    const commit = elements.commit.value.trim();
    if (model) payload.model = model;
    if (!elements.effort.disabled && elements.effort.value) payload.effort = elements.effort.value;
    if (timeout) payload.timeoutSeconds = Number(timeout);
    if (sourceMode === "commit") payload.commit = commit;
    if (elements.recordingEnabled.checked) {
      payload.recording = {
        width: Number(elements.recordingWidth.value),
        height: Number(elements.recordingHeight.value),
        columns: Number(elements.recordingColumns.value),
        rows: Number(elements.recordingRows.value),
      };
    }
    elements.submitRun.disabled = true;
    try {
      const response = await api("/api/runs", { method: "POST", mutation: true, body: JSON.stringify(payload) });
      if (!response || !response.id) throw new Error("The server did not return a run ID.");
      state.expanded.add(response.id);
      closeDialog();
      showToast(`Run ${response.id} started.`);
      await refreshState({ announceError: true });
    } catch (error) {
      elements.formError.textContent = normalizeError(error, "Could not start the run.");
      elements.formError.hidden = false;
    } finally {
      elements.submitRun.disabled = false;
    }
  }

  function showToast(message, isError = false) {
    const toast = node("div", `toast${isError ? " is-error" : ""}`, message);
    elements.toastRegion.append(toast);
    window.setTimeout(() => toast.remove(), 4800);
  }

  function taskTitle(id) {
    const task = state.tasks.find((item) => item.id === id);
    return task && task.title ? task.title : id || "Unknown task";
  }

  function statusLabel(status) {
    return String(status || "unknown").replaceAll("_", " ");
  }

  function shortRevision(revision) {
    const value = String(revision);
    return value.length > 10 ? value.slice(0, 10) : value;
  }

  function safeId(value) {
    return String(value).replace(/[^A-Za-z0-9_-]/g, "-");
  }

  function finiteNumber(value, fallback = null) {
    if (value === null || value === undefined || value === "") return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function metric(metrics, key) {
    const value = finiteNumber(metrics && metrics[key]);
    return value === null ? "—" : new Intl.NumberFormat().format(value);
  }

  function decimalMetric(metrics, key) {
    const value = finiteNumber(metrics && metrics[key]);
    return value === null ? "—" : value.toLocaleString(undefined, { maximumFractionDigits: 1 });
  }

  function formatBytes(value) {
    const bytes = finiteNumber(value);
    if (bytes === null || bytes < 0) return "—";
    if (bytes < 1024) return `${bytes} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let size = bytes / 1024;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
    return `${size.toLocaleString(undefined, { maximumFractionDigits: size >= 10 ? 0 : 1 })} ${units[unit]}`;
  }

  function graphMetric(metrics) {
    const completed = finiteNumber(metrics && metrics.graphsCompleted);
    const started = finiteNumber(metrics && metrics.graphsStarted);
    const failed = finiteNumber(metrics && metrics.graphsFailed, 0);
    if (completed === null && started === null) return "—";
    const base = `${completed ?? 0}/${started ?? 0}`;
    return failed ? `${base} · ${failed} failed` : base;
  }

  function loopMetric(metrics) {
    const repeats = finiteNumber(metrics && metrics.repeatIterations);
    const items = finiteNumber(metrics && metrics.foreachItems);
    if (repeats === null && items === null) return "—";
    return `${repeats ?? 0}r · ${items ?? 0}i`;
  }

  function runElapsed(run) {
    const explicit = finiteNumber(run.elapsedMs);
    if (explicit !== null) return explicit;
    const start = Date.parse(run.startedAt || "");
    if (!Number.isFinite(start)) return null;
    const end = run.finishedAt ? Date.parse(run.finishedAt) : Date.now();
    return Number.isFinite(end) ? Math.max(0, end - start) : null;
  }

  function formatDuration(milliseconds, live = false) {
    const value = finiteNumber(milliseconds);
    if (value === null) return live ? "Starting…" : "—";
    if (value < 1000) return `${Math.round(value)}ms`;
    const seconds = Math.floor(value / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    if (minutes < 60) return `${minutes}m ${String(remainder).padStart(2, "0")}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
  }

  function parseDate(value) {
    const date = value ? new Date(value) : null;
    return date && !Number.isNaN(date.getTime()) ? date : null;
  }

  function formatDate(value) {
    const date = parseDate(value);
    if (!date) return "—";
    const today = new Date();
    if (date.toDateString() === today.toDateString()) return "Today";
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: date.getFullYear() === today.getFullYear() ? undefined : "numeric" }).format(date);
  }

  function formatTime(value) {
    const date = parseDate(value);
    return date ? new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date) : "";
  }

  function formatDateTime(value) {
    const date = parseDate(value);
    return date ? `${formatDate(value)} ${formatTime(value)}` : "—";
  }

  function shortTime(value) {
    const date = parseDate(value);
    return date ? new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(date) : "";
  }

  elements.search.addEventListener("input", () => { captureScrollPositions(); renderRuns(); });
  elements.statusFilter.addEventListener("change", () => { captureScrollPositions(); renderRuns(); });
  elements.agentFilter.addEventListener("change", () => { captureScrollPositions(); renderRuns(); });
  elements.newRunButton.addEventListener("click", openDialog);
  elements.closeDialog.addEventListener("click", closeDialog);
  elements.cancelDialog.addEventListener("click", closeDialog);
  elements.taskSelect.addEventListener("change", updateTaskDescription);
  elements.form.addEventListener("submit", submitRun);
  elements.model.addEventListener("change", () => updateEfforts());
  for (const input of elements.form.querySelectorAll('input[name="agent"]')) input.addEventListener("change", () => loadModels(true));
  for (const input of elements.form.querySelectorAll('input[name="sourceMode"]')) input.addEventListener("change", updateSourceMode);
  elements.recordingEnabled.addEventListener("change", updateRecording);
  elements.recordingPreset.addEventListener("change", applyRecordingPreset);
  elements.dialog.addEventListener("click", (event) => {
    const rect = elements.dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeDialog();
  });
  document.addEventListener("keydown", (event) => {
    const target = event.target;
    const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
    if (event.key === "Escape" && state.maximizedOutput) {
      event.preventDefault();
      captureViewState();
      state.maximizedOutput = "";
      renderRuns();
      return;
    }
    if (event.key === "/" && !typing && !elements.dialog.open) {
      event.preventDefault();
      elements.search.focus();
    }
    if (event.key.toLowerCase() === "n" && !typing && !elements.dialog.open) {
      event.preventDefault();
      openDialog();
    }
  });
  document.addEventListener("visibilitychange", () => {
    schedulePolling();
    if (!document.hidden) refreshState();
  });
  window.addEventListener("resize", () => requestAnimationFrame(drawCharts));

  applyRecordingPreset();
  updateRecording();
  updateSourceMode();
  Promise.all([loadConfig(), refreshState({ announceError: false })]).finally(schedulePolling);
})();
