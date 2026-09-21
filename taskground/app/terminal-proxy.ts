import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import type { RunRecord } from "./runner";
import { readTerminalEndpoint } from "./terminal";

export interface TerminalBridge {
  run: RunRecord;
  upstream?: WebSocket;
  closed?: boolean;
}

const MAX_BUFFER = 2 * 1024 * 1024;
const active = new Set(["preparing", "starting", "running"]);

function send(socket: ServerWebSocket<TerminalBridge>, data: string) {
  if (socket.data.closed) return;
  if (socket.getBufferedAmount() > MAX_BUFFER) {
    socket.close(1013, "Terminal viewer is too slow; reconnect for the current screen");
    return;
  }
  socket.send(data);
}

/** Only expanded terminal panes create a bridge; the supervisor owns the PTY. */
export const terminalBridgeHandlers = {
  maxPayloadLength: 32768,
  backpressureLimit: MAX_BUFFER,
  closeOnBackpressureLimit: true,
  idleTimeout: 120,
  sendPings: true,
  async open(socket: ServerWebSocket<TerminalBridge>) {
    const { run } = socket.data;
    try {
      if (!active.has(run.status)) {
        const screen = await readFile(join(run.directory, "terminal-screen.json"), "utf8").then(JSON.parse).catch(() => undefined);
        if (screen) send(socket, JSON.stringify({ ...screen, type: "snapshot" }));
        else send(socket, JSON.stringify({ type: "error", message: run.error || "This run stopped before a terminal screen was saved." }));
        send(socket, JSON.stringify({ type: "exit", exitCode: run.exitCode ?? null }));
        socket.close(1000, "Session finished");
        return;
      }
      const endpoint = await readTerminalEndpoint(run.directory);
      if (socket.data.closed) return;
      if (!endpoint) throw new Error("Terminal is preparing; reconnect shortly");
      const upstream = new WebSocket(`ws://127.0.0.1:${endpoint.port}/`, ["taskground", endpoint.token]);
      socket.data.upstream = upstream;
      upstream.onmessage = event => {
        if (typeof event.data === "string") send(socket, event.data);
      };
      upstream.onerror = () => {
        send(socket, JSON.stringify({ type: "error", message: "Terminal connection unavailable; reconnecting will restore the screen" }));
        socket.close(1011, "Terminal disconnected");
      };
      upstream.onclose = () => { if (!socket.data.closed) socket.close(1000, "Terminal disconnected"); };
    } catch (error) {
      send(socket, JSON.stringify({ type: "error", message: error instanceof Error ? error.message : String(error) }));
      socket.close(1011, "Terminal unavailable");
    }
  },
  message(socket: ServerWebSocket<TerminalBridge>, message: string | Buffer) {
    const upstream = socket.data.upstream;
    if (typeof message !== "string" || message.length > 32768) { socket.close(1009, "Invalid terminal message"); return; }
    if (upstream?.readyState !== WebSocket.OPEN) return;
    if (upstream.bufferedAmount > MAX_BUFFER) { socket.close(1013, "Terminal input is too fast"); return; }
    upstream.send(message);
  },
  close(socket: ServerWebSocket<TerminalBridge>) {
    socket.data.closed = true;
    socket.data.upstream?.close();
  },
};
