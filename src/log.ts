import * as vscode from "vscode";

// Diagnostics channel ("OpenCode" in the Output pane). In-memory only —
// nothing is written to disk, so there is no log growth to manage.
let channel: vscode.LogOutputChannel | undefined;

export function initLog(context: vscode.ExtensionContext): void {
  channel = vscode.window.createOutputChannel("OpenCode", { log: true });
  context.subscriptions.push(channel);
}

function fmt(args: unknown[]): string {
  return args
    .map((a) => (a instanceof Error ? a.stack ?? a.message : String(a)))
    .join(" ");
}

export const log = {
  info: (...args: unknown[]) => channel?.info(fmt(args)),
  warn: (...args: unknown[]) => channel?.warn(fmt(args)),
  error: (...args: unknown[]) => channel?.error(fmt(args)),
};
