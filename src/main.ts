import * as vscode from "vscode";
import * as fs from "fs";
import { OpencodeViewProvider } from "./webview/OpencodeViewProvider";
import { ChatHub } from "./webview/ChatHub";
import {
  SessionPanels,
  sessionTabId,
} from "./webview/ChatPanel";
import { PeerRegistry } from "./webview/Peers";
import { TabIconSet } from "./webview/TabSignal";
import type {
  HiddenModels,
  HiddenProviders,
  OpenProjectHandler,
  ProjectStore,
} from "./webview/AppHost";
import { ServerManager, normWorktree, randomPort } from "./server/ServerManager";
import { serverAuthHeaders } from "./server/serverAuth";
import { invalidateThemeTokens } from "./theme";
import { initLog, log } from "./log";

let serverManager: ServerManager | undefined;

function copyModifierSetting(): string {
  return vscode.workspace
    .getConfiguration("opencodeGui")
    .get<string>("codeCopyModifier", "alt");
}

function readySoundSetting(): boolean {
  return vscode.workspace
    .getConfiguration("opencodeGui")
    .get<boolean>("readySound", true);
}

function permissionSoundSetting(): boolean {
  return vscode.workspace
    .getConfiguration("opencodeGui")
    .get<boolean>("permissionSound", true);
}

function questionSoundSetting(): boolean {
  return vscode.workspace
    .getConfiguration("opencodeGui")
    .get<boolean>("questionSound", true);
}

const SIDEBAR_CMDS = {
  primary: "workbench.action.toggleSidebarVisibility",
  auxiliary: "workbench.action.toggleAuxiliaryBar",
} as const;

// Returns { hub, provider } as the extension API — the test harness drives
// and inspects the chat state through it.
export function activate(context: vscode.ExtensionContext) {
  initLog(context);
  // Shared chat state + the server event-stream pumps, fanned out to the
  // sidebar and every session panel.
  const hub = new ChatHub();
  context.subscriptions.push(hub);

  // opencode-peers registry: names inbound peer-card senders.
  // A 10 s poll rides the plugin's own heartbeat cadence, so peer and
  // session renames reach open cards without a watcher.
  const peerRegistry = new PeerRegistry((peers) => hub.setPeers(peers));
  peerRegistry.start();
  context.subscriptions.push(peerRegistry);

  // Last-active session route (per-folder workspaceState, so no
  // cross-folder checks): one editor panel per session now, and the active
  // panel writes this — commands read it.
  const routeStore = {
    get: () => context.workspaceState.get<string>("opencode.route"),
    set: (value: string) => void context.workspaceState.update("opencode.route", value),
  };

  // Open session panels' ids (same workspaceState): a reload registers one
  // revival serializer per id, so the tabs come back as their own panels.
  const tabsStore = {
    get: () =>
      (context.workspaceState.get<unknown[]>("opencode.tabs") ?? []).filter(
        (t): t is string => typeof t === "string",
      ),
    set: (value: string[]) =>
      void context.workspaceState.update("opencode.tabs", value),
  };

  // Deleted-project tombstones (globalState, so they survive in every
  // window): normalized folder paths, newest first, capped. Baked into the
  // page so Home hides the rows.
  const tombstoneList = () =>
    (context.globalState.get<string[]>("opencode.projectTombstones") ?? []).filter(
      (p) => typeof p === "string",
    );
  const projectStore: ProjectStore = {
    list: () => tombstoneList(),
    tombstoned: (p) => tombstoneList().some((t) => t === normWorktree(p)),
    tombstone: (p) => {
      void context.globalState.update("opencode.projectTombstones", [
        normWorktree(p),
        ...tombstoneList().filter((t) => t !== normWorktree(p)),
      ].slice(0, 50));
    },
  };

  // Cross-window project opening: stash the session deep-link just before
  // VS Code opens the folder; the target window consumes it in activate().
  const openProject: OpenProjectHandler = async (folder, session) => {
    if (session) {
      await context.globalState.update("opencode.pendingOpen", {
        worktree: folder,
        session,
        ts: Date.now(),
      });
    }
    await vscode.commands.executeCommand(
      "vscode.openFolder",
      vscode.Uri.file(folder),
      { forceNewWindow: true },
    );
  };

  // Model rows the webview picker hides (Manage Models). globalState: model
  // availability is machine-wide, like the stored server port. Baked into
  // the page on every render; setHiddenModels pushes changes to the live
  // webviews (the provider and any panels exist by then — the only caller
  // is the command below).
  const hiddenModels: HiddenModels = {
    get: () =>
      (context.globalState.get<string[]>("opencode.hiddenModels") ?? []).filter(
        (r): r is string => typeof r === "string",
      ),
  };
  const setHiddenModels = (refs: string[]) => {
    void context.globalState.update("opencode.hiddenModels", refs);
    provider.chat.setHiddenModels(refs);
    for (const p of panels.all()) p.chat.setHiddenModels(refs);
  };

  // Providers the webview picker hides (Manage Providers) — bare providerID
  // refs, same lifecycle as the hidden models list.
  const hiddenProviders: HiddenProviders = {
    get: () =>
      (
        context.globalState.get<string[]>("opencode.hiddenProviders") ?? []
      ).filter((r): r is string => typeof r === "string"),
  };
  const setHiddenProviders = (refs: string[]) => {
    void context.globalState.update("opencode.hiddenProviders", refs);
    provider.chat.setHiddenProviders(refs);
    for (const p of panels.all()) p.chat.setHiddenProviders(refs);
  };

  // Start the opencode server lazily, on first chat use: a server spawn
  // registers its cwd as a project in opencode's shared DB, so activating
  // in every window would litter the Home project list with folders the
  // user never chatted in.
  const syncAfterReady = async () => {
    const sm = serverManager;
    if (!sm) return;
    let changed = false;
    try {
      changed = await sm.syncModelAgents();
    } catch (err) {
      log.error("model agent sync failed:", err);
    }
    if (changed && serverManager === sm) {
      // v2 watches the config directories — agent files hot-apply, and
      // the reload route hurries the watcher. A restart here killed the
      // server right after every boot: the staged v2 catalog made each
      // sync rewrite the file set, reconnecting the UI several times per
      // startup before the files settled.
      if (sm.dialect === "v2") {
        await sm.hurryConfigReload();
        return;
      }
      // v1 reads agents at boot only — restart so the server picks them
      // up. The next start finds the files up-to-date: no loop.
      serverManager = undefined;
      await sm.dispose();
      hub.setLoading();
      ensureServer();
    }
  };

  // A long-lived server that dies on its own (crash, OOM kill) comes
  // straight back, like the failed-fetch retry in any other client.
  const wireUnexpectedExit = (sm: ServerManager) => {
    sm.onUnexpectedExit = () => {
      if (serverManager !== sm) return;
      log.error("server exited unexpectedly — respawning");
      serverManager = undefined;
      // Dispose first (same as the agent-sync restart): clears the dead
      // manager's lease heartbeat and proves the port free before the
      // replacement binds it.
      void sm.dispose().then(() => {
        if (serverManager !== undefined) return;
        hub.setLoading();
        ensureServer();
      });
    };
  };

  const ensureServer = (): ServerManager | undefined => {
    if (serverManager) return serverManager;
    const sm = new ServerManager();
    wireUnexpectedExit(sm);
    serverManager = sm;
    // Reuse the stored port so the webview origin (localStorage) survives
    // restarts and crash-respawns — the stored value tracks any port move
    // a boot made, so read it (and the other settings) per spawn, not once
    // at activation. globalState keeps every workspace on the same origin.
    const cfg = vscode.workspace.getConfiguration("opencodeGui");
    const userPort = cfg.get<number>("port", 0);
    const port =
      userPort > 0
        ? userPort
        : (context.globalState.get<number>("opencode.serverPort") ??
          randomPort());
    void sm.start(
      hub,
      context,
      port,
      cfg.get<boolean>("exposeToNetwork", false),
      cfg.get<string>("path", "").trim(),
    );
    void sm.ready.then(() => syncAfterReady());
  };

  // Open session panels (one editor tab per session) — created on demand,
  // revived by per-viewType serializers after a reload.
  // Status-prefix icons (animated APNGs: spinner / ask / turn-ended
  // marks) generated into the extension install dir: tab icons load only
  // from there (or the workspace), never globalStorage. The dir name is
  // versioned because the install dir is stable within one package
  // version — bump the suffix on art changes; each update installs into
  // a fresh versioned dir, so stale icons self-invalidate.
  const icons = new TabIconSet(
    vscode.Uri.joinPath(context.extensionUri, "tabicons-v5"),
  );
  // Dead caches: the globalStorage-era frame dirs (their URIs never
  // rendered) and older versioned dirs inside the install dir, which
  // same-version reinstalls share — they would otherwise linger beside
  // the current one. Best-effort removal.
  for (const dead of ["tabicons", "tabicons-v2"]) {
    try {
      fs.rmSync(vscode.Uri.joinPath(context.globalStorageUri, dead).fsPath, {
        recursive: true,
        force: true,
      });
    } catch {
      // Locked-down storage: the leftover dirs are inert.
    }
  }
  for (const dead of ["tabicons-v3", "tabicons-v4"]) {
    try {
      fs.rmSync(vscode.Uri.joinPath(context.extensionUri, dead).fsPath, {
        recursive: true,
        force: true,
      });
    } catch {
      // Read-only install dir: the leftover dir is inert.
    }
  }
  const panels = new SessionPanels({
    hub,
    extensionUri: context.extensionUri,
    routeStore,
    tabsStore,
    projectStore,
    openProject,
    hiddenModels,
    hiddenProviders,
    icons,
    ensureServer: () => void ensureServer(),
    // opencode.panelOpen is a compatibility surface (nothing here reads it
    // anymore); keep it truthful for external consumers.
    onPanelsChanged: (ids) =>
      void context.workspaceState.update("opencode.panelOpen", ids.length > 0),
  });
  context.subscriptions.push(panels);

  // Reveal or create one session's panel, titled from the server once it
  // can name it (the tab starts as the raw id). This is also the host side
  // of the webview's "open-session" message (Stage B's navigator).
  const openSession = (id: string) => {
    const sm = ensureServer() ?? serverManager;
    const panel = panels.open(id);
    if (sm)
      void sm.ready.then(async () => {
        if (serverManager !== sm) return;
        const title = await sm.sessionTitle(id);
        if (title) panels.setTitle(id, title);
      });
    return panel;
  };
  context.subscriptions.push(
    vscode.commands.registerCommand("opencodeGui.openSession", (id?: unknown) => {
      if (typeof id === "string") openSession(id);
    }),
  );

  // The old in-app tab menu (pre-editor-tabs) lives again on the native
  // editor tab: Copy Session ID / Fork / Rename / Delete, contributed to
  // editor/title/context and gated on a session tab being the active
  // editor (activeWebviewPanelId carries the panel's viewType). The
  // context arg names the right-clicked tab's group and index, but
  // groupId is VS Code's internal id — not a view column — so the column
  // match is a best effort, validated against our own panels; anything
  // that doesn't line up (and plain palette runs, which pass no arg)
  // falls back to the active session panel.
  const tabMenuTarget = (
    ctx: unknown,
  ): { id: string } | undefined => {
    const c = ctx as { groupId?: unknown; editorIndex?: unknown } | undefined;
    if (typeof c?.groupId === "number" && typeof c.editorIndex === "number") {
      const tab = vscode.window.tabGroups.all.find(
        (g) => g.viewColumn === c.groupId,
      )?.tabs[c.editorIndex];
      const id = tab ? sessionTabId(tab) : undefined;
      if (id !== undefined && panels.has(id)) return { id };
    }
    return panels.target();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("opencodeGui.copySessionId", (ctx?: unknown) => {
      const target = tabMenuTarget(ctx);
      if (target) void vscode.env.clipboard.writeText(target.id);
    }),
    vscode.commands.registerCommand("opencodeGui.forkSession", async (ctx?: unknown) => {
      const target = tabMenuTarget(ctx);
      if (!target) return;
      const sm = ensureServer() ?? serverManager;
      const fork = await sm?.forkSession(target.id);
      if (fork) openSession(fork);
      else
        void vscode.window.showErrorMessage(
          "Could not fork the session — an empty one has nothing to copy, or the server is not reachable. Try Open Code: Restart.",
        );
    }),
    vscode.commands.registerCommand("opencodeGui.renameSession", async (ctx?: unknown) => {
      const target = tabMenuTarget(ctx);
      if (!target) return;
      const sm = ensureServer() ?? serverManager;
      // Pre-fill with the server's truth: the tab title may still be the
      // raw id (the async label fetch never landed).
      const current = (await sm?.sessionTitle(target.id)) ?? target.id;
      const title = await vscode.window.showInputBox({
        prompt: "Rename session",
        value: current,
      });
      if (title === undefined || title.trim() === "") return;
      if (await sm?.renameSession(target.id, title)) panels.setTitle(target.id, title);
      else void vscode.window.showErrorMessage("The rename was rejected by the server.");
    }),
    vscode.commands.registerCommand("opencodeGui.deleteSession", async (ctx?: unknown) => {
      const target = tabMenuTarget(ctx);
      if (!target) return;
      const confirm = await vscode.window.showWarningMessage(
        "Delete this session? Its transcript is removed too.",
        { modal: true, detail: target.id },
        "Delete",
      );
      if (confirm !== "Delete") return;
      const sm = ensureServer() ?? serverManager;
      if (!(await sm?.deleteSession(target.id))) {
        void vscode.window.showErrorMessage("The delete was rejected by the server.");
        return;
      }
      // The webview stores reconcile over SSE (session.deleted); the tab
      // itself is ours to close.
      panels.get(target.id)?.dispose();
    }),
  );

  // Create a session through the server (the app's own new-session path)
  // and open its panel; undefined when the server could not.
  const createSessionPanel = async (): Promise<string | undefined> => {
    const sm = ensureServer() ?? serverManager;
    await sm?.ready;
    const id = await sm?.createSession();
    if (!id) {
      vscode.window.showErrorMessage(
        "Could not create a session — the opencode server is not reachable. Try Open Code: Restart.",
      );
      return undefined;
    }
    openSession(id);
    return id;
  };

  // Register the webview view provider; resolving the sidebar view is a
  // chat-use signal, so it starts the server too.
  const provider = new OpencodeViewProvider(
    hub,
    context.extensionUri,
    () => {
      ensureServer();
    },
    {
      routeStore,
      tabsStore,
      projectStore,
      openProject,
      hiddenModels,
      hiddenProviders,
    },
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("opencodeGui.chatView", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // Boot restore: never open panels eagerly — a restored tab is revived by
  // its per-session serializer when VS Code shows it (the layout tells
  // whether one is pending; eager opens next to restored tabs are the
  // duplicated-tab bug). One serializer per persisted id now, lazily more
  // when a panel with a new id opens.
  for (const id of tabsStore.get()) panels.ensureSerializer(id);

  // Pre-redesign chat tabs (the singleton "opencodeGui.chatPanel" viewType)
  // carry no session in their viewType, so nothing revives them and the
  // stray heal can't see them either. Swap one for the recorded last-active
  // session's own tab; with no usable route it just closes.
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer("opencodeGui.chatPanel", {
      deserializeWebviewPanel: (panel) => {
        panel.dispose();
        try {
          const r = JSON.parse(routeStore.get() ?? "") as {
            view?: string;
            id?: string;
          };
          if (r.view === "session" && r.id) openSession(r.id);
        } catch {
          // No usable route - the stale tab just closes.
        }
        return Promise.resolve();
      },
    }),
  );

  // Cross-window session deep-link: another window's "open-project" click
  // stashed this intent just before VS Code opened this folder. Consume it
  // once: open the session's own panel; a stale id bounces home in the app
  // on the store's first fetch.
  const pendingOpen = context.globalState.get<{
    worktree: string;
    session: string;
    ts: number;
  }>("opencode.pendingOpen");
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (
    pendingOpen &&
    workspaceFolder &&
    // The posted dir comes from opencode (realpath'd), the fsPath from VS
    // Code — normalize before comparing.
    normWorktree(pendingOpen.worktree) === normWorktree(workspaceFolder) &&
    Date.now() - pendingOpen.ts < 120_000
  ) {
    void context.globalState.update("opencode.pendingOpen", undefined);
    openSession(pendingOpen.session);
  }

  // A restored session tab that no panel claims is a corpse (its claiming
  // extension host died): a frozen page nothing will ever revive — close
  // it and rebuild the panel. A live panel claims itself within moments
  // of showing, so every check runs after a grace. The Tab API reports
  // webview inputs with VS Code's internal provider prefix
  // ("mainThreadWebview-…") for live and restored tabs alike, so the
  // claim check is the manager's map, never the viewType spelling.
  const activeStrays = () =>
    vscode.window.tabGroups.all.flatMap((g) => g.tabs).flatMap((tab) => {
      const id = sessionTabId(tab);
      return id !== undefined && tab.isActive && !panels.has(id)
        ? [{ tab, id }]
        : [];
    });
  let healTimer: NodeJS.Timeout | undefined;
  const healSoon = () => {
    if (healTimer) clearTimeout(healTimer);
    healTimer = setTimeout(() => {
      healTimer = undefined;
      for (const { tab, id } of activeStrays()) {
        void vscode.window.tabGroups.close(tab).then(
          () => openSession(id),
          (err) => log.error("heal: closing a stray session tab failed:", err),
        );
      }
    }, 2_000);
    healTimer.unref?.();
  };
  // A stray the user activates fires onDidChangeTabs; the tab active at
  // activation (a corpse left by an extension-host restart) never does,
  // so check once up front too — same grace either way.
  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(healSoon),
    { dispose: () => healTimer && clearTimeout(healTimer) },
  );
  healSoon();

  // Text into the last-active session's composer: with no panel open, one
  // is created for a fresh session — AppHost queues the insert until the
  // new page's listener exists, so the text never drops.
  const postToChat = async (ref: string) => {
    const panel = panels.target();
    if (panel) {
      panel.reveal();
      panel.chat.addToChat(ref);
      return;
    }
    const id = await createSessionPanel();
    if (id !== undefined) panels.get(id)?.chat.addToChat(ref);
  };

  // Register the addToChat command
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "opencodeGui.addToChat",
      (uri?: vscode.Uri) => {
        const fileUri = uri || vscode.window.activeTextEditor?.document.uri;
        if (fileUri) {
          const relativePath = vscode.workspace.asRelativePath(fileUri);
          void postToChat(relativePath);
        }
      },
    ),
  );

  // Register the addSelectionToChat command
  context.subscriptions.push(
    vscode.commands.registerCommand("opencodeGui.addSelectionToChat", () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const sel = editor.selection;
      const relativePath = vscode.workspace.asRelativePath(editor.document.uri);

      let ref: string;
      if (sel.isEmpty) {
        // Cursor only — just line number
        ref = `${relativePath}:${sel.start.line + 1}`;
      } else if (sel.start.line === sel.end.line) {
        // Single line selection — file:line:startCol-endCol
        ref = `${relativePath}:${sel.start.line + 1}:${sel.start.character + 1}-${sel.end.character + 1}`;
      } else {
        // Multi-line selection — file:startLine:startCol-endLine:endCol
        ref = `${relativePath}:${sel.start.line + 1}:${sel.start.character + 1}-${sel.end.line + 1}:${sel.end.character + 1}`;
      }

      postToChat(ref);
    }),
  );

  // Register the openChat command — reveal the last-active session panel;
  // with none open, a fresh session gets one (the bare "Open in Primary
  // Editor" must always yield a usable tab).
  context.subscriptions.push(
    vscode.commands.registerCommand("opencodeGui.openChat", () => {
      const panel = panels.target();
      if (panel) {
        panel.reveal();
        ensureServer();
        return;
      }
      void createSessionPanel();
    }),
  );

  // Register the toggleChat command — close the active session's tab when
  // one is the active editor, otherwise reveal the last-active session
  // panel, or start a new session (Claude Code Cmd+Esc semantics)
  context.subscriptions.push(
    vscode.commands.registerCommand("opencodeGui.toggleChat", () => {
      for (const panel of panels.all()) {
        if (panel.isActive) {
          panel.dispose();
          return;
        }
      }
      const panel = panels.target();
      if (panel) {
        panel.reveal();
        ensureServer();
        return;
      }
      void createSessionPanel();
    }),
  );

  // Register the newSession command — create the session on the server
  // and open its own panel (no live app needed).
  context.subscriptions.push(
    vscode.commands.registerCommand("opencodeGui.newSession", () => {
      void createSessionPanel();
    }),
  );

  // A workspace terminal running the opencode TUI (Claude Code's "Open in
  // Terminal"): reused across invocations — a second invocation reveals it
  // without typing into whatever the TUI is doing.
  context.subscriptions.push(
    vscode.commands.registerCommand("opencodeGui.openTerminal", () => {
      const name = "opencode";
      const existing = vscode.window.terminals.find(
        (t) => t.name === name && !t.exitStatus,
      );
      if (existing) {
        existing.show();
        return;
      }
      const cli =
        vscode.workspace
          .getConfiguration("opencodeGui")
          .get<string>("path", "")
          .trim() || "opencode";
      const terminal = vscode.window.createTerminal({
        name,
        cwd: vscode.workspace.workspaceFolders?.[0]?.uri,
      });
      terminal.show();
      // A spaced path word-splits unless quoted, on every shell; PowerShell
      // (the Windows default profile) additionally needs the call operator.
      terminal.sendText(
        /\s/.test(cli)
          ? process.platform === "win32"
            ? `& "${cli}"`
            : `"${cli}"`
          : cli,
      );
    }),
  );

  // The session commands act on: the target panel's, else the last route
  // a panel/app reported.
  const currentSession = (): string | undefined => {
    const panel = panels.target();
    if (panel) return panel.id;
    try {
      const r = JSON.parse(routeStore.get() ?? "") as {
        view?: string;
        id?: string;
      };
      return r.view === "session" && r.id ? r.id : undefined;
    } catch {
      return undefined;
    }
  };

  // Read-only virtual documents holding a session's per-file unified
  // patches. GET /session/{id}/diff returns patch text (no before/after
  // content), so this is the minimal native surface: the patch, syntax
  // highlighted, one editor per picked file.
  const patchContents = new Map<string, string>();
  const patchChanged = new vscode.EventEmitter<vscode.Uri>();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider("opencode-diff", {
      onDidChange: patchChanged.event,
      provideTextDocumentContent: (uri: vscode.Uri) =>
        patchContents.get(uri.toString()) ?? "",
    }),
    patchChanged,
  );

  // Open the current session's changes as native diff editors: quick-pick
  // a file when there are several, then show its patch read-only.
  context.subscriptions.push(
    vscode.commands.registerCommand("opencodeGui.openDiff", async () => {
      const id = currentSession();
      if (!id) {
        vscode.window.showInformationMessage(
          "Open a session first to see its changes.",
        );
        return;
      }
      ensureServer();
      const diffs = await serverManager?.sessionDiff(id);
      if (!diffs) {
        vscode.window.showErrorMessage(
          "Could not load the session's file changes — the opencode server is not reachable. Try Open Code: Restart.",
        );
        return;
      }
      if (diffs.length === 0) {
        vscode.window.showInformationMessage(
          "No file changes in this session.",
        );
        return;
      }
      let file = diffs[0];
      if (diffs.length > 1) {
        const pick = await vscode.window.showQuickPick(
          diffs.map((d) => ({
            label: d.file ?? "(unknown file)",
            description: `+${d.additions} −${d.deletions}`,
            diff: d,
          })),
          { placeHolder: "Session changes — pick a file" },
        );
        if (!pick) return;
        file = pick.diff;
      }
      const uri = vscode.Uri.from({
        scheme: "opencode-diff",
        path: `/${id}/${(file.file ?? "changes").replace(/^[/\\]+/, "")}`,
      });
      // One command run owns the cache: older entries would never re-render
      // (their tabs keep the old paint) and grow without bound.
      patchContents.clear();
      patchContents.set(uri.toString(), file.patch ?? "");
      patchChanged.fire(uri);
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.languages.setTextDocumentLanguage(doc, "diff");
        await vscode.window.showTextDocument(doc, { preview: true });
      } catch (err) {
        vscode.window.showErrorMessage(
          `Could not open the diff: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }),
  );

  // Focus the session panel and toggle the context ring's expanded
  // breakdown.
  context.subscriptions.push(
    vscode.commands.registerCommand("opencodeGui.openContextSummary", () => {
      const panel = panels.target();
      if (!panel) {
        vscode.window.showInformationMessage(
          "Open a session first to see its context.",
        );
        return;
      }
      panel.reveal();
      panel.chat.toggleContext();
    }),
  );

  // Register the showHistory command — pick a past session, newest
  // first, and open it in its own panel
  context.subscriptions.push(
    vscode.commands.registerCommand("opencodeGui.showHistory", async () => {
      ensureServer();
      const sessions = await serverManager?.listSessions();
      if (!sessions) {
        vscode.window.showErrorMessage(
          "Could not load sessions — the opencode server is not reachable. Try Open Code: Restart.",
        );
        return;
      }
      if (sessions.length === 0) {
        vscode.window.showInformationMessage("No past sessions yet.");
        return;
      }
      const items = sessions
        .sort((a, b) => b.time.updated - a.time.updated)
        .map((s) => ({
          label: s.title || s.id,
          description: new Date(s.time.updated).toLocaleString(),
          id: s.id,
        }));
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: "Select a session to open",
      });
      if (pick) {
        openSession(pick.id);
      }
    }),
  );

  // Restore cached sidebar type from global state
  const cachedSidebarType = context.globalState.get<"primary" | "auxiliary">(
    "opencode.sidebarType",
  );
  if (cachedSidebarType) {
    provider.sidebarType = cachedSidebarType;
  }

  // Reveal the sidebar chat view in whichever sidebar it lives, remembering
  // the side that worked. Resolves with the view visible.
  const revealSidePanel = async () => {
    // Use cached sidebar type, default to auxiliary (secondary sidebar)
    const tryFirst = provider.sidebarType ?? "auxiliary";
    await vscode.commands.executeCommand(SIDEBAR_CMDS[tryFirst]);

    if (provider.isViewVisible) {
      provider.sidebarType = tryFirst;
      void context.globalState.update("opencode.sidebarType", tryFirst);
      return;
    }

    // Wrong sidebar — undo and try the other
    await vscode.commands.executeCommand(SIDEBAR_CMDS[tryFirst]);
    const other = tryFirst === "auxiliary" ? "primary" : "auxiliary";
    await vscode.commands.executeCommand(SIDEBAR_CMDS[other]);
    provider.sidebarType = other;
    void context.globalState.update("opencode.sidebarType", other);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("opencodeGui.toggleChatView", async () => {
      if (!provider.isViewVisible) {
        await revealSidePanel();
        return;
      }
      await vscode.commands.executeCommand(
        SIDEBAR_CMDS[provider.sidebarType ?? "auxiliary"],
      );
    }),
  );

  // Register the restart command to kill the server and start fresh
  context.subscriptions.push(
    vscode.commands.registerCommand("opencodeGui.restart", async () => {
      const old = serverManager;
      serverManager = undefined;
      hub.setLoading();
      // Wait for the ports to actually free before spawning the replacement.
      await old?.dispose();
      // ensureServer re-reads the config and stored port per spawn and
      // wires the replacement (unexpected-exit respawn, model-agent sync);
      // it returns before the boot finishes, like every other spawn site.
      const sm = ensureServer();
      // Restart doubles as dead-webview recovery: a session tab whose
      // renderer process died shows VS Code's grey placeholder forever,
      // and only a fresh webview brings it back — rebuild every VISIBLE
      // panel whose heartbeat (AppHost.isUnresponsive) has stopped. Live
      // tabs are left alone; the sidebar re-renders from hub state
      // changes.
      void sm?.ready.then(() => {
        for (const panel of panels.all()) {
          if (panel.isVisible && panel.chat.isUnresponsive)
            panels.recreate(panel.id);
        }
      });
    }),
  );

  // Dead-tab watchdog: a page can die (renderer crash, boot that never
  // finished) while the server stays healthy, and then nothing else ever
  // rebuilds the tab — the grey placeholder sits until a manual Restart.
  // Poll the heartbeat and recreate the panel when it reads dead — but
  // only a VISIBLE one: VS Code suspends hidden webviews entirely
  // (retained context included), so a hidden tab's silent heartbeat is
  // suspension, not death. Destroying it mid-turn would drop live state
  // for nothing; a renderer that dies hidden is caught on its next show.
  // A genuinely unloadable app (broken install) keeps recycling the tab,
  // which is the same retry VS Code itself does for crashed webviews.
  const watchdog = setInterval(() => {
    for (const panel of panels.all()) {
      if (panel.isVisible && panel.chat.isUnresponsive) {
        log.info(
          `watchdog: visible session tab ${panel.id} unresponsive, recreating panel`,
        );
        panels.recreate(panel.id);
      }
    }
  }, 5_000);
  context.subscriptions.push({ dispose: () => clearInterval(watchdog) });

  // Manage Models: which connected-provider models the composer's picker
  // lists (checked = listed). The webview picker's footer row lands here
  // via the "manage-models" message; a providerID argument (the provider
  // menu's context) scopes the list to that provider's models.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "opencodeGui.manageModels",
      async (providerID?: string) => {
        ensureServer();
        const sm = serverManager;
        await sm?.ready;
        const catalog = await sm?.providerCatalog();
        if (!catalog) {
          vscode.window.showErrorMessage(
            "Could not load models — the opencode server is not reachable. Try Open Code: Restart.",
          );
          return;
        }
        const hidden = new Set(hiddenModels.get());
        const items: (vscode.QuickPickItem & { ref?: string })[] = [];
        for (const p of (catalog.all ?? [])
          .filter((x) => catalog.connected.includes(x.id))
          .filter((x) => !providerID || x.id === providerID)) {
          items.push({
            label: p.name ?? p.id,
            kind: vscode.QuickPickItemKind.Separator,
          });
          for (const [mid, m] of Object.entries(p.models ?? {})) {
            const ref = `${p.id}/${mid}`;
            items.push({
              label: m.name ?? mid,
              description: ref,
              picked: !hidden.has(ref),
              ref,
            });
          }
        }
        const rows = items.filter((i) => i.ref);
        if (rows.length === 0) {
          vscode.window.showInformationMessage(
            "No providers are connected yet — run `opencode auth login` in a terminal to connect one.",
          );
          return;
        }
        const picked = await vscode.window.showQuickPick(items, {
          title: "Open Code: Manage Models",
          placeHolder: "Checked models appear in the model picker",
          canPickMany: true,
        });
        if (!picked) return;
        const visible = new Set(picked.flatMap((i) => (i.ref ? [i.ref] : [])));
        setHiddenModels(
          rows.flatMap((i) => (i.ref && !visible.has(i.ref) ? [i.ref] : [])),
        );
      },
    ),
  );

  // Manage Providers: which connected providers the pickers list (checked
  // = listed), plus a per-row plug button that disables/re-enables a
  // provider on the SERVER (config denylist — its models stop being
  // usable). The provider menu's footer lands here via the
  // "manage-providers" message.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "opencodeGui.manageProviders",
      async () => {
        ensureServer();
        const sm = serverManager;
        await sm?.ready;
        const catalog = await sm?.providerCatalog();
        if (!catalog || !sm) {
          vscode.window.showErrorMessage(
            "Could not load providers — the opencode server is not reachable. Try Open Code: Restart.",
          );
          return;
        }
        const connected = catalog.connected;
        const disabled = new Set(await sm.disabledProviders());
        // v2's allowlist (enabled_providers in the config): null = off.
        // While on, only listed providers may run anywhere — sub-agent
        // sessions and explicit model overrides included.
        let allow: string[] | null = await sm.enabledProviders();
        if (connected.length === 0 && disabled.size === 0) {
          vscode.window.showInformationMessage(
            "No providers are connected yet — run `opencode auth login` in a terminal to connect one.",
          );
          return;
        }
        const names = new Map(
          (catalog.all ?? []).map((p) => [p.id, p.name ?? p.id]),
        );
        type Row = vscode.QuickPickItem & { pid: string };
        // Under the allowlist a blocked provider drops out of `connected`
        // server-side; the hidden list keeps it addressable here so it can
        // be re-allowed without lifting the restriction first.
        const universe = [
          ...new Set([...connected, ...disabled, ...hiddenProviders.get()]),
        ];
        const hidden = new Set(hiddenProviders.get());
        const allowed = (pid: string) =>
          allow !== null && allow.includes(pid);
        const row = (pid: string): Row => ({
          pid,
          label: names.get(pid) ?? pid,
          description: pid,
          ...(disabled.has(pid)
            ? { detail: "$(circle-slash) Disabled on the server" }
            : {}),
          ...(allow !== null && !allowed(pid)
            ? { detail: "$(circle-slash) Blocked by the restriction" }
            : {}),
          picked:
            allow !== null
              ? allowed(pid)
              : !disabled.has(pid) && !hidden.has(pid),
          buttons: [
            {
              iconPath: new vscode.ThemeIcon("plug"),
              tooltip: allow !== null
                ? allowed(pid)
                  ? "Block on the server"
                  : "Allow on the server"
                : disabled.has(pid)
                  ? "Enable on the server"
                  : "Disable on the server",
            },
          ],
        });
        // The empty pid marks the mode row, ignored wherever providers are
        // processed.
        const modeRow = (): Row => ({
          pid: "",
          label: "$(shield) Only checked providers can run",
          description:
            allow === null
              ? "off — turn on to enforce the checked set on the server"
              : "on — enforced on the server, sub-agent sessions included",
          buttons: [
            {
              iconPath: new vscode.ThemeIcon(allow === null ? "lock" : "unlock"),
              tooltip:
                allow === null
                  ? "Restrict running to the checked providers"
                  : "Lift the restriction",
            },
          ],
        });
        const qp = vscode.window.createQuickPick<Row>();
        qp.title = "Open Code: Manage Providers";
        qp.canSelectMany = true;
        qp.placeholder =
          "Checked providers appear in the pickers — the plug toggles one on the server; the shield enforces the checked set";
        // v1 has no enabled_providers key — the shield row would only ever
        // error, so it stays hidden there.
        qp.items = [
          ...(sm.dialect === "v2" ? [modeRow()] : []),
          ...universe.map(row),
        ];
        qp.onDidTriggerItemButton((e) => {
          const pid = (e.item as Row).pid;
          void (async () => {
            // The shield row flips allowlist mode. Enabling takes the
            // currently checked providers as the list; an empty list
            // would deny everything, so it needs at least one.
            if (!pid) {
              if (allow !== null) {
                if (!(await sm.setEnabledProviders(null))) {
                  vscode.window.showErrorMessage(
                    "Could not lift the restriction — the opencode config file is not writable.",
                  );
                  return;
                }
                allow = null;
              } else {
                const next = universe.filter(
                  (p) => !disabled.has(p) && !hidden.has(p),
                );
                if (next.length === 0) {
                  vscode.window.showWarningMessage(
                    "Check at least one provider before restricting.",
                  );
                  return;
                }
                if (!(await sm.setEnabledProviders(next))) {
                  vscode.window.showErrorMessage(
                    "Could not write the restriction — the opencode config file is not writable.",
                  );
                  return;
                }
                allow = next;
              }
              qp.items = [modeRow(), ...universe.map(row)];
              // The webview won't hear about it otherwise on v1 (v2's
              // config.updated SSE maps to a base refresh server-side).
              hub.noteVisible();
              return;
            }
            // Under the allowlist the plug edits the allowlist —
            // disabled_providers wins over enabled_providers server-side,
            // so a denylist write here would block everything.
            if (allow !== null) {
              const next = new Set(allow);
              if (next.has(pid)) next.delete(pid);
              else next.add(pid);
              if (next.size === 0) {
                vscode.window.showWarningMessage(
                  "At least one provider must stay runnable.",
                );
                return;
              }
              if (!(await sm.setEnabledProviders([...next]))) {
                vscode.window.showErrorMessage(
                  `Could not ${next.has(pid) ? "block" : "allow"} ${pid} — the opencode config file is not writable.`,
                );
                return;
              }
              allow = [...next];
              // Keep the picker's visible set in step: blocked ⇒ hidden.
              if (next.has(pid)) hidden.delete(pid);
              else hidden.add(pid);
              setHiddenProviders([...hidden]);
              qp.items = qp.items.map((i) =>
                !i.pid ? modeRow() : i.pid === pid ? row(pid) : i,
              );
              hub.noteVisible();
              return;
            }
            const next = new Set(await sm.disabledProviders());
            if (next.has(pid)) next.delete(pid);
            else next.add(pid);
            if (!(await sm.setDisabledProviders([...next]))) {
              vscode.window.showErrorMessage(
                `Could not ${next.has(pid) ? "disable" : "enable"} ${pid} — the opencode config file is not writable.`,
              );
              return;
            }
            disabled.clear();
            for (const p of next) disabled.add(p);
            qp.items = qp.items.map((i) => (i.pid === pid ? row(pid) : i));
            // The webview won't hear about it otherwise on v1 (v2's
            // config.updated SSE maps to a base refresh server-side).
            hub.noteVisible();
          })();
        });
        const chosen = await new Promise<readonly Row[] | undefined>(
          (resolve) => {
            qp.onDidAccept(() => resolve(qp.selectedItems));
            qp.onDidHide(() => resolve(undefined));
            qp.show();
          },
        );
        qp.dispose();
        if (!chosen) return;
        const visible = new Set(
          chosen.filter((i) => i.pid).map((i) => i.pid),
        );
        // Under the allowlist the checked set IS the server-side rule —
        // accept rewrites it (never to empty: that denies everything).
        if (allow !== null) {
          if (visible.size === 0) {
            vscode.window.showWarningMessage(
              "Leave at least one provider checked — nothing was changed.",
            );
            return;
          }
          if (!(await sm.setEnabledProviders([...visible]))) {
            vscode.window.showErrorMessage(
              "Could not write the restriction — the opencode config file is not writable.",
            );
            return;
          }
          setHiddenProviders(universe.filter((pid) => !visible.has(pid)));
          return;
        }
        setHiddenProviders(
          universe.flatMap((pid) =>
            visible.has(pid) || disabled.has(pid) ? [] : [pid],
          ),
        );
      },
    ),
  );

  // Theme change: re-bake the editor token colors the code blocks use.
  context.subscriptions.push(
    vscode.window.onDidChangeActiveColorTheme(() => {
      invalidateThemeTokens();
      hub.rerender();
    }),
  );

  // Same for the glow toggle — it changes the baked token variables and the
  // tokenizer's inline shadows.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("opencodeGui.codeGlow")) {
        invalidateThemeTokens();
        hub.rerender();
      }
      // The copy modifier: hot-pushable, no re-render needed.
      if (e.affectsConfiguration("opencodeGui.codeCopyModifier")) {
        hub.setCopyModifier(copyModifierSetting());
      }
      // Same for the ready sound.
      if (e.affectsConfiguration("opencodeGui.readySound")) {
        hub.setReadySound(readySoundSetting());
      }
      // And the permission sound.
      if (e.affectsConfiguration("opencodeGui.permissionSound")) {
        hub.setPermissionSound(permissionSoundSetting());
      }
      // And the question sound.
      if (e.affectsConfiguration("opencodeGui.questionSound")) {
        hub.setQuestionSound(questionSoundSetting());
      }
    }),
  );

  // Prompt the user to restart when relevant settings change
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("opencodeGui.port") ||
        e.affectsConfiguration("opencodeGui.exposeToNetwork") ||
        e.affectsConfiguration("opencodeGui.path")
      ) {
        void vscode.window
          .showInformationMessage(
            "opencode GUI settings changed. Restart to apply?",
            "Restart",
          )
          .then((choice) => {
            if (choice === "Restart") {
              void vscode.commands.executeCommand("opencodeGui.restart");
            }
          });
      }
    }),
  );

  // serverPort is a test surface (the harness's orphan check needs the
  // opencode port, not the proxied URL's). authHeaders serves the same
  // purpose: tests driving the real server's API must share the host's
  // auth module instance (the shipped bundle inlines its own copy).
  return {
    hub,
    provider,
    panels,
    get serverPort() { return serverManager?.serverPort; },
    ensureServer,
    authHeaders: serverAuthHeaders,
  };
}

export function deactivate() {
  const sm = serverManager;
  serverManager = undefined;
  // VS Code awaits deactivate(); waiting for the kill prevents orphaned
  // opencode processes after the extension host exits.
  return sm?.dispose();
}
