import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { CHAT_VIEWTYPE } from "../webview/ChatPanel";

// Runs inside the extension host (see lifecycle.ts for the harness). Covers
// the main.ts commands observable without a visible UI: panel/view/terminal
// creation and reuse. Effects that only exist inside the webview DOM (the
// insert-text, new-session, and toggle-context posts) are asserted as
// "command resolves without error" — the DOM is unreachable from the host.

type HubState = { kind: string; url?: string; message?: string };
type Api = {
  hub: { state: HubState };
  provider: {
    isViewVisible: boolean;
    sidebarType: "primary" | "auxiliary" | null;
  };
  serverPort: number | undefined;
  ensureServer: () => void;
};

function isChatTab(tab: vscode.Tab): boolean {
  const viewType = (tab.input as { viewType?: string } | undefined)?.viewType;
  // A restored tab reports VS Code's internal prefix (see main.ts's
  // isChatTab); match both forms.
  return viewType === CHAT_VIEWTYPE || viewType === `mainThreadWebview-${CHAT_VIEWTYPE}`;
}

function chatTabCount(): number {
  return vscode.window.tabGroups.all.reduce(
    (n, g) => n + g.tabs.filter(isChatTab).length,
    0,
  );
}

async function until(pred: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("condition not met in time");
}

async function hubUrl(api: Api, timeoutMs = 90_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = api.hub.state;
    if (s.kind === "url" && s.url) return s.url;
    if (s.kind === "error") throw new Error(`server errored: ${s.message}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("timed out waiting for server url");
}

async function closeEditorFor(uri: vscode.Uri): Promise<void> {
  const tab = vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => {
    const input = t.input as { uri?: unknown } | undefined;
    return input?.uri instanceof vscode.Uri && input.uri.toString() === uri.toString();
  });
  if (tab) await vscode.window.tabGroups.close(tab);
}

suite("opencode GUI commands", function () {
  let api: Api;
  const ws = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const scratch = vscode.Uri.file(path.join(ws, "oc-commands-test-scratch.txt"));

  suiteSetup(async function () {
    const ext = vscode.extensions.getExtension("chinese-room-solutions.vsc-opencode-gui")!;
    api = (await ext.activate()) as Api;
  });

  test("openChat opens a single chat editor tab", async function () {
    await vscode.commands.executeCommand("opencodeGui.openChat");
    await until(() => chatTabCount() === 1);
    assert.strictEqual(chatTabCount(), 1, "singleton tab");
  });

  test("toggleChat closes the active tab and opens it again", async function () {
    await vscode.commands.executeCommand("opencodeGui.toggleChat");
    await until(() => chatTabCount() === 0);
    await vscode.commands.executeCommand("opencodeGui.toggleChat");
    await until(() => chatTabCount() === 1);
  });

  test("toggleChatView hides the revealed sidebar view", async function () {
    // Focus our view first (the toggle's reveal branch depends on which
    // view the bars last showed — not ours to control headless).
    await vscode.commands.executeCommand("opencodeGui.chatView.focus");
    await until(() => api.provider.isViewVisible);
    assert.ok(api.provider.isViewVisible, "sidebar view resolved and visible");
    // The container lives in the primary activity-bar sidebar; say so the
    // way revealSidePanel would have (it is the only writer, and it has
    // not run — a view opened without the command keeps sidebarType null).
    api.provider.sidebarType = "primary";
    await vscode.commands.executeCommand("opencodeGui.toggleChatView");
    await until(() => !api.provider.isViewVisible);
  });

  test("newSession and openContextSummary resolve with a chat target", async function () {
    await vscode.commands.executeCommand("opencodeGui.newSession");
    await vscode.commands.executeCommand("opencodeGui.openContextSummary");
    assert.strictEqual(chatTabCount(), 1, "chat target still there");
  });

  test("addSelectionToChat and addToChat resolve and keep a chat target", async function () {
    fs.writeFileSync(scratch.fsPath, "alpha\nbeta\ngamma\n");
    try {
      const doc = await vscode.workspace.openTextDocument(scratch);
      const editor = await vscode.window.showTextDocument(doc);
      editor.selection = new vscode.Selection(0, 0, 1, 4); // multi-line
      await vscode.commands.executeCommand("opencodeGui.addSelectionToChat");
      editor.selection = new vscode.Selection(2, 2, 2, 2); // cursor only
      await vscode.commands.executeCommand("opencodeGui.addSelectionToChat");
      await vscode.commands.executeCommand("opencodeGui.addToChat", doc.uri);
      assert.strictEqual(chatTabCount(), 1, "chat target still there");
    } finally {
      await closeEditorFor(scratch);
    }
  });

  test("openTerminal creates one reused opencode terminal", async function () {
    const gui = vscode.workspace.getConfiguration("opencodeGui");
    // A missing path with a space exercises the config lookup and the
    // Windows quoting branch without launching a real TUI.
    await gui.update(
      "path",
      "C:\\oc test bin\\opencode-fake.exe",
      vscode.ConfigurationTarget.Global,
    );
    try {
      const live = () =>
        vscode.window.terminals.filter((t) => t.name === "opencode" && !t.exitStatus);
      await vscode.commands.executeCommand("opencodeGui.openTerminal");
      await until(() => live().length === 1);
      const first = live()[0];
      await vscode.commands.executeCommand("opencodeGui.openTerminal");
      await until(() => live().length === 1);
      assert.strictEqual(live()[0], first, "terminal reused, not duplicated");
    } finally {
      await gui.update("path", "", vscode.ConfigurationTarget.Global);
      await new Promise((r) => setTimeout(r, 500));
      for (const t of vscode.window.terminals.filter((t) => t.name === "opencode")) {
        t.dispose();
      }
      await vscode.commands
        .executeCommand("workbench.action.closeAllNotifications")
        .then(undefined, () => {});
    }
  });

  test("showHistory reaches the session picker and stays pending", async function () {
    await vscode.commands.executeCommand("opencodeGui.openChat");
    const url = await hubUrl(api);
    // The picker needs at least one session; seed one only when the project
    // has none (no model turns involved).
    const sessions = await (await fetch(`${url}/session`)).json();
    if (!Array.isArray(sessions) || sessions.length === 0) {
      const res = await fetch(`${url}/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.ok(res.ok, "seed session created");
    }
    let settled = false;
    const picker = vscode.commands
      .executeCommand("opencodeGui.showHistory")
      .then(
        () => (settled = true),
        () => (settled = true),
      );
    await new Promise((r) => setTimeout(r, 5000));
    assert.strictEqual(settled, false, "history picker open (awaiting selection)");
    // Left pending on purpose — the window closes right after and abandons
    // it (same leak lifecycle.ts's manageModels test makes).
    void picker;
  });

  suiteTeardown(async function () {
    fs.rmSync(scratch.fsPath, { force: true });
    for (const t of vscode.window.terminals.filter((t) => t.name === "opencode")) {
      t.dispose();
    }
  });
});
