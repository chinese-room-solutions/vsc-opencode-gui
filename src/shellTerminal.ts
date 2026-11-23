import * as vscode from "vscode";
import { serverAuthHeaders } from "./server/serverAuth";

// A background command's output in a read-only VS Code terminal: the full
// scrollback with colors, progress lines, and the terminal's own find,
// where the roster's pane only shows the end as plain text. Streams from
// the start through the same output API the pane polls, then prints how
// the command ended. Closing the terminal only closes the view; the stop
// stays in the roster.

export interface ShellRef {
  id: string;
  command: string;
  directory?: string;
}

// One terminal per command: a second open reveals it.
const open = new Map<string, { terminal: vscode.Terminal; stop: () => void }>();

// How a command ended, in the roster's terms.
function endLabel(info: { status?: unknown; exit?: unknown }): string {
  if (info.status === "killed") return "Stopped";
  if (info.status === "timeout") return "Timed out";
  if (typeof info.exit === "number" && info.exit !== 0) return `Exit ${info.exit}`;
  return "Finished";
}

export function showShellTerminal(serverUrl: string, shell: ShellRef): void {
  const shown = open.get(shell.id);
  if (shown) {
    shown.terminal.show();
    return;
  }
  const write = new vscode.EventEmitter<string>();
  const base = `${serverUrl}/api/shell/${encodeURIComponent(shell.id)}`;
  const loc = shell.directory
    ? `location%5Bdirectory%5D=${encodeURIComponent(shell.directory)}`
    : "";
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let cursor = 0;
  let failures = 0;
  let ending: string | undefined;
  let atLineStart = true;

  // xterm needs CRLF: a bare LF moves down without returning.
  const out = (text: string) => {
    if (!text) return;
    write.fire(text.replace(/\r?\n/g, "\r\n"));
    atLineStart = text.endsWith("\n");
  };
  const finish = (label: string) => {
    write.fire(`${atLineStart ? "" : "\r\n"}\x1b[90m[${label}]\x1b[0m\r\n`);
    stop();
  };
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
  };
  const later = (ms: number) => {
    if (!stopped) timer = setTimeout(() => void step(), ms);
  };
  // 404 means the server no longer knows the command.
  const get = async (path: string) => {
    const res = await fetch(`${base}${path}`, {
      headers: serverAuthHeaders(),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { data?: Record<string, unknown> };
    return (body.data ?? body) as Record<string, unknown>;
  };

  const step = async (): Promise<void> => {
    try {
      const page = await get(`/output?cursor=${cursor}${loc ? `&${loc}` : ""}`);
      if (stopped) return;
      // A stop removes the command, output included.
      if (!page)
        return finish(ending ?? (cursor > 0 ? "Ended" : "Output is not available"));
      failures = 0;
      if (typeof page.output === "string") out(page.output);
      if (typeof page.cursor === "number") cursor = page.cursor;
      // Pages cap at 64 KB: catch up before waiting.
      if (typeof page.size === "number" && cursor < page.size) return later(0);
      if (ending) return finish(ending);
      const info = await get(loc ? `?${loc}` : "");
      if (stopped) return;
      if (!info) return finish("Ended");
      if (info.status === "running") return later(1000);
      // Drain what landed between the read and the exit before the label.
      ending = endLabel(info);
      return later(0);
    } catch (err) {
      if (stopped) return;
      // A restart kills its commands too: stop retrying after ~30 s.
      if (++failures >= 30)
        return finish(
          `Lost the server: ${err instanceof Error ? err.message : String(err)}`,
        );
      later(1000);
    }
  };

  // A long title crowds the panel's own tabs out.
  const line = shell.command.split("\n")[0].trim();
  const terminal = vscode.window.createTerminal({
    name: line.length > 40 ? `${line.slice(0, 39)}…` : line,
    iconPath: new vscode.ThemeIcon("terminal"),
    // The stream doesn't survive a reload, so the terminal doesn't either.
    isTransient: true,
    pty: {
      onDidWrite: write.event,
      // Read-only: no cursor.
      open: () => {
        write.fire("\x1b[?25l");
        void step();
      },
      close: () => {
        stop();
        open.delete(shell.id);
        write.dispose();
      },
    },
  });
  open.set(shell.id, { terminal, stop });
  terminal.show();
}

// Deactivation closes every command terminal and its poll.
export function disposeShellTerminals(): void {
  for (const { terminal, stop } of open.values()) {
    stop();
    terminal.dispose();
  }
  open.clear();
}
