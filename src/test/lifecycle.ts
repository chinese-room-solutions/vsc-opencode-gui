import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as net from "net";
import * as vscode from "vscode";
import * as assert from "assert";

// Runs inside the extension host via @vscode/test-electron (see
// test/runTest.js). Lifecycle only — UI behavior is verified against the
// ui-rig with Playwright instead (AGENTS.md).

const portFile = path.join(os.tmpdir(), "oc-test-server-port");

// ChatHub's state: { kind: "loading" | "error" | "url", ... }.
type HubState = { kind: string; url?: string; message?: string };
type Api = {
  hub: { state: HubState; setLoading: () => void };
  serverPort: number | undefined;
  ensureServer: () => void;
};

async function waitForUrl(api: Api, timeoutMs = 90_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = api.hub.state;
    if (s.kind === "url" && s.url) return s.url;
    if (s.kind === "error") throw new Error(`server errored: ${s.message}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("timed out waiting for server url");
}

// Fail the run on any uncaught exception in the host: a crashing proxy or
// server path must surface here, not as an invisible console line.
const uncaught: string[] = [];
process.on("uncaughtException", (e) => uncaught.push(String(e)));
process.on("unhandledRejection", (e) => uncaught.push(String(e)));

// The hub records the server url before the listener is answering, so a
// fetch fired right after boot can lose the race (ECONNRESET/ECONNREFUSED).
// Retry transport errors until the deadline; a real response — any status —
// comes back as-is for the caller to judge.
async function fetchOk(url: string, timeoutMs = 10_000): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await fetch(url, { signal: AbortSignal.timeout(1000) });
    } catch (e) {
      if (Date.now() >= deadline) throw e;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

suite("opencode GUI lifecycle", function () {
  let api: Api;

  suiteSetup(async function () {
    const ext = vscode.extensions.getExtension("chinese-room-solutions.vsc-opencode-gui")!;
    api = (await ext.activate()) as Api;
  });

  test("openChat boots the server and serves the app", async function () {
    await vscode.commands.executeCommand("opencodeGui.openChat");
    const url = await waitForUrl(api);
    const res = await fetchOk(url);
    assert.strictEqual(res.status, 200);
    assert.ok((await res.text()).includes("<"), "app html served");
  });

  test("restart disposes the old server and reuses the port", async function () {
    const before = await waitForUrl(api);
    const port = new URL(before).port;
    // Record the server port for the runner's orphan check.
    fs.writeFileSync(portFile, String(api.serverPort ?? port));
    await vscode.commands.executeCommand("opencodeGui.restart");
    const after = await waitForUrl(api);
    assert.strictEqual(new URL(after).port, port, "stored port reused");
    assert.strictEqual((await fetchOk(after)).status, 200);
  });

  test("boots on a fresh port when the stored one is squatted", async function () {
    // Squat the stored port with a listener that answers nothing: the
    // health probe fails, the port still binds, and opencode serve exits 1
    // with "ServeError". The boot must retry once on a random port instead
    // of failing every reload the same way.
    const main = await import("../main");
    const squatted = new URL(await waitForUrl(api)).port;
    await main.deactivate();
    const squatter = net.createServer().listen(Number(squatted), "127.0.0.1");
    await new Promise((r) => setTimeout(r, 300));
    try {
      // The hub still reports the dead server's url; reset it so the wait
      // below sees the NEW boot, not the stale one.
      api.hub.setLoading();
      api.ensureServer();
      const next = await waitForUrl(api, 30_000);
      const fresh = new URL(next).port;
      assert.notStrictEqual(fresh, squatted, "retry left the squatted port");
      assert.strictEqual((await fetchOk(next)).status, 200);
      fs.writeFileSync(portFile, String(api.serverPort ?? fresh));
    } finally {
      squatter.close();
    }
  });

  test("manageModels boots the server and reaches the picker", async function () {
    // The command runs ensureServer -> providerCatalog -> showQuickPick and
    // stays pending while the picker waits for selection. Nothing dismisses
    // it in this window, so "still pending after the server booted" proves
    // the whole chain up to the picker resolved (catalog fetch included).
    let settled = false;
    const picker = vscode.commands
      .executeCommand("opencodeGui.manageModels")
      .then(() => (settled = true), () => (settled = true));
    await waitForUrl(api);
    await new Promise((r) => setTimeout(r, 5000));
    assert.strictEqual(settled, false, "picker open (command awaiting selection)");
    // The next test tears the server down; leave the picker pending — the
    // window closes right after and abandons it.
    void picker;
  });

  test("deactivate tears the server down", async function () {
    const main = await import("../main");
    await main.deactivate();
    const url = await waitForUrl(api);
    const deadline = Date.now() + 15_000;
    let dead = false;
    while (Date.now() < deadline) {
      try {
        await fetch(url, { signal: AbortSignal.timeout(1000) });
      } catch {
        dead = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(dead, "server port closed after deactivate");
  });

  test("isUnresponsive catches a page that never pinged, then a ping revives it", async function () {
    // The grey-tab watchdog (activate) rebuilds panels on this signal, so
    // its logic matters beyond Restart: a page that booted pings within
    // 15 s; one that never loaded (blank tab) has silence-since-attach as
    // its only symptom. Ages the private stamps directly — 60 s of real
    // waiting would dwarf the suite.
    const { AppHost } = await import("../webview/AppHost");
    // The real extensionUri: attach() renders the shell from its template.
    const extUri = vscode.extensions.getExtension(
      "chinese-room-solutions.vsc-opencode-gui",
    )!.extensionUri;
    const noopStore = { get: () => undefined, set: () => {} };
    const host = new AppHost({
      extensionUri: extUri,
      kind: "session",
      sessionId: "ses-host-probe",
      routeStore: noopStore as never,
      tabsStore: { get: () => [] } as never,
      projectStore: {
        list: () => [],
        tombstoned: () => false,
        tombstone: () => {},
      } as never,
      openProject: () => Promise.resolve(),
      hiddenModels: { get: () => [] },
      hiddenProviders: { get: () => [] },
    });
    let onMessage: ((m: unknown) => void) | undefined;
    const webview = {
      options: undefined,
      onDidReceiveMessage: (cb: (m: unknown) => void) => {
        onMessage = cb;
        return { dispose: () => {} };
      },
      postMessage: () => Promise.resolve(true),
      asWebviewUri: (u: vscode.Uri) => u,
      cspSource: "https://test",
    };
    host.attach(webview as never);
    const stamps = host as unknown as {
      _attachedAt?: number;
      _lastPingAt?: number;
    };
    assert.strictEqual(host.isUnresponsive, false, "boot grace holds");
    stamps._attachedAt = Date.now() - 120_000;
    assert.strictEqual(
      host.isUnresponsive,
      true,
      "never-pinged page reads dead past the grace",
    );
    onMessage?.({ type: "ping" });
    assert.strictEqual(host.isUnresponsive, false, "a ping revives it");
    stamps._lastPingAt = Date.now() - 120_000;
    assert.strictEqual(
      host.isUnresponsive,
      true,
      "pings gone quiet reads dead",
    );
    host.dispose();
  });

  test("read-attachment answers only inside the attachments root", async function () {
    // The sent-chip thumbnail relay, driven like the ping above: a real
    // AppHost behind a stub webview that records its posts. The workspace
    // is the runner's throwaway folder, so the probe file is hermetic.
    const { AppHost } = await import("../webview/AppHost");
    const extUri = vscode.extensions.getExtension(
      "chinese-room-solutions.vsc-opencode-gui",
    )!.extensionUri;
    const noopStore = { get: () => undefined, set: () => {} };
    const host = new AppHost({
      extensionUri: extUri,
      kind: "session",
      sessionId: "ses-host-probe",
      routeStore: noopStore as never,
      tabsStore: { get: () => [] } as never,
      projectStore: {
        list: () => [],
        tombstoned: () => false,
        tombstone: () => {},
      } as never,
      openProject: () => Promise.resolve(),
      hiddenModels: { get: () => [] },
      hiddenProviders: { get: () => [] },
    });
    const posted: { type?: string; path?: string; url?: string }[] = [];
    let onMessage: ((m: unknown) => void) | undefined;
    const webview = {
      options: undefined,
      onDidReceiveMessage: (cb: (m: unknown) => void) => {
        onMessage = cb;
        return { dispose: () => {} };
      },
      postMessage: (m: unknown) => {
        posted.push(m as never);
        return Promise.resolve(true);
      },
      asWebviewUri: (u: vscode.Uri) =>
        vscode.Uri.parse(`https://webview.test/preview/${path.basename(u.fsPath)}`),
      cspSource: "https://test",
    };
    host.attach(webview as never);
    const ws = vscode.workspace.workspaceFolders?.[0];
    assert.ok(ws, "lifecycle window opened a workspace folder");
    const dir = vscode.Uri.joinPath(ws.uri, ".opencode", "attachments");
    const probe = vscode.Uri.joinPath(dir, "lifecycle-probe.png");
    await vscode.workspace.fs.createDirectory(dir);
    await vscode.workspace.fs.writeFile(probe, new Uint8Array([1]));
    try {
      onMessage?.({ type: "read-attachment", path: probe.toString(true) });
      await new Promise((r) => setTimeout(r, 500));
      assert.deepStrictEqual(
        posted.filter((m) => m.type === "attachment-preview"),
        [
          {
            type: "attachment-preview",
            path: probe.toString(true),
            url: "https://webview.test/preview/lifecycle-probe.png",
          },
        ],
      );
      // An existing file outside the attachments root (.git/config from
      // the runner's git init) gets no reply at all.
      posted.length = 0;
      const foreign = vscode.Uri.joinPath(ws.uri, ".git", "config");
      onMessage?.({ type: "read-attachment", path: foreign.toString(true) });
      await new Promise((r) => setTimeout(r, 500));
      assert.deepStrictEqual(posted, []);
    } finally {
      try {
        await vscode.workspace.fs.delete(probe);
      } catch {}
      host.dispose();
    }
  });

  test("one chime claim wins per window (bell arbitration)", async function () {
    // Every chat page (sidebar + one tab per session) rings the same
    // event, and webview origins don't cross — the hub arbitrates the
    // claims so the window hears one chime, not one per panel.
    const { AppHost } = await import("../webview/AppHost");
    const { ChatHub } = await import("../webview/ChatHub");
    const extUri = vscode.extensions.getExtension(
      "chinese-room-solutions.vsc-opencode-gui",
    )!.extensionUri;
    const hub = new ChatHub();
    const noopStore = { get: () => undefined, set: () => {} };
    const mk = (n: number) => {
      const posted: { type?: string; kind?: string }[] = [];
      let onMessage: ((m: unknown) => void) | undefined;
      const host = new AppHost({
        extensionUri: extUri,
        kind: "session",
        sessionId: `ses-bell-${n}`,
        routeStore: noopStore as never,
        tabsStore: { get: () => [] } as never,
        projectStore: {
          list: () => [],
          tombstoned: () => false,
          tombstone: () => {},
        } as never,
        openProject: () => Promise.resolve(),
        hiddenModels: { get: () => [] },
        hiddenProviders: { get: () => [] },
        claimBell: (kind) => hub.claimBell(kind),
      });
      host.attach({
        options: undefined,
        onDidReceiveMessage: (cb: (m: unknown) => void) => {
          onMessage = cb;
          return { dispose: () => {} };
        },
        postMessage: (m: unknown) => {
          posted.push(m as never);
          return Promise.resolve(true);
        },
        asWebviewUri: (u: vscode.Uri) => u,
        cspSource: "https://test",
      } as never);
      return {
        claim: (kind: string) => onMessage?.({ type: "bell-claim", kind }),
        get grants() {
          return posted.filter((m) => m.type === "bell-grant");
        },
        host,
      };
    };
    const a = mk(1);
    const b = mk(2);
    try {
      a.claim("ready");
      b.claim("ready"); // inside the same window: denied
      assert.strictEqual(a.grants.length, 1, "first claim granted");
      assert.strictEqual(b.grants.length, 0, "second claim denied in the window");
      b.claim("permission"); // a different sound owns its own window
      assert.strictEqual(b.grants.length, 1, "other sound's window is separate");
      assert.strictEqual(b.grants[0]?.kind, "permission", "grant carries the kind");
      // The window frees after the interval (BELL_WINDOW_MS = 1.5 s).
      await new Promise((r) => setTimeout(r, 1600));
      b.claim("ready");
      assert.strictEqual(b.grants.length, 2, "window reopened after the interval");
      assert.strictEqual(b.grants[1]?.kind, "ready");
    } finally {
      a.host.dispose();
      b.host.dispose();
      hub.dispose();
    }
  });

  suiteTeardown(function () {
    assert.deepStrictEqual(
      uncaught,
      [],
      `uncaught exceptions in extension host: ${uncaught.join(" | ")}`,
    );
  });
});
