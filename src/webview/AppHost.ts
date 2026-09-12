import * as vscode from "vscode";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { themeStyle } from "../theme";
import { tokenizeToTokens } from "../tokenizer";
import { savePromptAttachments } from "../attachments";
import { log } from "../log";

// The last app route (workspaceState-backed; per-folder, so no cross-folder
// validation is needed). Baked into the page so a reload restores it.
export interface RouteStore {
  get(): string | undefined;
  set(value: string): void;
}

// Open session tabs, in bar order (workspaceState-backed in main.ts,
// beside the route). Persisted so a restart restores the whole set; baked
// into the page on every render for boot restore.
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

// Cap of the event-stream reconnect backoff (1s * 2^attempt).
const MAX_BACKOFF_MS = 15_000;
// The server heartbeats both streams every 10 s, quiet turns included. A
// stream silent for this long is dead-but-open (standby, network switch) —
// `read()` would pend forever without this, wedging the app mid-turn.
const NO_FRAME_MS = 30_000;
// The app pings every 15 s. Silence past three cadences means the renderer
// process is dead (VS Code's grey placeholder) — Restart rebuilds the chat
// tab on this signal.
const PING_TIMEOUT_MS = 45_000;

// ServerEvent, as fed to the app through the pump (mirrors
// src/webview/app/events.ts across the postMessage seam).
interface ServerEvent {
  id: string;
  type: string;
  data: unknown;
}

type SseState = "connecting" | "connected" | "offline";

// Host-side half of the chat webview: renders the app shell (chat.html +
// out/webview/app.js), shows server status, and relays the app's traffic to
// the server — the webview origin is opaque, so the server's CORS would
// block every direct call; the app posts api-requests here and receives the
// SSE stream pumped from here. State is fanned out from ChatHub; every
// change re-renders the shell because CSP and the app's boot state are
// baked into the HTML — a host postMessage can race the first load.
export class AppHost implements vscode.Disposable {
  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _routeStore: RouteStore,
    private readonly _tabsStore: TabsStore,
    private readonly _projectStore: ProjectStore,
    private readonly _openProject: OpenProjectHandler,
    private readonly _hiddenModels: HiddenModels,
  ) {}

  private _webview?: vscode.Webview;
  // Route → consecutive failed relays; collapses restart-time bursts to
  // one line per route (see _relayApi).
  private _relayFailures = new Map<string, number>();
  private _serverUrl?: string;
  private _error?: { message: string; showInstallHint: boolean };
  private _attachments: vscode.Disposable[] = [];
  // SSE pumps to the server: (re)started with a server url, aborted when it
  // changes or the host errors/disposes. Two streams — /api/event (v2:
  // asks, model switches, v2-turn steps) and /event (v1: the turn dialect
  // v1-prompted sessions stream over, compaction included).
  private _pumps: AbortController[] = [];
  private _pumpTimers: NodeJS.Timeout[] = [];
  // Last heartbeat from the app; undefined until its first ping (a fresh
  // page reaches that within 15 s, so a just-loaded webview never reads
  // as dead).
  private _lastPingAt?: number;

  attach(webview: vscode.Webview) {
    for (const d of this._attachments) d.dispose();
    this._attachments = [];
    this._webview = webview;
    // A fresh page pings within 15 s; a stale timestamp from a previous
    // page must not read as dead in the meantime.
    this._lastPingAt = undefined;

    webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    this._attachments.push(
      webview.onDidReceiveMessage((message) => {
        // API relay: fetch from here (Node fetch, no CORS) and post the
        // parsed reply back. Always answers, on failure too.
        if (message.type === "api-request") {
          void this._relayApi(message);
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
        // Route bookkeeping: store, never re-render (the app owns its view).
        // The tabs ride along — the bar order is part of the same state.
        if (message.type === "route-changed") {
          this._routeStore.set(JSON.stringify(message.route));
          if (Array.isArray(message.tabs)) {
            this._tabsStore.set(
              (message.tabs as unknown[]).filter(
                (t): t is string => typeof t === "string",
              ),
            );
          }
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
        // command — it needs globalState and the window, not this host.
        if (message.type === "manage-models") {
          void vscode.commands.executeCommand("opencodeGui.manageModels");
        }
        // Composer "+": native multi-select dialog; the picks go back as
        // {uri, name} chips the next prompt sends as file parts.
        if (message.type === "attach-file") {
          void (async () => {
            try {
              const uris = await vscode.window.showOpenDialog({
                canSelectMany: true,
                openLabel: "Attach",
              });
              if (!uris?.length) return;
              this._post({
                type: "files-picked",
                files: uris.map((u) => ({
                  uri: u.toString(true),
                  name: path.basename(u.fsPath),
                })),
              });
            } catch (err) {
              log.error("attach dialog failed:", err);
            }
          })();
        }
        // Chat file reference: relative paths resolve against the first
        // workspace folder; open and reveal the (1-based) line range.
        if (message.type === "open-file" && typeof message.path === "string") {
          const open = async () => {
            const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            const abs =
              path.isAbsolute(message.path) || !ws
                ? message.path
                : path.join(ws, message.path);
            const doc = await vscode.workspace.openTextDocument(
              vscode.Uri.file(abs),
            );
            const line = Math.max(0, (parseInt(message.line, 10) || 1) - 1);
            const endLine = message.endLine
              ? Math.max(0, (parseInt(message.endLine, 10) || 1) - 1)
              : line;
            await vscode.window.showTextDocument(doc, {
              selection: new vscode.Range(line, 0, endLine, 0),
            });
          };
          open().catch(async (err) => {
            await vscode.window.showErrorMessage(
              `Could not open ${message.path}: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
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

    // A url stored before any webview attached (registered at activation,
    // resolved later): start the pumps now, not back then — a view that
    // never resolves holds no streams.
    if (this._serverUrl) this._startPump(this._serverUrl);

    this._renderCurrentState();
  }

  setServerUrl(url: string) {
    this._serverUrl = url;
    this._error = undefined;
    if (this._webview) this._startPump(url);
    this._renderCurrentState();
  }

  setError(message: string, showInstallHint = true) {
    this._error = { message, showInstallHint };
    this._serverUrl = undefined;
    this._stopPump();
    this._renderCurrentState();
  }

  setLoading() {
    this._serverUrl = undefined;
    this._error = undefined;
    this._stopPump();
    this._renderCurrentState();
  }

  addToChat(text: string) {
    void this._webview?.postMessage({ type: "insert-text", text });
  }

  // Steer the app's router (e.g. "/session/{id}" from the history picker).
  navigate(path: string) {
    void this._webview?.postMessage({ type: "navigate", path });
  }

  // A fresh session (the app creates it and opens its tab).
  newSession() {
    void this._webview?.postMessage({ type: "new-session" });
  }

  // Live picker-filter update from the Manage Models command (the boot
  // value is baked into the page — a postMessage can race the first load).
  setHiddenModels(refs: string[]) {
    this._post({ type: "hidden-models", ids: refs });
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

  // The webview became visible again. VS Code suspends hidden webviews
  // (retainContextWhenHidden), and events posted while suspended can be
  // dropped — the host stream stays healthy, so no reconnect resync
  // fires. The app pulls truth itself on this cue.
  noteVisible() {
    this._post({ type: "resync" });
  }

  // True when the app's heartbeat has gone quiet — its renderer process is
  // almost certainly dead (a live app pings every 15 s; see main.tsx).
  // Never true before the first ping, so a fresh webview is safe.
  get isUnresponsive(): boolean {
    return (
      this._lastPingAt !== undefined &&
      Date.now() - this._lastPingAt > PING_TIMEOUT_MS
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
    this._stopPump();
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
      this._post({ type: "api-result", id, ok: false });
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
        headers:
          message.body === undefined
            ? undefined
            : { "content-type": "application/json" },
        body:
          message.body === undefined ? undefined : JSON.stringify(message.body),
      });
      const isJson = (res.headers.get("content-type") ?? "").includes(
        "application/json",
      );
      const json = isJson ? await res.json() : undefined;
      this._post({ type: "api-result", id, ok: res.ok, json });
      // A restart makes every in-flight fetch fail at once; log the first
      // failure per route, count the rest, and note the recovery once.
      const key = `${message.method} ${message.path}`;
      const fails = this._relayFailures.get(key);
      if (fails !== undefined) {
        this._relayFailures.delete(key);
        if (fails > 1) log.info(`api relay recovered after ${fails} failed ${key} requests`);
      }
    } catch (err) {
      const key = `${message.method} ${message.path}`;
      const fails = (this._relayFailures.get(key) ?? 0) + 1;
      this._relayFailures.set(key, fails);
      if (fails === 1) log.error("api relay failed:", message.method, message.path, err);
      this._post({ type: "api-result", id, ok: false });
    }
  }

  // (Re)start the event-stream pumps. The app subscribes by listening for
  // the forwarded messages, so the pumps run regardless of app state — a
  // late message to a reloading webview is harmless. They start at first
  // webview attach (a never-resolved view holds no streams; see attach
  // and setServerUrl).
  private _startPump(base: string): void {
    this._stopPump();
    const v2 = new AbortController();
    const v1 = new AbortController();
    this._pumps = [v2, v1];
    void this._pumpEvents(base, v2, "/api/event");
    void this._pumpEvents(base, v1, "/event");
  }

  private _stopPump(): void {
    for (const p of this._pumps) p.abort();
    this._pumps = [];
    for (const t of this._pumpTimers) clearTimeout(t);
    this._pumpTimers = [];
  }

  // SSE against GET {path}: bare `data:` lines carrying a flat event
  // envelope, no server keepalives. The v2 dialect addresses `data`; the v1
  // one (`/event`) `properties` — normalized here so the app sees one shape.
  // The server drops the stream on shutdown, so we own the reconnect loop
  // with a capped backoff. Both pumps report connection state — either can drop
  // alone, and the app resyncs on every reconnect.
  private async _pumpEvents(
    base: string,
    pump: AbortController,
    path: string,
  ): Promise<void> {
    // Per-pump reconnect backoff: survives this pump's reconnects, and one
    // pump's success never resets the other's.
    let attempt = 0;
    while (!pump.signal.aborted) {
      // Owns just this connection: the stall watchdog aborts it on frame
      // silence, sending the loop to the reconnect below; the pump's own
      // signal still wins wholesale.
      const conn = new AbortController();
      let stall: NodeJS.Timeout | undefined;
      const armStall = () => {
        if (stall) clearTimeout(stall);
        stall = setTimeout(() => conn.abort(), NO_FRAME_MS);
      };
      try {
        this._pumpState(pump, "connecting");
        const res = await fetch(`${base}${path}`, {
          signal: AbortSignal.any([pump.signal, conn.signal]),
        });
        if (!res.ok || !res.body) {
          throw new Error(`GET ${path} returned ${res.status}`);
        }
        this._pumpState(pump, "connected");
        attempt = 0;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        armStall();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          armStall();
          buffer += decoder.decode(value, { stream: true });
          let nl = buffer.indexOf("\n");
          while (nl >= 0) {
            this._pumpFrame(pump, buffer.slice(0, nl));
            buffer = buffer.slice(nl + 1);
            nl = buffer.indexOf("\n");
          }
        }
      } catch {
        // Aborted: the pump is being replaced or stopped, or the watchdog
        // killed a silent connection. Anything else is a dropped stream —
        // both fall through to the reconnect below.
      } finally {
        if (stall) clearTimeout(stall);
      }
      if (pump.signal.aborted) return;
      this._pumpState(pump, "offline");
      const delay = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
      attempt += 1;
      await this._pumpBackoff(delay, pump);
    }
  }

  // Forward one `data:` frame; malformed JSON is skipped, as before.
  private _pumpFrame(pump: AbortController, line: string): void {
    if (!line.startsWith("data:")) return;
    try {
      const raw = JSON.parse(line.slice(5).trim()) as ServerEvent & {
        properties?: unknown;
      };
      if (!this._pumps.includes(pump)) return;
      const event: ServerEvent = {
        id: raw.id,
        type: raw.type,
        data: raw.data ?? raw.properties,
      };
      this._post({ type: "sse-event", event });
    } catch {
      // Malformed frame — nothing to dispatch.
    }
  }

  private _pumpState(pump: AbortController, state: SseState): void {
    if (!this._pumps.includes(pump)) return;
    this._post({ type: "sse-state", state });
  }

  // Capped-backoff wait between reconnects; resolving (not hanging) on
  // abort lets _pumpEvents return promptly.
  private _pumpBackoff(ms: number, pump: AbortController): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = () => {
        pump.signal.removeEventListener("abort", onAbort);
        this._pumpTimers = this._pumpTimers.filter((t) => t !== timer);
        resolve();
      };
      const onAbort = () => {
        clearTimeout(timer);
        done();
      };
      const timer = setTimeout(done, ms);
      this._pumpTimers.push(timer);
      pump.signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private _post(message: unknown): void {
    void this._webview?.postMessage(message);
  }

  private _renderCurrentState() {
    const webview = this._webview;
    if (!webview) return;
    webview.html = this._html(webview);
  }

  private _html(webview: vscode.Webview): string {
    const error = this._error;

    const resource = (name: string) =>
      webview
        .asWebviewUri(
          vscode.Uri.joinPath(this._extensionUri, "out", "webview", name),
        )
        .toString();

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
      .replaceAll("{{ERROR_MESSAGE}}", escapeAttr(error?.message ?? ""))
      .replaceAll("{{INSTALL_HINT}}", error?.showInstallHint ? "1" : "")
      .replaceAll(
        "{{ROUTE}}",
        escapeAttr(this._routeStore?.get() ?? ""),
      )
      .replaceAll(
        "{{TABS}}",
        escapeAttr(JSON.stringify(this._tabsStore?.get() ?? [])),
      )
      .replaceAll(
        "{{TOMBSTONES}}",
        escapeAttr(JSON.stringify(this._projectStore?.list() ?? [])),
      )
      .replaceAll(
        "{{HIDDEN_MODELS}}",
        escapeAttr(JSON.stringify(this._hiddenModels.get())),
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
    // __dirname is out/ — the host bundle (scripts/build-extension.js)
    // inlines the compiled sources, while the templates stay asset files
    // under out/webview/templates/.
    const templatePath = path.join(__dirname, "webview", "templates", name);
    return fs.readFileSync(templatePath, "utf-8");
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
