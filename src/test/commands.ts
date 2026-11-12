import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
  type SessionPanels,
  sessionTabId,
  sessionViewType,
} from "../webview/ChatPanel";

// Runs inside the extension host (see lifecycle.ts for the harness). Covers
// the main.ts commands observable without a visible UI: session panels,
// view/terminal creation and reuse. Effects that only exist inside the
// webview DOM (the insert-text post reaching the composer) are asserted as
// "command resolves and a panel exists" — the DOM is unreachable from the
// host.

type HubState = {
  kind: string;
  url?: string;
  message?: string;
  dialect?: "v1" | "v2";
};
type Api = {
  hub: { state: HubState };
  provider: {
    isViewVisible: boolean;
    sidebarType: "primary" | "auxiliary" | null;
  };
  panels: SessionPanels;
  serverPort: number | undefined;
  ensureServer: () => void;
  authHeaders: () => Record<string, string>;
};

function sessionTabCount(): number {
  return vscode.window.tabGroups.all.reduce(
    (n, g) => n + g.tabs.filter((t) => sessionTabId(t) !== undefined).length,
    0,
  );
}

function tabFor(id: string): vscode.Tab | undefined {
  return vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .find((t) => sessionTabId(t) === id);
}

async function until(
  pred: () => boolean,
  ms = 20_000,
): Promise<void> {
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

  test("sessionTabId reads live and restored-but-unclaimed tab forms", function () {
    const live = { input: { viewType: sessionViewType("ses_1") } };
    const pending = {
      input: { viewType: `mainThreadWebview-${sessionViewType("ses_2")}` },
    };
    const foreign = { input: { viewType: "opencodeGui.chatPanel" } };
    const none = { input: { viewType: undefined } };
    assert.strictEqual(sessionTabId(live as never), "ses_1");
    assert.strictEqual(sessionTabId(pending as never), "ses_2");
    assert.strictEqual(sessionTabId(foreign as never), undefined);
    assert.strictEqual(sessionTabId(none as never), undefined);
  });

  test("newSession creates a session and opens its own editor tab", async function () {
    await vscode.commands.executeCommand("opencodeGui.newSession");
    await until(() => api.panels.ids().length === 1);
    const id = api.panels.ids()[0];
    assert.ok(id, "a session was created");
    assert.ok(api.panels.has(id), "panel registered for it");
    await until(() => tabFor(id) !== undefined);
    // The Tab API reports webview inputs with a mainThreadWebview- prefix
    // even for live panels; sessionTabId is the seam that folds it.
    assert.strictEqual(
      sessionTabId(tabFor(id)!),
      id,
      "the tab's viewType embeds the session id",
    );
    assert.strictEqual(api.panels.lastActiveId, id, "opened as last-active");
    // The tab never keeps the raw id: a session the server hasn't titled
    // reads "New session" (the app's own label for empty titles), set
    // from the host's at-open fetch.
    await until(() => api.panels.get(id)?.title === "New session");
    assert.strictEqual(api.panels.get(id)?.title, "New session");
    // The blank rule revival and the history picker lean on: a fresh
    // session (no messages, row never touched) is blank; an unknown id
    // fails open.
    const sm = api.ensureServer() as unknown as {
      isBlankSession(id: string): Promise<boolean>;
    } | undefined;
    assert.ok(sm, "ensureServer returns the manager");
    // isBlankSession fails open ("not blank") on any fetch blip, so a
    // single sample conflates server health with session state — poll to
    // steady state, then assert. A genuinely non-blank session still
    // fails after the window.
    let blank: boolean | undefined;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      blank = await sm!.isBlankSession(id);
      if (blank) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.strictEqual(blank, true, "fresh session is blank");
    assert.strictEqual(
      await sm!.isBlankSession("ses_doesnotexist"),
      false,
      "unknown session fails open",
    );
  });

  test("a second session opens a second panel; closing one leaves the other", async function () {
    await vscode.commands.executeCommand("opencodeGui.newSession");
    await until(() => api.panels.ids().length === 2);
    const [first, second] = api.panels.ids();
    assert.notStrictEqual(first, second);
    await until(() => tabFor(first) !== undefined && tabFor(second) !== undefined);
    assert.strictEqual(sessionTabCount(), 2, "two session tabs");

    const tab = tabFor(first)!;
    await vscode.window.tabGroups.close(tab);
    await until(() => !api.panels.has(first));
    assert.ok(api.panels.has(second), "the other panel survives");
    assert.strictEqual(sessionTabCount(), 1, "one session tab left");
  });

  test("toggleChat closes the active session panel, then opens a fresh session", async function () {
    const before = api.panels.ids().length;
    assert.ok(before > 0, "a panel is open from the earlier tests");
    // toggleChat's close branch needs a session tab as the active editor.
    const target = api.panels.target();
    assert.ok(target, "a target panel exists");
    target.reveal();
    await until(() => tabFor(target.id)?.isActive === true);
    await vscode.commands.executeCommand("opencodeGui.toggleChat");
    await until(() => api.panels.ids().length === before - 1);
    await vscode.commands.executeCommand("opencodeGui.toggleChat");
    await until(() => api.panels.ids().length === before);
    assert.strictEqual(sessionTabCount(), before, "session tabs restored");
  });

  test("openChat reveals a session panel (never zero after one exists)", async function () {
    await vscode.commands.executeCommand("opencodeGui.openChat");
    await until(() => api.panels.ids().length > 0);
    const count = api.panels.ids().length;
    await vscode.commands.executeCommand("opencodeGui.openChat");
    await new Promise((r) => setTimeout(r, 500));
    assert.strictEqual(api.panels.ids().length, count, "reveal reuses the panel");
  });

  test("tab menu commands: copy id lands on the clipboard, fork rejects an empty session cleanly", async function () {
    await hubUrl(api);
    const target = api.panels.target();
    assert.ok(target, "a panel to act on");
    // copySessionId (no tab-context arg: falls back to the active panel).
    await vscode.commands.executeCommand("opencodeGui.copySessionId");
    assert.strictEqual(
      await vscode.env.clipboard.readText(),
      target.id,
      "the active session's id",
    );
    // forkSession on an empty session (no turns): the command refuses
    // blanks locally (the isBlankSession pre-check) — the panel set is
    // unchanged, no hang, no throw, no forked empty copy on v1.
    const before = api.panels.ids().length;
    await vscode.commands.executeCommand("opencodeGui.forkSession");
    await new Promise((r) => setTimeout(r, 1_000));
    assert.strictEqual(
      api.panels.ids().length,
      before,
      "no panel opened for a rejected fork",
    );
  });

  test("tab menu commands: the tab-context arg resolves the clicked session tab", async function () {
    if (api.panels.ids().length < 2) {
      await vscode.commands.executeCommand("opencodeGui.newSession");
      await until(() => api.panels.ids().length >= 2);
    }
    await until(() => api.panels.ids().every((id) => tabFor(id) !== undefined));
    // The tab the menu arg will name: a session tab that is not the
    // active one — the shipped bug acted on the active panel instead.
    const active = api.panels.target();
    assert.ok(active, "an active session panel");
    const clicked = api.panels.ids().find((id) => id !== active.id);
    assert.ok(clicked, "a second, inactive session tab");
    const spotOf = (pred: (t: vscode.Tab) => boolean): number => {
      for (const g of vscode.window.tabGroups.all) {
        const i = g.tabs.findIndex(pred);
        if (i !== -1) return i;
      }
      return -1;
    };
    const clickedIdx = spotOf((t) => sessionTabId(t) === clicked);
    assert.ok(clickedIdx >= 0, "the clicked tab's index");
    // The real menu shape, captured from a live right-click (VS Code
    // 1.146): a leading webview-panel Uri, then the context object.
    const menuUri = vscode.Uri.parse("webview-panel:webview-panel/webview-x");
    await vscode.commands.executeCommand("opencodeGui.copySessionId", menuUri, {
      groupId: 0,
      editorIndex: clickedIdx,
    });
    let clip = "";
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      clip = await vscode.env.clipboard.readText();
      if (clip === clicked) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.strictEqual(clip, clicked, "the right-clicked session's id");

    // A non-session tab's index: no candidate resolves, and the command
    // no-ops rather than falling back to the active session.
    fs.writeFileSync(scratch.fsPath, "tab-menu\n");
    try {
      const doc = await vscode.workspace.openTextDocument(scratch.fsPath);
      await vscode.window.showTextDocument(doc);
      const docIdx = spotOf(
        (t) =>
          (t.input as { uri?: unknown } | undefined)?.uri instanceof vscode.Uri &&
          (t.input as { uri: vscode.Uri }).uri.toString() === doc.uri.toString(),
      );
      assert.ok(docIdx >= 0, "the text tab's index");
      await vscode.env.clipboard.writeText("sentinel");
      await vscode.commands.executeCommand("opencodeGui.copySessionId", menuUri, {
        groupId: 0,
        editorIndex: docIdx,
      });
      await new Promise((r) => setTimeout(r, 1_000));
      assert.strictEqual(
        await vscode.env.clipboard.readText(),
        "sentinel",
        "no write when the clicked tab is not a session",
      );
    } finally {
      await closeEditorFor(scratch);
    }
  });

  test("tab menu commands: same-index session tabs in two groups resolve to the active group", async function () {
    // The documented corner: the menu's groupId is VS Code's internal id
    // with no public map, so when two groups each hold a session tab at
    // the right-clicked index the tie-break picks the ACTIVE group's —
    // right-clicking the other group's tab there still points at this
    // session. This spec pins that as known behavior; if it starts
    // failing, the tie-break changed, not the fix.
    assert.ok(
      api.panels.ids().length >= 2,
      "two session tabs in one group from the earlier tests",
    );
    fs.writeFileSync(scratch.fsPath, "tab-menu-ambiguity\n");
    let group2Session: string | undefined;
    try {
      const doc = await vscode.workspace.openTextDocument(scratch.fsPath);
      await vscode.window.showTextDocument(doc);
      // Split on a text editor: the copy lands in a second group. Focus
      // that group and wait for the active column to settle — a session
      // panel opens in the ACTIVE group, and the split's focus move
      // races the next executeCommand.
      await vscode.commands.executeCommand("workbench.action.splitEditor");
      await until(() => vscode.window.tabGroups.all.length === 2);
      const homeColumn = vscode.window.tabGroups.all.find((g) =>
        g.tabs.some((t) => sessionTabId(t) === api.panels.ids()[0]),
      )!.viewColumn;
      const other =
        vscode.window.tabGroups.all.find((g) => g.viewColumn !== homeColumn)!;
      await vscode.commands.executeCommand(
        vscode.window.tabGroups.all.indexOf(other) === 1
          ? "workbench.action.focusSecondEditorGroup"
          : "workbench.action.focusFirstEditorGroup",
      );
      await until(
        () => vscode.window.tabGroups.activeTabGroup.viewColumn === other.viewColumn,
      );
      // newSession's handler fires and forgets, so wait for the panel
      // itself — the ids list grows only when the open completes.
      const beforeCount = api.panels.ids().length;
      await vscode.commands.executeCommand("opencodeGui.newSession");
      await until(() => api.panels.ids().length === beforeCount + 1);
      group2Session = api.panels.ids()[api.panels.ids().length - 1];
      await until(() => tabFor(group2Session!) !== undefined);
      const spotOf = (id: string): { column: number; index: number } | undefined => {
        for (const g of vscode.window.tabGroups.all) {
          const i = g.tabs.findIndex((t) => sessionTabId(t) === id);
          if (i !== -1) return { column: g.viewColumn, index: i };
        }
        return undefined;
      };
      const g2 = spotOf(group2Session);
      assert.ok(g2, "the new session's tab");
      const g1 = api.panels
        .ids()
        .filter((id) => id !== group2Session)
        .map(spotOf)
        .find((s) => s && s.column !== g2.column && s.index === g2.index);
      assert.ok(g1, "a session tab at the same index in another group");
      // groupId 4242 matches no column, so the tie-break chain runs to
      // the active group — the one the reveal just activated.
      await vscode.commands.executeCommand(
        "opencodeGui.copySessionId",
        vscode.Uri.parse("webview-panel:webview-panel/webview-x"),
        { groupId: 4242, editorIndex: g2.index },
      );
      let clip = "";
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        clip = await vscode.env.clipboard.readText();
        if (clip === group2Session) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      assert.strictEqual(
        clip,
        group2Session,
        "the ambiguous index resolves to the active group's session",
      );
    } finally {
      if (group2Session) {
        const tab = tabFor(group2Session);
        if (tab) await vscode.window.tabGroups.close(tab);
        await until(() => !api.panels.has(group2Session!));
      }
      // Group 2's scratch copy died with its last tab; close group 1's.
      await closeEditorFor(scratch);
    }
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

  test("addSelectionToChat and addToChat resolve and keep a session target", async function () {
    fs.writeFileSync(scratch.fsPath, "alpha\nbeta\ngamma\n");
    try {
      const doc = await vscode.workspace.openTextDocument(scratch);
      const editor = await vscode.window.showTextDocument(doc);
      editor.selection = new vscode.Selection(0, 0, 1, 4); // multi-line
      await vscode.commands.executeCommand("opencodeGui.addSelectionToChat");
      editor.selection = new vscode.Selection(2, 2, 2, 2); // cursor only
      await vscode.commands.executeCommand("opencodeGui.addSelectionToChat");
      await vscode.commands.executeCommand("opencodeGui.addToChat", doc.uri);
      assert.ok(api.panels.ids().length > 0, "chat target still there");
    } finally {
      await closeEditorFor(scratch);
    }
  });

  test("restart keeps the open panels mapped to their sessions", async function () {
    const before = [...api.panels.ids()];
    assert.ok(before.length > 0, "a panel is open from the earlier tests");
    await vscode.commands.executeCommand("opencodeGui.restart");
    const url = await hubUrl(api);
    assert.ok(url, "server back after restart");
    assert.deepStrictEqual(api.panels.ids(), before, "panels unchanged");
    for (const id of before) assert.ok(tabFor(id), `tab still there for ${id}`);
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
    // The newSession tests above created sessions through the extension's
    // own create path — all blank, and blank sessions are hidden from the
    // picker now (the navigator's rule). Title one over the API (the
    // extension's rename call) so the picker has a row to list; the
    // spawn password lives inside the extension bundle's module state, so
    // the direct fetch borrows activate()'s auth headers.
    const url = await hubUrl(api);
    const res = await fetch(`${url}/api/session`, {
      method: "POST",
      headers: { ...api.authHeaders(), "content-type": "application/json" },
      body: "{}",
    });
    assert.ok(res.ok, `session created (${res.status})`);
    const sid = ((await res.json()) as { data?: { id?: string } }).data?.id;
    assert.ok(sid, "session id in the reply");
    const patch = await fetch(`${url}/api/session/${sid}`, {
      method: "PATCH",
      headers: { ...api.authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ title: "Seeded for the picker" }),
    });
    assert.ok(patch.ok, `session titled (${patch.status})`);
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
