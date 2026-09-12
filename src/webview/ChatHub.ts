import { AppHost } from "./AppHost";

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string; showInstallHint: boolean }
  | { kind: "url"; url: string };

// Owns the last loading/error/url state and fans it out to every chat
// webview (sidebar + editor tab), replaying it to late-attaching ones.
export class ChatHub {
  private _state: State = { kind: "loading" };
  private readonly _chats = new Set<AppHost>();

  // Current loading/error/url state (test surface).
  get state(): State {
    return this._state;
  }

  register(chat: AppHost) {
    this._chats.add(chat);
    this._push(chat, this._state);
  }

  unregister(chat: AppHost) {
    this._chats.delete(chat);
  }

  setServerUrl(url: string) {
    this._state = { kind: "url", url };
    this._broadcast();
  }

  setError(message: string, showInstallHint = true) {
    this._state = { kind: "error", message, showInstallHint };
    this._broadcast();
  }

  setLoading() {
    this._state = { kind: "loading" };
    this._broadcast();
  }

  // Re-serve every chat's shell with fresh baked state (theme change).
  rerender() {
    for (const chat of this._chats) chat.rerender();
  }

  // The codeCopyModifier setting changed (main.ts watches it).
  setCopyModifier(modifier: string) {
    for (const chat of this._chats) chat.setCopyModifier(modifier);
  }

  // The readySound setting changed (main.ts watches it).
  setReadySound(enabled: boolean) {
    for (const chat of this._chats) chat.setReadySound(enabled);
  }

  // The permissionSound setting changed (main.ts watches it).
  setPermissionSound(enabled: boolean) {
    for (const chat of this._chats) chat.setPermissionSound(enabled);
  }

  // The questionSound setting changed (main.ts watches it).
  setQuestionSound(enabled: boolean) {
    for (const chat of this._chats) chat.setQuestionSound(enabled);
  }

  private _broadcast() {
    for (const chat of this._chats) this._push(chat, this._state);
  }

  private _push(chat: AppHost, state: State) {
    switch (state.kind) {
      case "url":
        chat.setServerUrl(state.url);
        break;
      case "error":
        chat.setError(state.message, state.showInstallHint);
        break;
      case "loading":
        chat.setLoading();
        break;
    }
  }
}
