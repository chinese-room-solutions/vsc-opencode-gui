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

export interface SessionPanelsDeps {
  hub: ChatHub;
  extensionUri: vscode.Uri;
  routeStore: RouteStore;
  tabsStore: TabsStore;
  projectStore: ProjectStore;
  openProject: OpenProjectHandler;
  hiddenModels: HiddenModels;
  hiddenProviders: HiddenProviders;
  // Fires the server up (revival and panel opens need it eventually).
  ensureServer: () => void;
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
    });
    this._panel = vscode.window.createWebviewPanel(
      sessionViewType(_sessionId),
      title,
      opts.show === false
        ? { viewColumn: opts.column ?? vscode.ViewColumn.Active, preserveFocus: true }
        : opts.column ?? vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, enableFindWidget: true },
    );
    // Tab icon; panel tab icons don't support SVG, so PNG.
    this._panel.iconPath = vscode.Uri.joinPath(deps.extensionUri, "icon.png");
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
    // resync on activation, and record the session as last-active.
    this._stateSub = this._panel.onDidChangeViewState((e) => {
      if (!e.webviewPanel.active) return;
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
  // recovery: only a fresh webview revives a dead renderer).
  recreate(id: string): SessionPanel {
    this._panels.get(id)?.dispose();
    return this.open(id);
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
        deserializeWebviewPanel: (panel) => {
          this._deps.ensureServer();
          // A revived tab carries its persisted (readonly) panel options —
          // swap it: a fresh panel in the same column first (the group
          // never empties), then drop the restored one. The restored tab's
          // label keeps the session title without a server round-trip.
          this.open(id, {
            column: panel.viewColumn ?? vscode.ViewColumn.Active,
            title: panel.title,
          });
          panel.dispose();
          return Promise.resolve();
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
