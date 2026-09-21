import { readFile } from "node:fs/promises";
import { Terminal } from "@xterm/headless";

const [id, action = "screen", input = ""] = process.argv.slice(2);
const root = process.env.TASKGROUND_RUNS_ROOT ?? "/Users/mericungor/.local/share/taskground/f1269136c384/runs";
const endpoint = JSON.parse(await readFile(`${root}/${id}/terminal.json`, "utf8"));
const socket = new WebSocket(`ws://127.0.0.1:${endpoint.port}`, ["taskground", endpoint.token]);
const timeout = setTimeout(() => { socket.close(); process.exitCode = 1; }, 10000);
let sent = false;
socket.onmessage = async event => {
  const message = JSON.parse(String(event.data));
  if (message.type === "snapshot" && action === "screen") {
    const terminal = new Terminal({ cols: message.cols, rows: message.rows, allowProposedApi: true });
    await new Promise<void>(resolve => terminal.write(message.data, resolve));
    console.log(Array.from({ length: terminal.rows }, (_, i) => terminal.buffer.active.getLine(terminal.buffer.active.baseY + i)?.translateToString(true)).join("\n"));
    terminal.dispose(); socket.close(); clearTimeout(timeout);
  } else if (message.type === "control" && action === "input") {
    if (!message.attached) socket.send(JSON.stringify({ type: "attach" }));
    else if (!sent) {
      sent = true;
      socket.send(JSON.stringify({ type: "input", data: JSON.parse(input) }));
      setTimeout(() => { socket.close(); clearTimeout(timeout); }, 250);
    }
  }
};
