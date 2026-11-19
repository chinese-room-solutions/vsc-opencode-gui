import * as vscode from "vscode";

// The window's folder (workspaceFolders[0]) as the server spells it. VS Code
// lowercases a Windows drive letter in fsPath. The server runs in the
// uppercase form (opencode v2's instruction scan stack-overflows on a
// lowercase drive at boot), and v2 keys a location by its exact directory:
// a lowercase location query reads an empty twin location.
export function workspaceDir(): string | undefined {
  const p = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return process.platform === "win32" && p && /^[a-z]:/.test(p)
    ? p[0].toUpperCase() + p.slice(1)
    : p;
}
