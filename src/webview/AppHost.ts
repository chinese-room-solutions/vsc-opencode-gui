import * as vscode from "vscode";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { themeStyle } from "../theme";
import { tokenizeToTokens } from "../tokenizer";
import { saveAttachment, savePromptAttachments } from "../attachments";
import { serverAuthHeaders } from "../server/serverAuth";
import type { Dialect } from "../server/dialect";
import { log } from "../log";
import type { PeerInfo } from "./Peers";

// The last app route (workspaceState-backed; per-folder, so no cross-folder
// validation is needed). Written by the hosts (last-active session) and
// read by commands that need the current session.
export interface RouteStore {
  get(): string | undefined;
  set(value: string): void;
}

// Open session panels' ids, in open order (workspaceState-backed in
// main.ts). Persisted so the next activation can register a revival
// serializer per session; still baked into the page for the transitional
// in-app tab bar (Stage B drops it).
export interface TabsStore {
  get(): string[];
  set(value: string[]): void;
}

// Deleted-project tombstones (globalState-backed in main.ts). The list is
// baked into the page on every render; the app mutates it via the
// tombstone message and hides rows from its local copy.
export interface ProjectStore {
  list(): string[];
  tombstoned(path: string): boolean;
  tombstone(path: string): void;
}

// Opens another project's folder in a new VS Code window, optionally
// deep-linking one of its sessions (the pendingOpen handoff).
export type OpenProjectHandler = (
  folder: string,
  session?: string,
) => void | Promise<void>;

// Model rows the picker hides ("Manage models" — globalState-backed in
// main.ts). Baked into the page on every render; the Manage Models command
// pushes changes live.
export interface HiddenModels {
  get(): string[];
}

// Providers the picker hides ("Manage providers" — globalState-backed in
// main.ts, bare providerID refs). Same bake/push lifecycle as the models
// list.
export interface HiddenProviders {
  get(): string[];
}

// Which host a page is baked for (read by the app from the
// opencode-host meta): a "session" host is one conversation's editor tab,
// a "navigator" host is the sidebar view. Stage B splits the app on it.
export type HostKind = "navigator" | "session";

// The three attention chimes (the app's sound.ts owns playback; the kinds
// cross the seam so the host can arbitrate who rings).
export type BellKind = "ready" | "permission" | "question";

// The tab-status facts a session page reports (store.ts/App.tsx →
// AppHost → SessionPanel's TabSignal). All optional: the busy/attention
// poster and setIdle's turnEnded post are independent reporters.
export type TabSignalFacts = import("./TabSignal").TabSignalFacts;

export interface AppHostOptions {
  extensionUri: vscode.Uri;
  kind: HostKind;
  // The session a "session" host is bound to; pinned into the baked boot
  // route so the app opens straight into it.
  sessionId?: string;
  routeStore: RouteStore;
  tabsStore: TabsStore;
  projectStore: ProjectStore;
  openProject: OpenProjectHandler;
  hiddenModels: HiddenModels;
  hiddenProviders: HiddenProviders;
  // Window-wide chime arbiter (ChatHub): true when this page's claim won
  // the window and the grant should be posted back. Every chat page rings
  // the same event, and webview origins don't cross (VS Code keys them by
  // viewType), so nothing browser-side can gate them.
  claimBell?: (kind: BellKind) => boolean;
  // The page's tab-status facts landed (a session host's TabSignal).
  onTabSignal?: (facts: TabSignalFacts) => void;
}

// The app pings at boot, then every 15 s. Silence past three cadences
// means the renderer process is dead (VS Code's grey placeholder) —
// Restart rebuilds the chat tab on this signal.
const PING_TIMEOUT_MS = 45_000;
// A freshly attached page pings within seconds of load; silence this long
// means it never booted (see isUnresponsive).
const BOOT_GRACE_MS = 20_000;

// One compact line of why a relayed call failed, for the app's error banners
// and the deduped relay log line. The server's own message when it sent one
// ({"name","data":{"message"}} and plain {"message"} shapes), else just the
// transport fact.
function relayFailureReason(err: unknown): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string } };
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return "request timed out";
  const code = e?.cause?.code;
  return `${e?.name ?? "error"}${code ? ` ${code}` : ""}`;
}

function serverErrorMessage(json: unknown): string | undefined {
  if (!json || typeof json !== "object") return undefined;
  const j = json as {
    message?: unknown;
    data?: { message?: unknown };
    error?: { message?: unknown };
  };
  const msg = j.data?.message ?? j.message ?? j.error?.message;
  return typeof msg === "string" && msg.trim() ? msg.trim().slice(0, 140) : undefined;
}


// ServerEvent, as fed to the app through the pump (mirrors
// src/webview/app/events.ts across the postMessage seam). ChatHub owns the
// connection and forwards frames here.
export interface ServerEvent {
  id: string;
  type: string;
  data: unknown;
}

export type SseState = "connecting" | "connected" | "offline";

// Host-side half of a chat webview: renders the app shell (chat.html +
// out/webview/app.js), shows server status, and relays the app's traffic to
// the server — the webview origin is opaque, so the server's CORS would
// block every direct call; the app posts api-requests here and receives the
// SSE stream forwarded from ChatHub (one pump set per server, not per
// host). State is fanned out from ChatHub; every change re-renders the
// shell because CSP and the app's boot state are baked into the HTML — a
// host postMessage can race the first load.
export class AppHost implements vscode.Disposable {
  private readonly _extensionUri: vscode.Uri;
  private readonly _kind: HostKind;
  private readonly _sessionId: string | undefined;
  private readonly _routeStore: RouteStore;
  private readonly _tabsStore: TabsStore;
  private readonly _projectStore: ProjectStore;
  private readonly _openProject: OpenProjectHandler;
  private readonly _hiddenModels: HiddenModels;
  private readonly _hiddenProviders: HiddenProviders;
  private readonly _claimBell: ((kind: BellKind) => boolean) | undefined;
  private readonly _onTabSignal: ((facts: TabSignalFacts) => void) | undefined;

  constructor(options: AppHostOptions) {
    this._extensionUri = options.extensionUri;
    this._kind = options.kind;
    this._sessionId = options.sessionId;
    this._routeStore = options.routeStore;
    this._tabsStore = options.tabsStore;
    this._projectStore = options.projectStore;
    this._openProject = options.openProject;
    this._hiddenModels = options.hiddenModels;
    this._hiddenProviders = options.hiddenProviders;
    this._claimBell = options.claimBell;
    this._onTabSignal = options.onTabSignal;
  }

  private _webview?: vscode.Webview;
  // Route → consecutive failed relays; collapses restart-time bursts to
  // one line per route (see _relayApi).
  private _relayFailures = new Map<string, number>();
  private _serverUrl?: string;
  // Dialect of the server behind _serverUrl; probed once by ServerManager
  // and fanned out through ChatHub with the url, so the app boots knowing
  // its routes.
  private _dialect: Dialect = "v1";
  private _error?: { message: string; showInstallHint: boolean };
  private _attachments: vscode.Disposable[] = [];
  // insert-text texts that arrived before the page's message listener
  // existed (see addToChat); delivered on the first ping.
  private _pendingInserts: string[] = [];
  // Last heartbeat from the app; undefined until its first ping (a fresh
  // page pings at boot, so a just-loaded webview never reads as dead).
  private _lastPingAt?: number;
  // When the current page was attached — feeds the never-pinged half of
  // isUnresponsive: a page that never booted (blank grey tab) has no
  // heartbeat to go quiet, so silence-since-attach is its only signal.
  private _attachedAt?: number;
  // Last peer registry snapshot (replayed on ping; see setPeers).
  private _peers: PeerInfo[] = [];

  attach(webview: vscode.Webview) {
    for (const d of this._attachments) d.dispose();
    this._attachments = [];
    this._webview = webview;
    // A fresh page pings at boot; a stale timestamp from a previous page
    // must not read as dead in the meantime.
    this._lastPingAt = undefined;
    this._attachedAt = Date.now();

    // asWebviewUri resources (the attachments preview relay) need the
    // attachments dir next to the extension root as a local resource.
    const attachmentRoot =
      vscode.workspace.workspaceFolders?.[0] &&
      vscode.Uri.joinPath(
        vscode.workspace.workspaceFolders[0].uri,
        ".opencode",
        "attachments",
      );
    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        this._extensionUri,
        ...(attachmentRoot ? [attachmentRoot] : []),
      ],
    };

    this._attachments.push(
      webview.onDidReceiveMessage((message) => {
        // API relay: fetch from here (Node fetch, no CORS) and post the
        // parsed reply back. Always answers, on failure too.
        if (message.type === "api-request") {
          void this._relayApi(message);
        }
        // The page asks to ring the window's chime (sound.ts's claim):
        // grant it only when the arbiter says this page won the window.
        if (
          message.type === "bell-claim" &&
          (message.kind === "ready" ||
            message.kind === "permission" ||
            message.kind === "question") &&
          this._claimBell?.(message.kind)
        ) {
          this._post({ type: "bell-grant", kind: message.kind });
        }
        // The session page's tab-status facts (busy/attention poster and
        // setIdle's turnEnded post): coerce and hand to the panel's
        // TabSignal; absent fields stay untouched.
        if (message.type === "tab-signal" && this._onTabSignal) {
          const m = message as { busy?: unknown; attention?: unknown; turnEnded?: unknown };
          this._onTabSignal({
            ...(typeof m.busy === "boolean" ? { busy: m.busy } : {}),
            ...(typeof m.attention === "boolean"
              ? { attention: m.attention }
              : {}),
            ...(m.turnEnded === true ? { turnEnded: true } : {}),
          });
        }
        // Editor-true code blocks: tokenize a fenced block with the real
        // grammar and theme (src/tokenizer.ts) and hand back the token runs.
        // The reply always comes; null tokens mean the webview keeps its
        // highlight.js rendering.
        if (
          message.type === "tokenize" &&
          typeof message.id === "string" &&
          typeof message.lang === "string" &&
          typeof message.code === "string"
        ) {
          void tokenizeToTokens(message.lang, message.code).then((tokens) => {
            this._post({ type: "tokenized", id: message.id, tokens: tokens ?? null });
          });
        }
        // Escape drops focus back to the editor, like any VS Code editor.
        if (message.type === "escape-pressed") {
          void vscode.commands.executeCommand(
            "workbench.action.focusActiveEditorGroup",
          );
        }
        // The page crashed onto its recovery card and asked out: html
        // reassignment reboots it as a fresh document (clean module state).
        if (message.type === "crash-reload") {
          this._renderCurrentState();
        }
        // Liveness heartbeat from the app (every 15 s): feeds
        // isUnresponsive, the signal Restart uses to rebuild a dead tab.
        if (message.type === "ping") {
          this._lastPingAt = Date.now();
          // Replay the peer registry: the page may have loaded after the
          // last push, and the store set is idempotent.
          if (this._peers.length > 0)
            this._post({ type: "peers", peers: this._peers });
          // Text queued while this page was mid-boot (see addToChat): the
          // ping says the boot script ran, so posts dispatched now reach
          // the listener wired at its end.
          const queued = this._pendingInserts;
          this._pendingInserts = [];
          for (const text of queued) this._post({ type: "insert-text", text });
        }
        // The webview's own console is unreachable from tooling; the app
        // forwards its failure diagnostics here.
        if (message.type === "app-log" && typeof message.text === "string") {
          const level: "info" | "warn" | "error" | undefined =
            message.level === "info" || message.level === "warn" || message.level === "error"
              ? message.level
              : undefined;
          if (level) log[level](message.text);
        }
        // Route bookkeeping: the app owns its view; the host only records
        // the last-active session (commands target it). The app-reported
        // tab list is ignored — the host owns opencode.tabs (one editor
        // panel per session) since Stage A.
        if (
          message.type === "route-changed" &&
          message.route &&
          typeof message.route === "object"
        ) {
          this._routeStore.set(JSON.stringify(message.route));
        }
        // The navigator's session rows (Stage B): open or reveal the
        // session's own editor panel.
        if (message.type === "open-session" && typeof message.id === "string") {
          void vscode.commands.executeCommand("opencodeGui.openSession", message.id);
        }
        // The store's session rows retitle (auto-titler after the first
        // prompt, renames); the tab label follows. The host's command
        // ignores sessions without an open panel.
        if (
          message.type === "session-titled" &&
          typeof message.id === "string" &&
          typeof message.title === "string"
        ) {
          void vscode.commands.executeCommand(
            "opencodeGui.setSessionTitle",
            message.id,
            message.title,
          );
        }
        // Home: another project's folder opens in a new window, optionally
        // deep-linking a session (the target window consumes pendingOpen).
        if (
          message.type === "open-project" &&
          typeof message.path === "string"
        ) {
          void this._openProject(
            message.path,
            typeof message.session === "string" ? message.session : undefined,
          );
        }
        // Home: tombstone bookkeeping — persisted here, baked back into the
        // page on the next render.
        if (
          message.type === "project-tombstoned" &&
          typeof message.path === "string"
        ) {
          this._projectStore.tombstone(message.path);
        }
        // Model picker footer: the Manage Models QuickPick is the native
        // command — it needs globalState and the window, not this host. The
        // provider field scopes it to one provider's models when given.
        if (message.type === "manage-models") {
          void vscode.commands.executeCommand(
            "opencodeGui.manageModels",
            typeof message.provider === "string" ? message.provider : undefined,
          );
        }
        // Provider menu footer: same hand-off for providers.
        if (message.type === "manage-providers") {
          void vscode.commands.executeCommand("opencodeGui.manageProviders");
        }
        // Composer "+": native multi-select dialog; the picks go back as
        // {uri, name, text} chips the next prompt sends as file parts.
        // Textiness is stamped here by sniffing each file's head — best
        // effort per file, an unreadable head just skips the stamp.
        if (message.type === "attach-file") {
          void (async () => {
            try {
              const uris = await vscode.window.showOpenDialog({
                canSelectMany: true,
                openLabel: "Attach",
              });
              if (!uris?.length) return;
              const files = await Promise.all(
                uris.map(async (u) => {
                  let text = false;
                  try {
                    text = await sniffedText(u);
                  } catch (err) {
                    log.error(`attach sniff failed for ${u.fsPath}:`, err);
                  }
                  return {
                    uri: u.toString(true),
                    name: path.basename(u.fsPath),
                    text,
                  };
                }),
              );
              this._post({ type: "files-picked", files });
            } catch (err) {
              log.error("attach dialog failed:", err);
            }
          })();
        }
        // Chat file reference: relative paths resolve against the first
        // workspace folder; open and reveal the (1-based) line range.
        if (message.type === "open-file" && typeof message.path === "string") {
          const open = async () => {
            const abs = absPathOf(message.path);
            const uri = vscode.Uri.file(abs);
            try {
              const doc = await vscode.workspace.openTextDocument(uri);
              const line = Math.max(0, (parseInt(message.line, 10) || 1) - 1);
              const endLine = message.endLine
                ? Math.max(0, (parseInt(message.endLine, 10) || 1) - 1)
                : line;
              await vscode.window.showTextDocument(doc, {
                selection: new vscode.Range(line, 0, endLine, 0),
              });
            } catch {
              // Binaries (images, pdfs) can't be text documents — VS Code's
              // own editor for the type is the right destination.
              await vscode.commands.executeCommand("vscode.open", uri);
            }
          };
          open().catch(async (err) => {
            await vscode.window.showErrorMessage(
              `Could not open ${message.path}: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
        }
        // Composer paste/drop: snapshot a non-image data-URI attachment to
        // disk now, so the chip is click-to-open and the prompt can carry a
        // file:// url instead of the base64 payload. Best effort — on any
        // failure no reply comes and the chip keeps its data URI.
        if (
          message.type === "save-attachment" &&
          typeof message.uri === "string" &&
          typeof message.name === "string" &&
          typeof message.sessionId === "string"
        ) {
          void (async () => {
            try {
              const ws = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
              if (!ws) return;
              const file = await saveAttachment(
                ws,
                message.sessionId,
                message.uri,
                message.name,
                typeof message.mime === "string" ? message.mime : "",
              );
              if (file)
                this._post({
                  type: "attachment-saved",
                  sessionId: message.sessionId,
                  from: message.uri,
                  path: vscode.Uri.file(file).toString(true),
                });
            } catch (err) {
              log.error("attach snapshot failed:", err);
            }
          })();
        }
        // Sent-chip thumbnails: the transcript's file:// attachment urls
        // can't be fetched in the page, so it asks for a webview-servable
        // one. The webview-requested path must stay inside the attachments
        // root — anything else gets no reply (the chip keeps its ext
        // form). Best effort, same contract as save-attachment.
        if (
          message.type === "read-attachment" &&
          typeof message.path === "string"
        ) {
          void (async () => {
            try {
              const ws = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
              if (!ws) return;
              let uri: vscode.Uri;
              try {
                uri = vscode.Uri.parse(message.path, true);
              } catch {
                return;
              }
              if (uri.scheme !== "file") return;
              const root = path.join(ws, ".opencode", "attachments");
              const rel = path.relative(root, uri.fsPath);
              if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return;
              const st = await fs.promises.stat(uri.fsPath);
              if (!st.isFile()) return;
              this._post({
                type: "attachment-preview",
                path: message.path,
                url: webview.asWebviewUri(uri).toString(),
              });
            } catch (err) {
              log.error("attach preview failed:", err);
            }
          })();
        }
        // An attachment chip's open: hand the file to the OS default tool
        // for its extension (PDFs, media — anything not opened as text).
        if (message.type === "open-external" && typeof message.path === "string") {
          vscode.env.openExternal(vscode.Uri.file(absPathOf(message.path))).then(
            (opened) => {
              if (!opened)
                vscode.window.showErrorMessage(
                  `Could not open ${message.path}.`,
                );
            },
            (err: unknown) =>
              vscode.window.showErrorMessage(
                `Could not open ${message.path}: ${err instanceof Error ? err.message : String(err)}`,
              ),
          );
        }
        // A fetched URL opens in the system browser.
        if (message.type === "open-url" && typeof message.url === "string") {
          vscode.env.openExternal(vscode.Uri.parse(message.url)).then(
            (opened) => {
              if (!opened)
                vscode.window.showErrorMessage(
                  `Could not open ${message.url}.`,
                );
            },
            (err: unknown) =>
              vscode.window.showErrorMessage(
                `Could not open ${message.url}: ${err instanceof Error ? err.message : String(err)}`,
              ),
          );
        }
      }),
    );

    this._renderCurrentState();
  }

  // The url arrives with its dialect (probed once by ServerManager): bake
  // both — the app's routes, prompt body, and envelopes hang off the
  // dialect.
  setServerUrl(url: string, dialect: Dialect) {
    this._serverUrl = url;
    this._dialect = dialect;
    this._error = undefined;
    this._renderCurrentState();
    // Belt and braces for a page that somehow booted before the bake
    // (idempotent in the app).
    this._post({ type: "dialect", dialect });
  }

  setError(message: string, showInstallHint = true) {
    this._error = { message, showInstallHint };
    this._serverUrl = undefined;
    this._renderCurrentState();
  }

  setLoading() {
    this._serverUrl = undefined;
    this._error = undefined;
    this._renderCurrentState();
  }

  addToChat(text: string) {
    // A page that has never pinged may still be mid-boot: host posts are
    // dispatched only after the boot script task completes (its message
    // listener is wired at the end), so an insert posted before the first
    // ping can drop. Queue it; the ping proves the boot ran.
    if (this._lastPingAt === undefined) {
      this._pendingInserts.push(text);
      return;
    }
    void this._webview?.postMessage({ type: "insert-text", text });
  }

  // A fresh session (the navigator's own new-session affordance, Stage B;
  // the app creates it and opens its tab).
  newSession() {
    void this._webview?.postMessage({ type: "new-session" });
  }

  // Hub-fed event stream (ChatHub owns the pumps): one frame, forwarded
  // as-is.
  receiveSseEvent(event: ServerEvent) {
    this._post({ type: "sse-event", event });
  }

  receiveSseState(state: SseState) {
    this._post({ type: "sse-state", state });
  }

  // Live picker-filter update from the Manage Models command (the boot
  // value is baked into the page — a postMessage can race the first load).
  setHiddenModels(refs: string[]) {
    this._post({ type: "hidden-models", ids: refs });
  }

  setHiddenProviders(refs: string[]) {
    this._post({ type: "hidden-providers", ids: refs });
  }

  // The codeCopyModifier setting changed (main.ts watches it); the boot
  // value rides the baked meta tag.
  setCopyModifier(modifier: string) {
    this._post({ type: "copy-modifier", modifier });
  }

  // Same for readySound: hot-pushable, boot value baked.
  setReadySound(enabled: boolean) {
    this._post({ type: "ready-sound", enabled });
  }

  // Same for permissionSound: hot-pushable, boot value baked.
  setPermissionSound(enabled: boolean) {
    this._post({ type: "permission-sound", enabled });
  }

  // Same for questionSound.
  setQuestionSound(enabled: boolean) {
    this._post({ type: "question-sound", enabled });
  }

  // Peer registry snapshot (PeerRegistry) for peer-card headers. The page
  // may not be listening when the first one races its load, so every ping
  // replays it — cheap, and idempotent in the store.
  setPeers(peers: PeerInfo[]) {
    this._peers = peers;
    this._post({ type: "peers", peers });
  }

  // The webview became visible again. VS Code suspends hidden webviews
  // (retainContextWhenHidden), and events posted while suspended can be
  // dropped — the host stream stays healthy, so no reconnect resync
  // fires. The app pulls truth itself on this cue.
  noteVisible() {
    this._post({ type: "resync" });
  }

  // True when the app's heartbeat has gone quiet — its renderer process is
  // almost certainly dead (a live app pings every 15 s; see main.tsx) — or
  // when a page attached long ago and never pinged at all: the app pings
  // at boot, so that page never loaded and the tab shows VS Code's grey
  // placeholder. BOOT_GRACE_MS keeps a slow load from reading as dead.
  get isUnresponsive(): boolean {
    if (this._lastPingAt !== undefined)
      return Date.now() - this._lastPingAt > PING_TIMEOUT_MS;
    return (
      this._attachedAt !== undefined &&
      Date.now() - this._attachedAt > BOOT_GRACE_MS
    );
  }

  // Toggle the context/cost ring's expanded breakdown (the
  // openContextSummary command's target).
  toggleContext() {
    void this._webview?.postMessage({ type: "toggle-context" });
  }

  // Re-serve the shell with fresh baked state (theme change).
  rerender() {
    this._renderCurrentState();
  }

  dispose() {
    for (const d of this._attachments) d.dispose();
    this._attachments = [];
    this._webview = undefined;
  }

  // Relay one app API call to the server. Semantics the app relies on: the
  // reply carries `json` only for application/json responses, and every
  // failure path — no server included — answers {ok:false} instead of
  // leaving the app waiting.
  private async _relayApi(message: {
    id?: number;
    method?: string;
    path?: string;
    body?: unknown;
    timeoutMs?: number;
  }): Promise<void> {
    const id = typeof message.id === "number" ? message.id : -1;
    // Not yet attached: a normal boot race (the app re-syncs on
    // server.connected), not a failure worth logging.
    if (!this._serverUrl || typeof message.path !== "string") {
      this._post({ type: "api-result", id, ok: false, error: "server not connected" });
      return;
    }
    try {
      // Snapshot the prompt's attachments to disk before the turn starts,
      // so the agent has a real file to reuse (see attachments.ts). Awaited:
      // the relay is the only serialization point between the composer
      // and the server. Failures inside never throw.
      const prompt = /^\/session\/([^/]+)\/prompt_async$/.exec(
        message.path,
      );
      if (
        prompt &&
        message.method === "POST" &&
        message.body &&
        typeof message.body === "object"
      ) {
        const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (ws) {
          await savePromptAttachments(
            ws,
            prompt[1],
            (message.body as { parts?: unknown }).parts,
          );
        }
      }
      const res = await fetch(`${this._serverUrl}${message.path}`, {
        method: message.method,
        // A hung (not failed) server connection must not wedge the app's
        // guarded requests forever. The caller can opt out with its own
        // long cap (the summarize POST awaits a whole compaction turn).
        signal: AbortSignal.timeout(
          typeof message.timeoutMs === "number" ? message.timeoutMs : 10_000,
        ),
        headers: {
          ...serverAuthHeaders(),
          ...(message.body === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        body:
          message.body === undefined ? undefined : JSON.stringify(message.body),
      });
      const isJson = (res.headers.get("content-type") ?? "").includes(
        "application/json",
      );
      const json = isJson ? await res.json() : undefined;
      // Failure reason for the app's banners: status + the server's own
      // message, or the non-JSON fact for a 2xx that skipped the JSON parse
      // (ok semantics stay unchanged — callers judge shape themselves).
      let error: string | undefined;
      if (!res.ok) {
        const detail = serverErrorMessage(json);
        error = `HTTP ${res.status}${detail ? `: ${detail}` : ""}`;
      } else if (!isJson) {
        error = `HTTP ${res.status} (${(res.headers.get("content-type") ?? "no content type").split(";")[0]} reply)`;
      }
      this._post({ type: "api-result", id, ok: res.ok, json, ...(error ? { error } : {}) });
      // A restart makes every in-flight fetch fail at once; log the first
      // failure per route, count the rest, and note the recovery once.
      // 404 stays out: the app probes possibly-dead sessions with it.
      const key = `${message.method} ${message.path}`;
      if (res.ok && !error) {
        const fails = this._relayFailures.get(key);
        if (fails !== undefined) {
          this._relayFailures.delete(key);
          if (fails > 1) log.info(`api relay recovered after ${fails} failed ${key} requests`);
        }
      } else if (res.status !== 404) {
        const fails = (this._relayFailures.get(key) ?? 0) + 1;
        this._relayFailures.set(key, fails);
        if (fails === 1) log.error(`api relay failed: ${key} ${error}`);
      }
    } catch (err) {
      const reason = relayFailureReason(err);
      const key = `${message.method} ${message.path}`;
      const fails = (this._relayFailures.get(key) ?? 0) + 1;
      this._relayFailures.set(key, fails);
      if (fails === 1) log.error("api relay failed:", message.method, message.path, err);
      this._post({ type: "api-result", id, ok: false, error: reason });
    }
  }

  private _post(message: unknown): void {
    void this._webview?.postMessage(message);
  }

  private _renderCurrentState() {
    const webview = this._webview;
    if (!webview) return;
    const html = this._html(webview);
    // Assigning .html re-navigates the page: a re-render with unchanged
    // state (attach sequencing, hub state settling) must not reload the
    // app out from under the user. Only a changed document reloads.
    if (this._lastHtml.get(webview) === html) return;
    this._lastHtml.set(webview, html);
    webview.html = html;
  }

  private _lastHtml = new WeakMap<vscode.Webview, string>();

  private _html(webview: vscode.Webview): string {
    const error = this._error;

    // The query busts the webview service worker's cache-first fetch: the
    // URI must change when the file does, or a rebuilt bundle never loads.
    const resource = (name: string) => {
      const file = vscode.Uri.joinPath(this._extensionUri, "out", "webview", name);
      const version = Math.floor(fs.statSync(file.fsPath).mtimeMs);
      return webview
        .asWebviewUri(file)
        .with({ query: String(version) })
        .toString();
    };

    return this._readTemplate("chat.html")
      // The theme style carries its own {{NONCE}} placeholder, so it goes
      // first and the nonce pass below fills it.
      .replaceAll("{{THEME_STYLE}}", themeStyle())
      .replaceAll("{{NONCE}}", crypto.randomBytes(16).toString("hex"))
      .replaceAll("{{CSP_SOURCE}}", webview.cspSource)
      .replaceAll("{{APP_JS}}", resource("app.js"))
      .replaceAll("{{APP_CSS}}", resource("app.css"))
      // The origin is only the app's ready flag now — all traffic is
      // relayed, so nothing in the page connects to it. Empty while
      // loading/error.
      .replaceAll("{{ORIGIN}}", this._serverUrl ?? "")
      // The server's dialect ("v2" or empty for v1): decides the app's
      // routes, prompt body, envelopes, and event translation.
      .replaceAll("{{DIALECT}}", this._dialect === "v2" ? "v2" : "")
      .replaceAll("{{ERROR_MESSAGE}}", escapeAttr(error?.message ?? ""))
      .replaceAll("{{INSTALL_HINT}}", error?.showInstallHint ? "1" : "")
      // Which host this page is for (Stage B splits the app on it).
      .replaceAll("{{HOST_KIND}}", this._kind)
      // The pinned session of a "session" host — the tab-signal poster
      // gates on it (only the tab's own page reports its facts).
      .replaceAll("{{SESSION_ID}}", this._sessionId ?? "")
      // The boot route: a session panel opens straight into its session;
      // the navigator starts home.
      .replaceAll(
        "{{ROUTE}}",
        escapeAttr(
          this._sessionId !== undefined
            ? JSON.stringify({ view: "session", id: this._sessionId })
            : JSON.stringify({ view: "home" }),
        ),
      )
      .replaceAll(
        "{{TABS}}",
        escapeAttr(JSON.stringify(this._tabsStore.get())),
      )
      .replaceAll(
        "{{TOMBSTONES}}",
        escapeAttr(JSON.stringify(this._projectStore.list())),
      )
      .replaceAll(
        "{{HIDDEN_MODELS}}",
        escapeAttr(JSON.stringify(this._hiddenModels.get())),
      )
      .replaceAll(
        "{{HIDDEN_PROVIDERS}}",
        escapeAttr(JSON.stringify(this._hiddenProviders.get())),
      )
      .replaceAll(
        "{{COPY_MODIFIER}}",
        escapeAttr(this._copyModifier()),
      )
      .replaceAll(
        "{{READY_SOUND}}",
        this._readySound() ? "1" : "",
      )
      .replaceAll(
        "{{PERMISSION_SOUND}}",
        this._permissionSound() ? "1" : "",
      )
      .replaceAll(
        "{{QUESTION_SOUND}}",
        this._questionSound() ? "1" : "",
      )
      .replaceAll(
        "{{STUCK_TOOL}}",
        String(this._stuckTool()),
      )
      .replaceAll(
        "{{STUCK_AUTO_ABORT}}",
        String(this._stuckAutoAbort()),
      )
      // The window's folder (workspaceFolders[0]) — the identity Home marks
      // as "this window"; /project/current can't say it for non-git folders.
      .replaceAll(
        "{{WORKSPACE}}",
        escapeAttr(
          vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "",
        ),
      );
  }

  private _copyModifier(): string {
    return vscode.workspace
      .getConfiguration("opencodeGui")
      .get<string>("codeCopyModifier", "alt");
  }

  private _readySound(): boolean {
    return vscode.workspace
      .getConfiguration("opencodeGui")
      .get<boolean>("readySound", true);
  }

  private _permissionSound(): boolean {
    return vscode.workspace
      .getConfiguration("opencodeGui")
      .get<boolean>("permissionSound", true);
  }

  private _questionSound(): boolean {
    return vscode.workspace
      .getConfiguration("opencodeGui")
      .get<boolean>("questionSound", true);
  }

  private _stuckTool(): number {
    return vscode.workspace
      .getConfiguration("opencodeGui")
      .get<number>("stuckToolSeconds", 300);
  }

  private _stuckAutoAbort(): number {
    return vscode.workspace
      .getConfiguration("opencodeGui")
      .get<number>("stuckAutoAbortSeconds", 0);
  }

  private _readTemplate(name: string): string {
    // Bundled (scripts/build-extension.js) the host sits at out/ and the
    // templates at out/webview/templates/; the plain tsc intermediate sits
    // in out/webview/ right next to them. Resolve whichever layout loaded.
    const dir = fs.existsSync(path.join(__dirname, "webview", "templates"))
      ? path.join(__dirname, "webview", "templates")
      : path.join(__dirname, "templates");
    return fs.readFileSync(path.join(dir, name), "utf-8");
  }
}

// Meta content is a double-quoted attribute; escape so host-authored markup
// (e.g. "<code>opencode</code>") survives the round-trip as text for the app
// to render as HTML.
function escapeAttr(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll('"', "&quot;");
}

// A chat file target: "file://…" uris (attachment chips) decode to their
// platform path, anything else resolves against the first workspace folder.
function absPathOf(p: string): string {
  if (p.startsWith("file:")) return vscode.Uri.parse(p).fsPath;
  const ws = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
  return path.isAbsolute(p) || !ws ? p : path.join(ws, p);
}

// Same rule as sniffsText in the webview (src/webview/app/api.ts) — the
// host and webview share no module, so the helper is duplicated across the
// seam. True iff the prefix holds no NUL byte and decodes as UTF-8.
function sniffsText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes, {
      stream: true,
    });
    return true;
  } catch {
    return false;
  }
}

// The webview can't read file:// picks, so the host stamps textiness from
// the file's first 8 KB for the attachment gate to prefer after name/type.
async function sniffedText(uri: vscode.Uri): Promise<boolean> {
  const handle = await fs.promises.open(uri.fsPath, "r");
  try {
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return sniffsText(buf.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}
