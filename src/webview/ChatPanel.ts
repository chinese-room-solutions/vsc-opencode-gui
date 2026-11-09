import * as vscode from "vscode";
import {
  AppHost,
  type HiddenModels,
  type HiddenProviders,
  type OpenProjectHandler,
  type ProjectStore,
  type RouteStore,
  type TabsStore,
} from "./AppHost";
import { ChatHub } from "./ChatHub";
import { TabIconSet, TabSignal } from "./TabSignal";
import { log } from "../log";

// One editor tab per session (the Claude Code model). The viewType embeds
// the session id: WebviewPanelSerializer's state argument is always
// undefined for panels, so the id must live in the viewType — VS Code
// remembers each tab's viewType across reloads and calls the matching
// serializer on revival.
export const SESSION_VIEWTYPE_PREFIX = "opencodeGui.session.";

export function sessionViewType(id: string): string {
  return `${SESSION_VIEWTYPE_PREFIX}${id}`;
}

// The session id behind an open editor tab, in either form: a live panel
// reports the plain viewType, a restored-but-not-yet-deserialized one VS
// Code's internal provider prefix ("mainThreadWebview-…").
export function sessionTabId(tab: vscode.Tab): string | undefined {
  const viewType = (tab.input as { viewType?: string } | undefined)?.viewType;
  if (typeof viewType !== "string") return undefined;
  for (const prefix of [
    SESSION_VIEWTYPE_PREFIX,
    `mainThreadWebview-${SESSION_VIEWTYPE_PREFIX}`,
  ]) {
    if (viewType.startsWith(prefix)) return viewType.slice(prefix.length);
  }
  return undefined;
}

// A session tab's label from the server's raw title — the app-side
// sessionTitle (src/webview/app/store.ts) mirrored for the host's own
// at-open fetch: an untitled session is "New session" (never its id),
// v1's "New session - <ISO>" collapses, sub-agent bookkeeping drops.
export function sessionTabTitle(raw: string | undefined): string {
  const t =
    raw?.replace(/\s+\(@\S+ subagent\)$/, "").trim() || "New session";
  return /^(?:New|Child) session - /.test(t) ? t.replace(/ - .*/, "") : t;
}

// Where one session's editor tab currently sits (a session has one).
export interface TabSpot {
  column: vscode.ViewColumn;
  index: number;
}

export function tabSpot(id: string): TabSpot | undefined {
  for (const g of vscode.window.tabGroups.all) {
    const index = g.tabs.findIndex((t) => sessionTabId(t) === id);
    if (index !== -1) return { column: g.viewColumn, index };
  }
  return undefined;
}

// Swapping a tab (revive, dead-webview rebuild) closes it and opens a
// fresh one, which VS Code appends to the strip's end — every swap would
// shuffle the user's tab order. The stable Tabs API cannot move a tab, so
// drive the workbench's own move command ("Move Editor Left/Right" wrap
// it): it moves the ACTIVE group's active editor to an exact 1-based
// index. The swap just showed the fresh tab, so it is that editor; if the
// user has already switched away, the tab stays where VS Code put it.
export function restoreTabSpot(id: string, spot: TabSpot | undefined): void {
  if (!spot) return;
  void (async () => {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const group = vscode.window.tabGroups.all.find((g) =>
        g.tabs.some((t) => sessionTabId(t) === id),
      );
      const tab = group?.tabs.find((t) => sessionTabId(t) === id);
      if (
        group &&
        tab &&
        tab.isActive &&
        vscode.window.tabGroups.activeTabGroup.viewColumn === group.viewColumn
      ) {
        if (
          group.viewColumn === spot.column &&
          group.tabs.indexOf(tab) !== spot.index
        ) {
          await vscode.commands.executeCommand("moveActiveEditor", {
            to: "position",
            by: "tab",
            value: spot.index + 1,
          });
        }
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  })().catch((err: unknown) =>
    log.error("restoring a session tab's position failed:", err),
  );
}

export interface SessionPanelsDeps {
  hub: ChatHub;
  extensionUri: vscode.Uri;
  routeStore: RouteStore;
  tabsStore: TabsStore;
  projectStore: ProjectStore;
  openProject: OpenProjectHandler;
  hiddenModels: HiddenModels;
  hiddenProviders: HiddenProviders;
  // Generated tab icons (the status prefix's animated spinner/marks).
  icons: TabIconSet;
  // Fires the server up (revival and panel opens need it eventually).
  ensureServer: () => void;
  // True when the session is blank (created, no messages) — a restored
  // tab for one is dropped instead of revived (the navigator's blank
  // rule, mirrored host-side; fail-open reads false).
  isBlankSession: (id: string) => Promise<boolean>;
  // Notified with the open panel ids on every open/close, so main.ts can
  // keep external state (opencode.panelOpen) truthful.
  onPanelsChanged?: (ids: string[]) => void;
}
export interface OpenPanelOptions {
  column?: vscode.ViewColumn;
  title?: string;
  // False opens the tab in the background (heal paths); default reveals.
  show?: boolean;
}

// One session's editor tab: a WebviewPanel plus its AppHost, bound to the
// session id. All rendering/message logic lives in AppHost.
class SessionPanel implements vscode.Disposable {
  private readonly _panel: vscode.WebviewPanel;
  private readonly _chat: AppHost;
  private readonly _stateSub: vscode.Disposable;
  private readonly _signal: TabSignal<vscode.Uri | { light: vscode.Uri; dark: vscode.Uri }>;
  private readonly _onClose: () => void;
  // Set when teardown starts from dispose(); the panel's onDidDispose only
  // reports a user close (and runs _onClose) when it fires on its own.
  private _disposed = false;

  constructor(
    private readonly _deps: SessionPanelsDeps,
    private readonly _sessionId: string,
    title: string,
    onClose: () => void,
    onActive: (id: string) => void,
    opts: OpenPanelOptions = {},
  ) {
    this._onClose = onClose;
    const deps = this._deps;
    this._chat = new AppHost({
      extensionUri: deps.extensionUri,
      kind: "session",
      sessionId: _sessionId,
      routeStore: deps.routeStore,
      tabsStore: deps.tabsStore,
      projectStore: deps.projectStore,
      openProject: deps.openProject,
      hiddenModels: deps.hiddenModels,
      hiddenProviders: deps.hiddenProviders,
      claimBell: (kind) => deps.hub.claimBell(kind),
      onTabSignal: (facts) => this._signal?.apply(facts, this._panel.active),
    });
    this._panel = vscode.window.createWebviewPanel(
      sessionViewType(_sessionId),
      title,
      opts.show === false
        ? { viewColumn: opts.column ?? vscode.ViewColumn.Active, preserveFocus: true }
        : opts.column ?? vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, enableFindWidget: true },
    );
    // Tab icon: the idle base is the extension mark; the status prefix
    // (spinner / yellow ask / green turn-ended) swaps in a
    // self-animating APNG per state — the old in-app tab prefix,
    // host-driven.
    const idleIcon = vscode.Uri.joinPath(deps.extensionUri, "icon.png");
    this._panel.iconPath = idleIcon;
    this._signal = new TabSignal(
      {
        frame: (state) => {
          if (state !== "busy")
            return deps.icons.mark(
              state === "attention" ? "attention" : "ready",
            );
          const light = deps.icons.spinner("light");
          const dark = deps.icons.spinner("dark");
          return light !== undefined && dark !== undefined
            ? { light, dark }
            : undefined;
        },
        idle: idleIcon,
      },
      (icon) => {
        if (!this._disposed) this._panel.iconPath = icon;
      },
    );
    this._panel.onDidDispose(() => {
      // A close VS Code reported on its own (the user closed the tab):
      // run the full teardown including the manager's bookkeeping.
      if (this._disposed) return;
      this.dispose();
    });
    // Register first: hub.register replays state without rendering (no
    // webview attached yet), then attach renders once with the origin
    // baked — the app boots a single time.
    deps.hub.register(this._chat);
    this._chat.attach(this._panel.webview);
    deps.hub.noteAttached(this._chat);
    // Events posted while VS Code had this panel hidden can be dropped;
    // resync on activation, and record the session as last-active. The
    // activation also reads the tab: the green turn-ended mark clears.
    this._stateSub = this._panel.onDidChangeViewState((e) => {
      if (!e.webviewPanel.active) return;
      this._signal.activated();
      this._chat.noteVisible();
      onActive(_sessionId);
    });
  }

  get id(): string {
    return this._sessionId;
  }

  get title(): string {
    return this._panel.title;
  }

  set title(value: string) {
    if (!this._disposed) this._panel.title = value;
  }

  // The tab's current icon (the status prefix's frame) — test surface.
  get icon(): unknown {
    return this._panel.iconPath;
  }

  get isActive(): boolean {
    return this._panel.active;
  }

  get isVisible(): boolean {
    return this._panel.visible;
  }

  get chat(): AppHost {
    return this._chat;
  }

  reveal(preserveFocus = false) {
    if (!this._disposed) this._panel.reveal(undefined, preserveFocus);
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._stateSub.dispose();
    this._deps.hub.unregister(this._chat);
    this._chat.dispose();
    this._panel.dispose();
    // Manager bookkeeping runs on every dispose path — its own call or a
    // user close (which went through the same dispose above).
    this._onClose();
  }
}

// Owns the open session panels (Map<sessionId, panel>): one per session,
// opened on demand, closed with their tabs, revived by per-viewType
// serializers after a reload.
export class SessionPanels implements vscode.Disposable {
  private readonly _panels = new Map<string, SessionPanel>();
  // Serializer registrations per session viewType (registering the same
  // viewType twice throws); they live as long as the extension.
  private readonly _serialized = new Set<string>();
  private readonly _serializerSubs: vscode.Disposable[] = [];
  private _lastActiveId: string | undefined;
  private _disposed = false;

  constructor(private readonly _deps: SessionPanelsDeps) {}

  has(id: string): boolean {
    return this._panels.has(id);
  }

  get(id: string): SessionPanel | undefined {
    return this._panels.get(id);
  }

  // Open session ids in open order (the shape of opencode.tabs).
  ids(): string[] {
    return [...this._panels.keys()];
  }

  all(): SessionPanel[] {
    return [...this._panels.values()];
  }

  get lastActiveId(): string | undefined {
    return this._lastActiveId;
  }

  // The panel commands talk to: the active one, else any visible one,
  // else the last-active one.
  target(): SessionPanel | undefined {
    for (const p of this._panels.values()) if (p.isActive) return p;
    for (const p of this._panels.values()) if (p.isVisible) return p;
    return this._lastActiveId !== undefined
      ? this._panels.get(this._lastActiveId)
      : undefined;
  }

  // Open (or reveal) one session's panel.
  open(id: string, opts: OpenPanelOptions = {}): SessionPanel {
    this.ensureSerializer(id);
    const existing = this._panels.get(id);
    if (existing) {
      if (opts.show !== false) existing.reveal();
      if (opts.title !== undefined) existing.title = opts.title;
      return existing;
    }
    const panel = new SessionPanel(
      this._deps,
      id,
      opts.title ?? id,
      () => this._panelClosed(id),
      (activeId) => this._noteActive(activeId),
      opts,
    );
    this._panels.set(id, panel);
    this._lastActiveId = id;
    this._onPanelsChanged();
    return panel;
  }

  setTitle(id: string, title: string) {
    const panel = this._panels.get(id);
    if (panel) panel.title = title;
  }

  // Throw one session's panel away and build a fresh one (dead-webview
  // recovery: only a fresh webview revives a dead renderer), keeping the
  // tab's place in the strip.
  recreate(id: string): SessionPanel {
    const spot = tabSpot(id);
    this._panels.get(id)?.dispose();
    const panel = this.open(id);
    restoreTabSpot(id, spot);
    return panel;
  }

  // Register this window's revival serializer for one session viewType.
  // Idempotent; call for every persisted id at activation and before
  // creating a panel with a new one.
  ensureSerializer(id: string): void {
    const viewType = sessionViewType(id);
    if (this._serialized.has(viewType)) return;
    this._serialized.add(viewType);
    this._serializerSubs.push(
      vscode.window.registerWebviewPanelSerializer(viewType, {
        deserializeWebviewPanel: async (panel) => {
          this._deps.ensureServer();
          // A session nothing ever happened in isn't worth a tab after a
          // reload — drop the restored tab instead of swapping (and a
          // panel the stray-heal raced in for it, if any). Fail-open: a
          // server hiccup revives as before.
          if (await this._deps.isBlankSession(id)) {
            panel.dispose();
            this._panels.get(id)?.dispose();
            return;
          }
          // A revived tab carries its persisted (readonly) panel options —
          // swap it: a fresh panel in the same column first (the group
          // never empties), then drop the restored one. The restored tab's
          // label keeps the session title without a server round-trip,
          // and its slot in the strip is kept (a fresh tab would land at
          // the end, reordering the user's tabs).
          const spot = tabSpot(id);
          this.open(id, {
            column: panel.viewColumn ?? vscode.ViewColumn.Active,
            title: panel.title,
          });
          panel.dispose();
          restoreTabSpot(id, spot);
        },
      }),
    );
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const p of this._panels.values()) p.dispose();
    this._panels.clear();
    for (const sub of this._serializerSubs) sub.dispose();
    this._serializerSubs.length = 0;
  }

  private _panelClosed(id: string) {
    this._panels.delete(id);
    if (this._lastActiveId === id) this._lastActiveId = undefined;
    this._onPanelsChanged();
  }

  // A panel's tab became the active editor: it is the last-active session
  // (opencode.route keeps the same shape the app and commands know).
  private _noteActive(id: string) {
    this._lastActiveId = id;
    this._deps.routeStore.set(JSON.stringify({ view: "session", id }));
  }

  private _onPanelsChanged() {
    const ids = this.ids();
    this._deps.tabsStore.set(ids);
    this._deps.onPanelsChanged?.(ids);
  }
}
