import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as net from "net";
import * as vscode from "vscode";
import * as assert from "assert";
import { sessionTabId } from "../webview/ChatPanel";

// Runs inside the extension host via @vscode/test-electron (see
// test/runTest.js). Lifecycle only — UI behavior is verified against the
// ui-rig with Playwright instead (AGENTS.md).

const portFile = path.join(os.tmpdir(), "oc-test-server-port");

// ChatHub's state: { kind: "loading" | "error" | "url", ... }.
type HubState = { kind: string; url?: string; message?: string };
type SessionPanelLike = {
  chat: { isUnresponsive: boolean };
  icon: unknown;
  reveal(): void;
};
type Api = {
  hub: { state: HubState; setLoading: () => void };
  panels: {
    open(id: string): SessionPanelLike;
    has(id: string): boolean;
    recreate(id: string): SessionPanelLike;
  };
  serverPort: number | undefined;
  ensureServer: () => unknown;
  // The host's own auth headers (its inlined serverAuth instance knows
  // the spawned server's password; the tsc copy tests import does not).
  authHeaders: () => Record<string, string>;
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

  test("ensureServer during a restart defers to the running lifecycle", async function () {
    // Hit ensureServer inside Restart's dispose window (the port sweep
    // takes seconds): the lifecycle gate must defer the extra spawn, and
    // Restart's own replacement must come up on the same port, reachable.
    const before = await waitForUrl(api);
    const port = new URL(before).port;
    const restarting = vscode.commands.executeCommand("opencodeGui.restart");
    api.ensureServer();
    await restarting;
    const after = await waitForUrl(api);
    assert.strictEqual(new URL(after).port, port, "stored port reused");
    assert.strictEqual((await fetchOk(after)).status, 200);
    fs.writeFileSync(portFile, String(api.serverPort ?? port));
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

  test("a real session panel boots its page and takes tab-signal facts", async function () {
    // The full chain: the suite's own server restarted with the real
    // auth store planted into its throwaway data dir (a real model turn
    // needs account creds), a session panel through the extension's own
    // manager (a second SessionPanels in one window can't live: the
    // stray-heal rebuilds foreign session tabs), and the tab icon
    // tracked through a real turn (cleared for tests, opt-in via
    // OC_TEST_REAL_TURN=1). Without the env the turn section skips;
    // without the auth file the whole test skips.
    const realAuth = path.join(
      os.homedir(), ".local", "share", "opencode", "auth.json",
    );
    if (!process.env.XDG_DATA_HOME || !fs.existsSync(realAuth)) this.skip();
    const dataDir = path.join(process.env.XDG_DATA_HOME, "opencode");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.copyFileSync(realAuth, path.join(dataDir, "auth.json"));
    await vscode.commands.executeCommand("opencodeGui.restart");
    const url = await waitForUrl(api, 30_000);
    fs.writeFileSync(portFile, String(api.serverPort ?? new URL(url).port));

    // The real-turn section (OC_TEST_REAL_TURN=1) can pin the model via
    // OC_TEST_MODEL=providerID/modelID — a plan's flash tier keeps the
    // certified turn free; unpinned, the account's default runs.
    const [modelProvider, ...modelRest] = (process.env.OC_TEST_MODEL ?? "").split("/");
    const res = await fetch(`${url}/api/session`, {
      method: "POST",
      headers: { ...api.authHeaders(), "content-type": "application/json" },
      body: JSON.stringify(
        modelProvider && modelRest.length
          ? { model: { providerID: modelProvider, id: modelRest.join("/") } }
          : {},
      ),
    });
    assert.ok(res.ok, `session created (${res.status})`);
    const j = (await res.json()) as { data?: { id?: string }; id?: string };
    const sid = j.data?.id ?? j.id;
    assert.ok(sid, "session id in the reply");
    const panel = api.panels.open(sid);
    try {
      const deadline = Date.now() + 40_000;
      while (
        Date.now() < deadline &&
        panel.chat.isUnresponsive !== false
      )
        await new Promise((r) => setTimeout(r, 500));
      assert.strictEqual(
        panel.chat.isUnresponsive,
        false,
        "the real page pinged from inside the panel",
      );
      // Hold a beat: the poster's idle facts post right after boot
      // (tab-signal -> AppHost -> the panel's TabSignal, a no-op icon
      // refresh from idle).
      await new Promise((r) => setTimeout(r, 2_000));
      assert.ok(api.panels.has(sid), "panel still alive after the facts landed");

      // A real model turn (cleared for tests; opt-in via OC_TEST_REAL_TURN=1
      // so plain runs stay free; OC_TEST_MODEL pins a cheap tier — the
      // default otherwise is whatever the account resolves). Track the tab
      // icon through it: the spinner appears while the session works and
      // the icon settles when the turn ends (idle mark or, on an inactive
      // tab, the green one).
      if (process.env.OC_TEST_REAL_TURN !== "1") this.skip();
      const iconFsPath = () => {
        const icon = panel.icon as
          | { fsPath?: string }
          | { light?: { fsPath?: string }; dark?: { fsPath?: string } };
        const p =
          "fsPath" in icon && icon.fsPath !== undefined
            ? icon.fsPath
            : (icon as { dark?: { fsPath?: string } }).dark?.fsPath ??
              (icon as { light?: { fsPath?: string } }).light?.fsPath ??
              "";
        return p.replace(/\\/g, "/").toLowerCase();
      };
      const ask = await fetch(`${url}/api/session/${sid}/prompt`, {
        method: "POST",
        headers: { ...api.authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ text: "Write one short sentence about a sparrow." }),
      });
      assert.ok(ask.ok, `prompt accepted (${ask.status})`);
      const spinBy = Date.now() + 45_000;
      while (Date.now() < spinBy && !iconFsPath().includes("/spin-"))
        await new Promise((r) => setTimeout(r, 300));
      assert.ok(
        iconFsPath().includes("/spin-"),
        `the tab icon spins while the turn runs (${iconFsPath()})`,
      );
      const settleBy = Date.now() + 90_000;
      while (
        Date.now() < settleBy &&
        iconFsPath().includes("/spin-")
      )
        await new Promise((r) => setTimeout(r, 300));
      const settled = iconFsPath();
      assert.ok(
        settled.endsWith("icon.png") || settled.includes("/mark-ready-"),
        `the icon settles after the turn (${settled})`,
      );
    } finally {
      // Close this test's tab: later suites count panels and the
      // deactivate teardown disposes them anyway, but a quiet exit here
      // keeps the window's tab state as the earlier tests left it.
      panel.reveal();
      for (const g of vscode.window.tabGroups.all) {
        for (const tab of g.tabs) {
          if (sessionTabId(tab) === sid) void vscode.window.tabGroups.close(tab);
        }
      }
    }
  });

  test("rebuilding a session panel keeps its place in the tab strip", async function () {
    // Every tab swap (reload revive, dead-webview recreate, stray heal)
    // closes the old tab and opens a fresh one, which VS Code places at
    // the strip's end — without a spot restore every reload shuffles the
    // user's session tabs. recreate() is the same swap the serializer
    // performs on revival, so it pins the shared mechanism.
    const mk = async () => {
      const res = await fetch(`${await waitForUrl(api)}/api/session`, {
        method: "POST",
        headers: { ...api.authHeaders(), "content-type": "application/json" },
        body: "{}",
      });
      assert.ok(res.ok, `session created (${res.status})`);
      const j = (await res.json()) as { data?: { id?: string }; id?: string };
      const id = j.data?.id ?? j.id;
      assert.ok(id, "session id in the reply");
      return id as string;
    };
    const sid1 = await mk();
    const sid2 = await mk();
    api.panels.open(sid1);
    api.panels.open(sid2);
    const order = () => {
      const g = vscode.window.tabGroups.all.find((gr) =>
        gr.tabs.some((t) => sessionTabId(t) === sid1),
      );
      return g ? g.tabs.map((t) => sessionTabId(t)) : [];
    };
    try {
      // The ext host's tab view lags createWebviewPanel; settle first.
      // Earlier runs' tabs can linger in the harness window, so the
      // assertions are about THIS pair's indexes, not the whole strip.
      const settle = Date.now() + 10_000;
      while (
        Date.now() < settle &&
        !(order().includes(sid1) && order().includes(sid2))
      )
        await new Promise((r) => setTimeout(r, 200));
      const before = order();
      assert.ok(
        before.indexOf(sid1) !== -1 && before.indexOf(sid2) !== -1,
        `both session tabs are open (${before.join(", ")})`,
      );
      assert.ok(
        before.indexOf(sid1) < before.indexOf(sid2),
        "the two tabs opened in order",
      );
      const spot1 = before.indexOf(sid1);
      const spot2 = before.indexOf(sid2);
      api.panels.recreate(sid1);
      // The spot restore fires an async move; poll until it lands.
      const deadline = Date.now() + 10_000;
      let after: (string | undefined)[] = [];
      while (Date.now() < deadline) {
        after = order();
        if (after.indexOf(sid1) === spot1) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      assert.strictEqual(
        after.indexOf(sid1),
        spot1,
        `the rebuilt tab kept its index (strip: ${after.join(", ")})`,
      );
      assert.strictEqual(
        after.indexOf(sid2),
        spot2,
        `the neighbor kept its index (strip: ${after.join(", ")})`,
      );
    } finally {
      // Close every session tab (not just this test's): leftover tabs
      // persist into later runs' harness windows and muddy the strip.
      const gone = Date.now() + 5_000;
      while (Date.now() < gone) {
        const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs);
        if (!tabs.some((t) => sessionTabId(t) !== undefined)) break;
        for (const tab of tabs) {
          if (sessionTabId(tab) !== undefined)
            void vscode.window.tabGroups.close(tab);
        }
        await new Promise((r) => setTimeout(r, 300));
      }
    }
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

  test("after deactivate, ensureServer returns the manager it creates", async function () {
    const main = await import("../main");
    await main.deactivate();
    const sm = api.ensureServer();
    assert.ok(sm, "ensureServer returns a truthy manager");
    // The returned manager is the live one: it boots, and the runner's
    // orphan check learns its port.
    const url = await waitForUrl(api);
    fs.writeFileSync(portFile, String(api.serverPort ?? new URL(url).port));
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
      providerColors: { get: () => ({}) },
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

  test("tab-signal facts reach the onTabSignal callback (icon state machine)", async function () {
    // The tab prefix's host half: the page's "tab-signal" posts coerce and
    // land in the callback (SessionPanel's TabSignal), and the machine
    // keeps the old prefix's priority — attention > busy > ready > idle —
    // with the green mark gated on the tab not being active, setting the
    // state's icon exactly once per change.
    const { AppHost } = await import("../webview/AppHost");
    const { TabSignal } = await import("../webview/TabSignal");
    const extUri = vscode.extensions.getExtension(
      "chinese-room-solutions.vsc-opencode-gui",
    )!.extensionUri;
    const noopStore = { get: () => undefined, set: () => {} };
    const facts: unknown[] = [];
    let onMessage: ((m: unknown) => void) | undefined;
    const host = new AppHost({
      extensionUri: extUri,
      kind: "session",
      sessionId: "ses-signal",
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
      providerColors: { get: () => ({}) },
      onTabSignal: (f) => facts.push(f),
    });
    host.attach({
      options: undefined,
      onDidReceiveMessage: (cb: (m: unknown) => void) => {
        onMessage = cb;
        return { dispose: () => {} };
      },
      postMessage: () => Promise.resolve(true),
      asWebviewUri: (u: vscode.Uri) => u,
      cspSource: "https://test",
    } as never);
    const icons: string[] = [];
    const sig = new TabSignal<string>(
      { frame: (state) => state, idle: "idle" },
      (icon) => icons.push(icon),
    );
    try {
      onMessage?.({
        type: "tab-signal",
        busy: true,
        attention: false,
        turnEnded: false,
      });
      assert.deepStrictEqual(facts, [{ busy: true, attention: false }]);
      sig.apply(facts[0] as never, false);
      assert.strictEqual(icons.at(-1), "busy", "busy shows the spinner");
      assert.strictEqual(icons.length, 1, "one set per state change");
      // Facts that leave the state unchanged never re-set the icon.
      sig.apply({ busy: true }, false);
      assert.strictEqual(icons.length, 1, "no re-set while busy holds");
      // A turn ending in a background tab latches green; busy still wins.
      onMessage?.({ type: "tab-signal", turnEnded: true });
      sig.apply(facts.at(-1) as never, false);
      assert.strictEqual(icons.at(-1), "busy", "busy beats ready");
      onMessage?.({ type: "tab-signal", busy: false });
      sig.apply(facts.at(-1) as never, false);
      assert.strictEqual(icons.at(-1), "ready", "ready shows once idle");
      sig.activated();
      assert.strictEqual(icons.at(-1), "idle", "activation clears ready");
      // A turn ending while the tab is active marks nothing.
      sig.apply({ turnEnded: true }, true);
      assert.strictEqual(icons.at(-1), "idle");
      // An ask outranks the spinner.
      sig.apply({ busy: true }, false);
      sig.apply({ attention: true }, false);
      assert.strictEqual(icons.at(-1), "attention", "ask beats busy");
      sig.apply({ attention: false, busy: false }, false);
      assert.strictEqual(icons.at(-1), "idle");
    } finally {
      host.dispose();
    }
  });

  test("generated tab icons are valid, animated APNGs", async function () {
    // The prefix's spinner/marks are runtime-generated APNGs (a
    // hand-rolled encoder): assert the container decodes, the animation
    // chunks are well-formed, and frames actually differ (a stuck
    // generator would freeze the tab).
    const { inflateSync } = await import("zlib");
    const { TabIconSet } = await import("../webview/TabSignal");
    const dir = vscode.Uri.joinPath(
      vscode.Uri.file(os.tmpdir()),
      `oc-tabicons-${Date.now()}`,
    );
    const icons = new TabIconSet(dir);
    // The set fails soft on unwritable dirs (undefined); a tmpdir write
    // must succeed, so assert the file exists while narrowing the type.
    const readApng = (uri: vscode.Uri | undefined) => {
      assert.ok(uri, "icon written");
      return fs.readFileSync(uri.fsPath);
    };
    const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // Walks the chunks and returns the per-frame pixel data (frame 0's
    // IDAT, then each fdAT minus its 4-byte sequence prefix), checking
    // the APNG layout as it goes.
    const parseApng = (buf: Buffer): Buffer[] => {
      assert.ok(buf.subarray(0, 8).equals(PNG_SIG), "PNG signature");
      assert.strictEqual(buf.readUInt32BE(16), 120, "width");
      assert.strictEqual(buf.readUInt32BE(20), 120, "height");
      const chunks: { type: string; data: Buffer }[] = [];
      for (let off = 8; off < buf.length; off += 0) {
        const len = buf.readUInt32BE(off);
        chunks.push({
          type: buf.subarray(off + 4, off + 8).toString("ascii"),
          data: buf.subarray(off + 8, off + 8 + len),
        });
        off += 12 + len;
      }
      const actl = chunks.find((c) => c.type === "acTL");
      assert.ok(actl, "acTL present");
      assert.strictEqual(actl.data.readUInt32BE(0), 72, "72 frames");
      assert.strictEqual(actl.data.readUInt32BE(4), 0, "infinite plays");
      const seqs: number[] = [];
      const raws: Buffer[] = [];
      for (const c of chunks) {
        if (c.type === "fcTL") {
          seqs.push(c.data.readUInt32BE(0));
          assert.strictEqual(c.data.readUInt16BE(20), 1, "delay_num 1");
          assert.strictEqual(c.data.readUInt16BE(22), 60, "delay_den 60 (60fps)");
        } else if (c.type === "fdAT") {
          seqs.push(c.data.readUInt32BE(0));
          raws.push(c.data.subarray(4));
        } else if (c.type === "IDAT") raws.push(c.data);
      }
      // 72 fcTL + 71 fdAT; sequence numbers increment across them all.
      assert.strictEqual(seqs.length, 143, "72 fcTL + 71 fdAT");
      for (const [i, s] of seqs.entries()) assert.strictEqual(s, i);
      return raws.map((d) => inflateSync(d));
    };
    const spin = parseApng(readApng(icons.spinner("dark")));
    assert.strictEqual(spin.length, 72, "spinner frames");
    for (const raw of spin)
      assert.strictEqual(raw.length, (120 * 4 + 1) * 120, "RGBA scanlines");
    assert.ok(!spin[0]!.equals(spin[18]!), "spinner frames differ");
    assert.ok(!spin[18]!.equals(spin[36]!), "spinner frames differ (18 vs 36)");
    const mark = parseApng(readApng(icons.mark("attention")));
    assert.ok(!mark[0]!.equals(mark[36]!), "mark frames differ (the pulse)");
    assert.ok(!mark[0]!.equals(spin[0]!), "marks and spinner differ");
  });

  test("read-attachment answers only inside the attachments root", async function () {    // The sent-chip thumbnail relay, driven like the ping above: a real
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
      providerColors: { get: () => ({}) },
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
      providerColors: { get: () => ({}) },
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
