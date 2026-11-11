import * as vscode from "vscode";
import { serverAuthHeaders } from "../server/serverAuth";
import type { Dialect } from "../server/dialect";
import { AppHost, type BellKind, type ServerEvent, type SseState } from "./AppHost";
import type { PeerInfo } from "./Peers";
import { log } from "../log";

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string; showInstallHint: boolean }
  | { kind: "url"; url: string; dialect: Dialect };

// Cap of the event-stream reconnect backoff (1s * 2^attempt).
const MAX_BACKOFF_MS = 15_000;
// The server heartbeats both streams every 10 s, quiet turns included. A
// stream silent for this long is dead-but-open (standby, network switch) —
// `read()` would pend forever without this, wedging the app mid-turn.
const NO_FRAME_MS = 30_000;
// One granted chime per sound inside this window (see claimBell).
const BELL_WINDOW_MS = 1_500;

// Owns the last loading/error/url state and the server event-stream pumps,
// fanning both out to every chat webview (sidebar + one editor tab per
// session) and replaying them to late-attaching ones. One pump set per
// server, not per host: v1 (1.18) servers drop competing /api/event
// subscribers, and N panels must not mean N connections.
export class ChatHub implements vscode.Disposable {
  private _state: State = { kind: "loading" };
  private _peers: PeerInfo[] = [];
  private readonly _chats = new Set<AppHost>();
  // Chats whose webview attached (the sidebar registers at activation but
  // attaches only on resolve). Pumps run only while someone listens — a
  // never-resolved view holds no streams.
  private readonly _attached = new Set<AppHost>();
  // SSE pumps to the server: (re)started with a server url, aborted when
  // it changes or the hub errors/disposes. Two streams — /api/event (v2:
  // asks, model switches, v2-turn steps) and /event (v1: the turn dialect
  // v1-prompted sessions stream over, compaction included).
  private _pumps: AbortController[] = [];
  private _pumpTimers: NodeJS.Timeout[] = [];
  // Latest stream connection state; replayed to freshly attached chats.
  private _sseState: SseState | undefined;

  // Current loading/error/url state (test surface).
  get state(): State {
    return this._state;
  }

  // The chime arbiter: every chat page (sidebar + one tab per session)
  // runs the full store and rings the same event, and their webview
  // origins differ, so the claim lands here — the first claim inside
  // the window is granted the ring: one chime per window per sound.
  // Mirrors THROTTLE_MS in the app's sound.ts.
  private readonly _bellAt = new Map<BellKind, number>();

  claimBell(kind: BellKind): boolean {
    const now = Date.now();
    if (now - (this._bellAt.get(kind) ?? 0) < BELL_WINDOW_MS) return false;
    this._bellAt.set(kind, now);
    return true;
  }

  register(chat: AppHost) {
    this._chats.add(chat);
    this._push(chat, this._state);
    chat.setPeers(this._peers);
  }

  unregister(chat: AppHost) {
    this._chats.delete(chat);
    this._attached.delete(chat);
    this._maybeStopPumps();
  }

  // The chat's webview attached (its page is loading). Starts the pumps
  // once a url exists, and replays the current stream state so a page
  // attaching mid-stream sees the connection it missed.
  noteAttached(chat: AppHost) {
    this._attached.add(chat);
    this._maybeStartPumps();
    if (this._sseState !== undefined) chat.receiveSseState(this._sseState);
  }

  // The url arrives with the dialect ServerManager probed (one probe, not
  // one per host) — both fan out to every chat.
  setServerUrl(url: string, dialect: Dialect) {
    this._state = { kind: "url", url, dialect };
    this._broadcast();
    this._maybeStartPumps();
  }

  setError(message: string, showInstallHint = true) {
    this._state = { kind: "error", message, showInstallHint };
    this._stopPump();
    this._broadcast();
  }

  setLoading() {
    this._state = { kind: "loading" };
    this._stopPump();
    this._broadcast();
  }

  // Re-serve every chat's shell with fresh baked state (theme change).
  rerender() {
    for (const chat of this._chats) this._safe(chat, (c) => c.rerender());
  }

  // The codeCopyModifier setting changed (main.ts watches it).
  setCopyModifier(modifier: string) {
    for (const chat of this._chats)
      this._safe(chat, (c) => c.setCopyModifier(modifier));
  }

  // The readySound setting changed (main.ts watches it).
  setReadySound(enabled: boolean) {
    for (const chat of this._chats)
      this._safe(chat, (c) => c.setReadySound(enabled));
  }

  // The permissionSound setting changed (main.ts watches it).
  setPermissionSound(enabled: boolean) {
    for (const chat of this._chats)
      this._safe(chat, (c) => c.setPermissionSound(enabled));
  }

  // The questionSound setting changed (main.ts watches it).
  setQuestionSound(enabled: boolean) {
    for (const chat of this._chats)
      this._safe(chat, (c) => c.setQuestionSound(enabled));
  }

  // The peer registry (PeerRegistry) changed — peer cards re-name.
  setPeers(peers: PeerInfo[]) {
    this._peers = peers;
    for (const chat of this._chats) this._safe(chat, (c) => c.setPeers(peers));
  }

  // Server truth changed outside the stream (the provider disable
  // toggle): pull it in every live chat.
  noteVisible() {
    for (const chat of this._chats) this._safe(chat, (c) => c.noteVisible());
  }

  dispose() {
    this._stopPump();
    this._chats.clear();
    this._attached.clear();
  }

  private _broadcast() {
    for (const chat of this._chats)
      this._safe(chat, (c) => this._push(c, this._state));
  }

  // One dead page must not abort a fan-out mid-loop: a webview disposed
  // without its onDidDispose having run yet throws on every push (the
  // html assignment), and the surviving pages still need the state.
  private _safe(chat: AppHost, fn: (chat: AppHost) => void) {
    try {
      fn(chat);
    } catch (err) {
      log.error("chat fan-out failed:", err);
    }
  }

  private _push(chat: AppHost, state: State) {
    switch (state.kind) {
      case "url":
        chat.setServerUrl(state.url, state.dialect);
        break;
      case "error":
        chat.setError(state.message, state.showInstallHint);
        break;
      case "loading":
        chat.setLoading();
        break;
    }
  }

  // (Re)start the event-stream pumps. The apps subscribe by listening for
  // the forwarded messages, so the pumps run regardless of app state — a
  // late message to a reloading webview is harmless. They run while a url
  // is known AND some chat is attached (see noteAttached). A v2 server
  // never frames /event (and 1.18 servers drop /api/event subscribers
  // when one connects), so only /api/event is pumped there.
  private _maybeStartPumps(): void {
    if (this._pumps.length > 0) return;
    if (this._state.kind !== "url" || this._attached.size === 0) return;
    const base = this._state.url;
    const v2 = new AbortController();
    this._pumps = [v2];
    void this._pumpEvents(base, v2, "/api/event");
    if (this._state.dialect !== "v2") {
      const v1 = new AbortController();
      this._pumps.push(v1);
      void this._pumpEvents(base, v1, "/event");
    }
  }

  private _maybeStopPumps(): void {
    if (this._attached.size > 0) return;
    this._stopPump();
  }

  private _stopPump(): void {
    for (const p of this._pumps) p.abort();
    this._pumps = [];
    for (const t of this._pumpTimers) clearTimeout(t);
    this._pumpTimers = [];
    this._sseState = undefined;
  }

  // SSE against GET {path}: bare `data:` lines carrying a flat event
  // envelope, no server keepalives. The v2 dialect addresses `data`; the v1
  // one (`/event`) `properties` — normalized here so the app sees one shape.
  // The server drops the stream on shutdown, so we own the reconnect loop
  // with a capped backoff. Both pumps report connection state — either can
  // drop alone, and the app resyncs on every reconnect.
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
          headers: serverAuthHeaders(),
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

  // Forward one `data:` frame to every chat; malformed JSON is skipped, as
  // before. The v2 dialect stamps a top-level `created` (ms) on its frames
  // — folded into `data.timestamp` so the app's step/idle stamps use wire
  // time.
  private _pumpFrame(pump: AbortController, line: string): void {
    if (!line.startsWith("data:")) return;
    try {
      const raw = JSON.parse(line.slice(5).trim()) as ServerEvent & {
        properties?: unknown;
        created?: number;
      };
      if (!this._pumps.includes(pump)) return;
      const body = raw.data ?? raw.properties;
      const event: ServerEvent = {
        id: raw.id,
        type: raw.type,
        data:
          typeof body === "object" && body !== null && raw.created !== undefined
            ? { timestamp: raw.created, ...body }
            : body,
      };
      for (const chat of this._chats) chat.receiveSseEvent(event);
    } catch {
      // Malformed frame — nothing to dispatch.
    }
  }

  private _pumpState(pump: AbortController, state: SseState): void {
    if (!this._pumps.includes(pump)) return;
    this._sseState = state;
    for (const chat of this._chats) chat.receiveSseState(state);
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
}
