import * as vscode from "vscode";
import { OpencodeViewProvider } from "./webview/OpencodeViewProvider";
import { ChatHub } from "./webview/ChatHub";
import { ChatPanel, CHAT_VIEWTYPE } from "./webview/ChatPanel";
import { PeerRegistry } from "./webview/Peers";
import type {
  AppHost,
  HiddenModels,
  OpenProjectHandler,
  ProjectStore,
} from "./webview/AppHost";
import { ServerManager, normWorktree, randomPort } from "./server/ServerManager";
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
  // Shared chat state, fanned out to the sidebar and the editor tab
  const hub = new ChatHub();

  // opencode-plugin-peers registry: names inbound peer-card senders.
  // A 10 s poll rides the plugin's own heartbeat cadence, so peer and
  // session renames reach open cards without a watcher.
  const peerRegistry = new PeerRegistry((peers) => hub.setPeers(peers));
  peerRegistry.start();
  context.subscriptions.push(peerRegistry);

  // Last app route (per-folder workspaceState, so no cross-folder checks).
  // Baked into the page for boot restore.
  const routeStore = {
    get: () => context.workspaceState.get<string>("opencode.route"),
    set: (value: string) => void context.workspaceState.update("opencode.route", value),
  };

  // Open session tabs, in bar order (beside the route, same
  // workspaceState): a restart restores the whole set, not just the
  // visible session.
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
  // webviews (provider and ChatPanel.instance both exist by then — the only
  // caller is the command below).
  const hiddenModels: HiddenModels = {
    get: () =>
      (context.globalState.get<string[]>("opencode.hiddenModels") ?? []).filter(
        (r) => typeof r === "string",
      ),
  };
  const setHiddenModels = (refs: string[]) => {
    void context.globalState.update("opencode.hiddenModels", refs);
    ChatPanel.instance?.chat.setHiddenModels(refs);
    provider.chat.setHiddenModels(refs);
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
      // Agent files were written/removed — restart so the server picks
      // them up. The next start finds the files up-to-date: no loop.
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
      hub.setLoading();
      ensureServer();
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

  // Open/reveal the singleton chat tab and make sure the server is up.
  // Persist whether the tab was open so onStartupFinished can reopen it
  // after a restart — the panel serializer doesn't always fire (collapsed
  // editor groups, long-uptime state corruption).
  const onPanelDispose = () => {
    void context.workspaceState.update("opencode.panelOpen", false);
  };
  const showPanel = (): ChatPanel => {
    ensureServer();
    void context.workspaceState.update("opencode.panelOpen", true);
    return ChatPanel.show(
      hub,
      context.extensionUri,
      onPanelDispose,
      routeStore,
      tabsStore,
      projectStore,
      openProject,
      hiddenModels,
    );
  };

  // Register the webview panel provider; resolving the sidebar view is a
  // chat-use signal, so it starts the server too.
  const provider = new OpencodeViewProvider(
    hub,
    context.extensionUri,
    ensureServer,
    routeStore,
    tabsStore,
    projectStore,
    openProject,
    hiddenModels,
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("opencodeGui.chatView", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // Bring back the editor tab after a window reload/restart, like any
  // other editor tab. A restored tab means the user had chat open.
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(CHAT_VIEWTYPE, {
      deserializeWebviewPanel: (panel) => {
        ensureServer();
        void context.workspaceState.update("opencode.panelOpen", true);
        ChatPanel.restore(
          hub,
          context.extensionUri,
          panel,
          onPanelDispose,
          routeStore,
          tabsStore,
          projectStore,
          openProject,
          hiddenModels,
        );
        return Promise.resolve();
      },
    }),
  );

  // Cross-window session deep-link: another window's "open-project" click
  // stashed this intent just before VS Code opened this folder. Consume it
  // once: the session route is written to the route store before the chat
  // panel is created, so the first page bake carries it and the app boots
  // straight into the session; a stale id bounces home on the store's
  // first fetch.
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
    routeStore.set(JSON.stringify({ view: "session", id: pendingOpen.session }));
    showPanel();
  }

  // A restored chat tab sits in the editor layout before its webview is
  // deserialized — the serializer fires only when the tab is shown, which
  // can be long after activate(). The layout, not a timer, tells whether
  // one is pending. A pending tab reports VS Code's internal provider
  // prefix ("mainThreadWebview-…") on its viewType and an unrevived input
  // class, so match the property in both forms — instanceof is false for
  // it, and an exact match made the eager open run and twin the tab.
  const isChatTab = (tab: vscode.Tab): boolean => {
    const viewType = (tab.input as { viewType?: string } | undefined)
      ?.viewType;
    return (
      viewType === CHAT_VIEWTYPE ||
      viewType === `mainThreadWebview-${CHAT_VIEWTYPE}`
    );
  };

  // Reopen the chat tab if it was open before restart but left no tab to
  // restore (state loss). When a tab was restored, the serializer claims
  // it; creating ours alongside it is the duplicate-tab bug.
  if (
    context.workspaceState.get<boolean>("opencode.panelOpen") &&
    !vscode.window.tabGroups.all.some((g) => g.tabs.some(isChatTab))
  ) {
    showPanel();
  }

  // A chat tab can also close without ever being shown (closed from the
  // background after a relaunch): no panel exists to report the close, so
  // keep opencode.panelOpen truthful here.
  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs((e) => {
      if (!ChatPanel.instance && e.closed.some(isChatTab)) {
        void context.workspaceState.update("opencode.panelOpen", false);
      }
    }),
  );

  // The chat to talk to: visible editor tab first, then the visible sidebar;
  // open the editor tab if neither is visible.
  const targetChat = (): AppHost => {
    const panel = ChatPanel.instance;
    if (panel?.isVisible) return panel.chat;
    if (provider.isViewVisible) return provider.chat;
    return showPanel().chat;
  };
  const postToChat = (ref: string) => targetChat().addToChat(ref);

  // Register the addToChat command
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "opencodeGui.addToChat",
      (uri?: vscode.Uri) => {
        const fileUri = uri || vscode.window.activeTextEditor?.document.uri;
        if (fileUri) {
          const relativePath = vscode.workspace.asRelativePath(fileUri);
          postToChat(relativePath);
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

  // Register the openChat command — reveal the singleton editor tab
  context.subscriptions.push(
    vscode.commands.registerCommand("opencodeGui.openChat", () => {
      showPanel();
    }),
  );

  // Register the toggleChat command — close the chat tab when it is
  // the active tab, otherwise open/reveal it (Claude Code Cmd+Esc semantics)
  context.subscriptions.push(
    vscode.commands.registerCommand("opencodeGui.toggleChat", () => {
      const panel = ChatPanel.instance;
      if (panel?.isActive) {
        panel.dispose();
      } else {
        showPanel();
      }
    }),
  );

  // Register the newSession command — a fresh session, the way the app's
  // own tab-bar + button does (the webview makes it inside the app)
  context.subscriptions.push(
    vscode.commands.registerCommand("opencodeGui.newSession", () => {
      targetChat().newSession();
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

  // The session the visible chat is on (last route it reported).
  const currentSession = (): string | undefined => {
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

  // Focus the chat and toggle the context ring's expanded breakdown.
  context.subscriptions.push(
    vscode.commands.registerCommand("opencodeGui.openContextSummary", () => {
      targetChat().toggleContext();
    }),
  );

  // Register the showHistory command — pick a past session, newest
  // first, and navigate the visible chat to it
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
        targetChat().navigate(`/session/${pick.id}`);
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
      // Restart doubles as dead-webview recovery: a chat tab whose
      // renderer process died shows VS Code's grey placeholder forever,
      // and only a fresh webview brings it back — rebuild when the tab's
      // heartbeat (AppHost.isUnresponsive) has stopped. A live tab is
      // left alone; the sidebar re-renders from hub state changes.
      void sm?.ready.then(() => {
        const panel = ChatPanel.instance;
        if (panel?.chat.isUnresponsive) {
          ChatPanel.recreate(
            hub,
            context.extensionUri,
            onPanelDispose,
            routeStore,
            tabsStore,
            projectStore,
            openProject,
            hiddenModels,
          );
        }
      });
    }),
  );

  // Manage Models: which connected-provider models the composer's picker
  // lists (checked = listed). The webview picker's footer row lands here
  // via the "manage-models" message.
  context.subscriptions.push(
    vscode.commands.registerCommand("opencodeGui.manageModels", async () => {
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
      for (const p of (catalog.all ?? []).filter((x) =>
        catalog.connected.includes(x.id),
      )) {
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
    }),
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
  // opencode port, not the proxied URL's).
  return {
    hub,
    provider,
    get serverPort() { return serverManager?.serverPort; },
    ensureServer,
  };
}

export function deactivate() {
  const sm = serverManager;
  serverManager = undefined;
  // VS Code awaits deactivate(); waiting for the kill prevents orphaned
  // opencode processes after the extension host exits.
  return sm?.dispose();
}
