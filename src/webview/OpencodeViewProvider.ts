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

export interface NavigatorHostDeps {
  routeStore: RouteStore;
  tabsStore: TabsStore;
  projectStore: ProjectStore;
  openProject: OpenProjectHandler;
  hiddenModels: HiddenModels;
  hiddenProviders: HiddenProviders;
}

// Sidebar host for the chat webview (Stage B turns it into the session
// navigator). All rendering/message logic lives in AppHost; this adapter
// only tracks view-specific state (visibility, which sidebar the view
// sits in).
export class OpencodeViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _visSub?: vscode.Disposable;
  private _sidebarType: "primary" | "auxiliary" | null = null;
  private readonly _chat: AppHost;

  constructor(
    private readonly _hub: ChatHub,
    extensionUri: vscode.Uri,
    private readonly _onResolve: () => void,
    deps: NavigatorHostDeps,
  ) {
    this._chat = new AppHost({
      extensionUri,
      kind: "navigator",
      ...deps,
      claimBell: (kind) => this._hub.claimBell(kind),
    });
    _hub.register(this._chat);
  }

  get isViewVisible(): boolean {
    return !!this._view?.visible;
  }

  get sidebarType(): "primary" | "auxiliary" | null {
    return this._sidebarType;
  }

  set sidebarType(type: "primary" | "auxiliary" | null) {
    this._sidebarType = type;
  }

  get chat(): AppHost {
    return this._chat;
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this._view = webviewView;
    this._onResolve();
    this._chat.attach(webviewView.webview);
    this._hub.noteAttached(this._chat);
    // Events posted while VS Code had this view hidden can be dropped;
    // resync when it shows again.
    this._visSub?.dispose();
    this._visSub = webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) this._chat.noteVisible();
    });
  }
}
