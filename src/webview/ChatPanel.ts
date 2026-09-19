import * as vscode from "vscode";
import {
  AppHost,
  type HiddenModels,
  type OpenProjectHandler,
  type ProjectStore,
  type RouteStore,
  type TabsStore,
} from "./AppHost";
import { ChatHub } from "./ChatHub";

// The editor-tab webview's view type. Also lives in package.json
// (activationEvents) — keep the two in sync.
export const CHAT_VIEWTYPE = "opencodeGui.chatPanel";

// Singleton editor-tab host for the chat webview. Claude Code Cmd+Esc
// semantics: show() reveals the existing tab, never duplicates it; toggle
// closes it when it is the active tab.
export class ChatPanel implements vscode.Disposable {
  private static _instance: ChatPanel | undefined;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _chat: AppHost;
  private readonly _hub: ChatHub;
  private readonly _onDispose: () => void;
  private readonly _stateSub: vscode.Disposable;
  // Set when teardown starts from dispose(); the panel's onDidDispose only
  // reports a user close (and runs _onDispose) when it fires on its own.
  private _disposed = false;

  private constructor(
    hub: ChatHub,
    extensionUri: vscode.Uri,
    onDispose: () => void,
    routeStore: RouteStore,
    tabsStore: TabsStore,
    projectStore: ProjectStore,
    openProject: OpenProjectHandler,
    hiddenModels: HiddenModels,
    column?: vscode.ViewColumn,
  ) {
    this._hub = hub;
    this._onDispose = onDispose;
    this._chat = new AppHost(
      extensionUri,
      routeStore,
      tabsStore,
      projectStore,
      openProject,
      hiddenModels,
    );
    this._panel = vscode.window.createWebviewPanel(
      CHAT_VIEWTYPE,
      "Open Code Sessions",
      column ?? vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, enableFindWidget: true },
    );
    // Tab icon; panel tab icons don't support SVG, so PNG.
    this._panel.iconPath = vscode.Uri.joinPath(extensionUri, "icon.png");
    this._panel.onDidDispose(() => {
      if (this._disposed) return;
      this.dispose();
      this._onDispose();
    });
    // Register first: hub.register replays state without rendering (no
    // webview attached yet), then attach renders once with the origin
    // baked — the app boots a single time.
    hub.register(this._chat);
    this._chat.attach(this._panel.webview);
    // Events posted while VS Code had this panel hidden can be dropped;
    // resync on activation.
    this._stateSub = this._panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) this._chat.noteVisible();
    });
  }

  static get instance(): ChatPanel | undefined {
    return ChatPanel._instance;
  }

  // A tab VS Code restored after a window reload comes back with the
  // options it was persisted with — and panel options are readonly, so a
  // tab persisted without enableFindWidget is Ctrl+F-dead forever if
  // adopted. Swap it instead: a fresh panel in the same column first (the
  // group never empties), then drop the restored one. The restored panel's
  // options aren't readable from the API, so every restore swaps; from
  // then on the persisted tab carries the flag and the swap is just the
  // normal revive reboot.
  static replace(
    hub: ChatHub,
    extensionUri: vscode.Uri,
    panel: vscode.WebviewPanel,
    onDispose: () => void,
    routeStore: RouteStore,
    tabsStore: TabsStore,
    projectStore: ProjectStore,
    openProject: OpenProjectHandler,
    hiddenModels: HiddenModels,
  ): ChatPanel {
    ChatPanel._instance?.dispose();
    ChatPanel._instance = new ChatPanel(
      hub,
      extensionUri,
      onDispose,
      routeStore,
      tabsStore,
      projectStore,
      openProject,
      hiddenModels,
      panel.viewColumn ?? vscode.ViewColumn.Active,
    );
    panel.dispose();
    return ChatPanel._instance;
  }

  static show(
    hub: ChatHub,
    extensionUri: vscode.Uri,
    onDispose: () => void,
    routeStore: RouteStore,
    tabsStore: TabsStore,
    projectStore: ProjectStore,
    openProject: OpenProjectHandler,
    hiddenModels: HiddenModels,
  ): ChatPanel {
    ChatPanel._instance ??= new ChatPanel(
      hub,
      extensionUri,
      onDispose,
      routeStore,
      tabsStore,
      projectStore,
      openProject,
      hiddenModels,
    );
    ChatPanel._instance._panel.reveal();
    return ChatPanel._instance;
  }

  // Dead-webview recovery: throw the singleton away and build a fresh
  // panel (the tab reopens in the active column). Only for a webview
  // beyond saving — its renderer process died — since a rebuild resets
  // the app's in-memory state (scroll, expanded rows).
  static recreate(
    hub: ChatHub,
    extensionUri: vscode.Uri,
    onDispose: () => void,
    routeStore: RouteStore,
    tabsStore: TabsStore,
    projectStore: ProjectStore,
    openProject: OpenProjectHandler,
    hiddenModels: HiddenModels,
  ): ChatPanel {
    ChatPanel._instance?.dispose();
    return ChatPanel.show(
      hub,
      extensionUri,
      onDispose,
      routeStore,
      tabsStore,
      projectStore,
      openProject,
      hiddenModels,
    );
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

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (ChatPanel._instance === this) ChatPanel._instance = undefined;
    this._hub.unregister(this._chat);
    this._stateSub.dispose();
    this._chat.dispose();
    this._panel.dispose();
  }
}
