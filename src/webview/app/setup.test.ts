// Node-side test rig for the webview app. Installs the browser globals the
// app modules touch at import time (document metas, window message bus and
// timer registry, localStorage, navigator, a fake AudioContext so the ready
// chime is observable through its localStorage throttle key), captures the
// host bridge, and exposes drivers for the store's timer/event machinery.
// This file MUST execute before any app module — unit-tests.ts imports it
// first, and every test file re-imports it (cached) before app modules.
import { captureApi } from "./host";
import { openTabs, route, unreadTabs } from "./router";

type MessageListener = (e: { data: unknown }) => void;
const messageListeners = new Set<MessageListener>();

// Meta tags AppHost would have baked into chat.html. Read at module import
// by bootStatus/sound/stuck, so the interesting ones are set up front.
export const metas = new Map<string, string>();
metas.set("opencode-origin", "http://test.local");
metas.set("opencode-ready-sound", "1");
metas.set("opencode-stuck-tool", "1");

export class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null;
  }
  get length(): number {
    return this.store.size;
  }
}
export const localStorageStub = new MemoryStorage();

// Window timers are recorded, never scheduled: tests fire them by exact
// delay (33ms event drain, 1500ms ring, 3000ms idle), so nothing fires
// between tests or keeps the mocha process alive.
interface Timer {
  fn: (...args: unknown[]) => void;
  delay: number;
}
const timers = new Map<number, Timer>();
let timerSeq = 0;
let intervalFn: (() => void) | undefined;

const documentStub = {
  querySelector(sel: string): { getAttribute: (n: string) => string } | null {
    const m = /^meta\[name="([^"]+)"\]$/.exec(sel);
    if (!m) return null;
    const content = metas.get(m[1]);
    return content === undefined ? null : { getAttribute: () => content };
  },
  addEventListener() {},
  removeEventListener() {},
};

class FakeGainNode {
  gain = { value: 1 };
  connect(node: unknown) {
    return node;
  }
}
class FakeAudioContext {
  state = "running";
  destination = {};
  decodeAudioData() {
    return Promise.resolve({
      duration: 0.05,
      sampleRate: 8000,
      numberOfChannels: 1,
      getChannelData: () => new Float32Array(400),
    });
  }
  createBufferSource() {
    return { connect: (node: unknown) => node, start: () => {} };
  }
  createGain() {
    return new FakeGainNode();
  }
  createBuffer() {
    return {};
  }
}

const windowStub = {
  document: documentStub,
  addEventListener(type: string, fn: MessageListener) {
    if (type === "message") messageListeners.add(fn);
  },
  removeEventListener(type: string, fn: MessageListener) {
    if (type === "message") messageListeners.delete(fn);
  },
  setTimeout(fn: (...args: unknown[]) => void, delay = 0) {
    const id = ++timerSeq;
    timers.set(id, { fn, delay });
    return id;
  },
  clearTimeout(id: number) {
    timers.delete(id);
  },
  setInterval(fn: () => void) {
    intervalFn = fn;
    return 0;
  },
};

// Node >=21 defines some of these as getter-only globals, so install
// everything through defineProperty.
function installGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
}
installGlobal("window", windowStub as unknown as Window & typeof globalThis);
installGlobal("document", documentStub as unknown as Document);
installGlobal("localStorage", localStorageStub as unknown as Storage);
installGlobal("navigator", { platform: "Win32" } as unknown as Navigator);
installGlobal(
  "AudioContext",
  FakeAudioContext as unknown as typeof AudioContext,
);

// store.ts cancels window timers through the BARE clearTimeout (same
// function in a browser), so it must see the stub's registry too.
const realClearTimeout = globalThis.clearTimeout;
installGlobal(
  "clearTimeout",
  ((id: unknown, ...args: unknown[]) => {
    if (typeof id === "number" && timers.has(id)) {
      timers.delete(id);
      return;
    }
    realClearTimeout(id as Parameters<typeof realClearTimeout>[0], ...(args as []));
  }) as typeof clearTimeout,
);

// --- Fake extension host: answer api-requests from a responder stack ---

export interface ApiCall {
  method: string;
  path: string;
  body?: unknown;
}
export const apiLog: ApiCall[] = [];
export const hostPosted: unknown[] = [];
export const API_FAIL = Symbol("api-fail");
// A failed reply carrying the relay's failure reason (HTTP status + server
// message), mirroring what AppHost posts for a real failed fetch.
export interface ApiFailWith {
  fail: true;
  error: string;
}
export function apiFailWith(error: string): ApiFailWith {
  return { fail: true, error };
}
type Responder = (call: ApiCall) => unknown;
let responders: Responder[] = [];

function defaultResponder({ method, path }: ApiCall): unknown {
  const p = path.split("?")[0];
  if (method === "GET") {
    if (p === "/session/status") return {};
    if (p === "/api/session") return { data: [], cursor: {} };
    if (p === "/provider") return { all: [], default: {}, connected: [] };
    if (p === "/agent") return [];
    if (p === "/command") return [];
    if (p === "/project") return [];
    if (p === "/project/current") return { id: "global" };
    if (p === "/config") return {};
    if (/^\/api\/session\/[^/]+\/message$/.test(p))
      return { data: [], cursor: {} };
    if (/^\/session\/[^/]+\/message$/.test(p)) return [];
  }
  return {};
}

captureApi({
  postMessage(message: unknown): void {
    const m = message as ApiCall & { type: string; id: number };
    if (m && m.type === "api-request") {
      const call = { method: m.method, path: m.path, body: m.body };
      apiLog.push(call);
      let result: unknown;
      try {
        for (const r of [...responders].reverse()) {
          const hit = r(call);
          if (hit !== undefined) {
            result = hit;
            break;
          }
        }
        if (result === undefined) result = defaultResponder(call);
      } catch (err) {
        console.error("[test] responder threw:", err);
        result = API_FAIL;
      }
      const failed =
        result === API_FAIL ||
        (!!result && typeof result === "object" && "fail" in result);
      const error = failed && result !== API_FAIL ? (result as ApiFailWith).error : undefined;
      void Promise.resolve().then(() =>
        dispatchWindowMessage({
          type: "api-result",
          id: m.id,
          ok: !failed,
          json: failed ? undefined : result,
          ...(error ? { error } : {}),
        }),
      );
      return;
    }
    hostPosted.push(message);
  },
});

// Register a responder; the most recent registration wins. Return the json
// body, or API_FAIL to make the call fail.
export function onApi(fn: Responder): void {
  responders.push(fn);
}

// --- Drivers ---

export function dispatchWindowMessage(data: unknown): void {
  for (const fn of [...messageListeners]) fn({ data });
}

// Fire every pending window timeout with exactly this delay. Returns how
// many fired.
export function fireExact(delay: number): number {
  let fired = 0;
  for (const [id, t] of [...timers]) {
    if (t.delay === delay) {
      timers.delete(id);
      fired++;
      t.fn();
    }
  }
  return fired;
}

export function fireTimeouts(maxDelay: number): number {
  let fired = 0;
  for (const [id, t] of [...timers]) {
    if (t.delay <= maxDelay) {
      timers.delete(id);
      fired++;
      t.fn();
    }
  }
  return fired;
}

export function pendingTimers(): number {
  return timers.size;
}

// stuck.ts registers its 1s tick through window.setInterval at import;
// tests drive it manually with a mocked clock.
export function runStuckTick(): void {
  intervalFn?.();
}

export async function settle(turns = 3): Promise<void> {
  for (let i = 0; i < turns; i++)
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

// Drain one batch of queued SSE frames (the 33ms timer) and let the
// resulting promise/effect chains run.
export async function flushEvents(): Promise<void> {
  fireExact(33);
  await settle(2);
}

const realNow = Date.now;
export function setNow(t: number): void {
  Date.now = () => t;
}

export function callsFor(path: string): ApiCall[] {
  return apiLog.filter((c) => c.path.split("?")[0] === path);
}

export function bellRang(): boolean {
  return localStorageStub.getItem("opencode.bellAt.ready") !== null;
}

afterEach(() => {
  timers.clear();
  responders = [];
  apiLog.length = 0;
  hostPosted.length = 0;
  Date.now = realNow;
  for (const k of [
    "opencode.bellAt.ready",
    "opencode.bellAt.permission",
    "opencode.bellAt.question",
  ])
    localStorageStub.removeItem(k);
  route.value = { view: "home" };
  openTabs.value = [];
  unreadTabs.value = new Set();
});
