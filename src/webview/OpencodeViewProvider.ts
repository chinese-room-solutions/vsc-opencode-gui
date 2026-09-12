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

// Sidebar host for the chat webview. All rendering/message logic lives in
// AppHost; this adapter only tracks view-specific state (visibility, which
// sidebar the view sits in).
export class OpencodeViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _visSub?: vscode.Disposable;
  private _sidebarType: "primary" | "auxiliary" | null = null;
  private readonly _chat: AppHost;

  constructor(
    hub: ChatHub,
    extensionUri: vscode.Uri,
    private readonly _onResolve: () => void,
    routeStore: RouteStore,
    tabsStore: TabsStore,
    projectStore: ProjectStore,
    openProject: OpenProjectHandler,
    hiddenModels: HiddenModels,
  ) {
    this._chat = new AppHost(
      extensionUri,
      routeStore,
      tabsStore,
      projectStore,
      openProject,
      hiddenModels,
    );
    hub.register(this._chat);
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
    // Events posted while VS Code had this view hidden can be dropped;
    // resync when it shows again.
    this._visSub?.dispose();
    this._visSub = webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) this._chat.noteVisible();
    });
  }
}
