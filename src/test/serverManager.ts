import * as assert from "assert";
import * as net from "net";
import { spawnSync } from "child_process";
import * as vscode from "vscode";
import { ServerManager, normWorktree } from "../server/ServerManager";
import { ChatHub } from "../webview/ChatHub";

// Runs inside the extension host (see lifecycle.ts for the harness). Covers
// ServerManager directly, complementing lifecycle.ts's end-to-end runs:
// argv/path handling, attach-vs-spawn on a live port, the lease/store
// bookkeeping, and dispose's kill path. Real `opencode serve` boots are
// allowed but kept to two; every manager lands in `managers` so a failure
// cannot leak a child past the suite.

const managers: ServerManager[] = [];

// ServerManager only reads context.globalState; an in-memory store keeps
// these boots from touching the globalState lifecycle.ts relies on.
function fakeContext(): { ctx: vscode.ExtensionContext; store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  const ctx = {
    globalState: {
      get: (key: string) => store.get(key),
      update: (key: string, value: unknown) => {
        store.set(key, value);
        return Promise.resolve();
      },
    },
  } as unknown as vscode.ExtensionContext;
  return { ctx, store };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function waitForUrl(hub: ChatHub, timeoutMs = 90_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = hub.state;
    if (s.kind === "url" && s.url) return s.url;
    if (s.kind === "error") throw new Error(`server errored: ${s.message}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("timed out waiting for server url");
}

async function untilDead(url: string, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(1000) });
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// Command line of the opencode.exe serving `port` ("" when none or not
// Windows — the same filter runTest.js uses for its orphan check).
function cmdlineForPort(port: number): string {
  if (process.platform !== "win32") return "";
  const out = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-c",
      `Get-CimInstance Win32_Process -Filter "Name='opencode.exe'" | ` +
        `Where-Object { $_.CommandLine -like '*serve --port ${port}*' } | ` +
        `Select-Object -ExpandProperty CommandLine`,
    ],
    { encoding: "utf8", timeout: 20_000, windowsHide: true },
  );
  return (out.stdout ?? "").trim();
}

async function boot(
  port: number,
  exposeToNetwork = false,
  opencodePath = "",
): Promise<{ sm: ServerManager; hub: ChatHub; store: Map<string, unknown> }> {
  const hub = new ChatHub();
  const sm = new ServerManager();
  const { ctx, store } = fakeContext();
  managers.push(sm);
  await sm.start(hub, ctx, port, exposeToNetwork, opencodePath);
  return { sm, hub, store };
}

suite("opencode ServerManager", function () {
  test("normWorktree folds separators, drive case, and trailing slashes", function () {
    assert.strictEqual(normWorktree("c:\\foo\\bar\\"), "C:/foo/bar");
    assert.strictEqual(normWorktree("e:\\x\\"), "E:/x");
    assert.strictEqual(normWorktree("D:/a/b"), "D:/a/b");
    assert.strictEqual(normWorktree("C:/MiXeD/Case"), "C:/MiXeD/Case");
    assert.strictEqual(normWorktree("c:\\"), "C:");
    assert.strictEqual(normWorktree("/home/x///"), "/home/x");
  });

  test("a missing configured binary errors out instead of hanging", async function () {
    const { sm, hub } = await boot(
      await freePort(),
      false,
      process.platform === "win32"
        ? "C:\\no such dir\\opencode.exe"
        : "/no/such/dir/opencode",
    );
    await sm.ready;
    const s = hub.state;
    assert.strictEqual(s.kind, "error");
    if (s.kind === "error") assert.ok(s.message.length > 0);
    assert.strictEqual(sm.serverPort, undefined, "no port before a boot");
    await sm.dispose();
  });

  test("boots a real server: port stored, lease held, API alive, no --mdns", async function () {
    const port = await freePort();
    const { sm, hub, store } = await boot(port);
    const url = await waitForUrl(hub);
    assert.strictEqual(url, `http://localhost:${port}`);
    assert.strictEqual(sm.serverPort, port);
    // Stored port for the next boot, and a lease entry for this window.
    assert.strictEqual(store.get("opencode.serverPort"), port);
    const lease = store.get("opencode.serverSessions") as
      | { port: number; session: string }[]
      | undefined;
    assert.ok(
      lease?.some((e) => e.port === port && e.session === vscode.env.sessionId),
    );
    assert.ok(Array.isArray(await sm.listSessions()), "GET /session works");
    const catalog = await sm.providerCatalog();
    assert.ok(catalog && Array.isArray(catalog.connected) && Array.isArray(catalog.all));
    if (process.platform === "win32") {
      const cl = cmdlineForPort(port);
      assert.ok(cl, "server process visible on its port");
      assert.ok(!cl.includes("--mdns"), "mdns off by default");
    }
    await sm.dispose();
    assert.ok(await untilDead(url), "dispose killed the server");
  });

  test("a second manager attaches to the live server; its dispose spares it", async function () {
    const port = await freePort();
    const a = await boot(port);
    const urlA = await waitForUrl(a.hub);
    const b = await boot(port);
    const urlB = await waitForUrl(b.hub, 30_000);
    assert.strictEqual(urlB, urlA, "attached to the same url, no new spawn");
    assert.strictEqual(b.sm.serverPort, port);
    await b.sm.dispose();
    assert.strictEqual((await fetch(urlA)).status, 200, "server survives");
    await a.sm.dispose();
    assert.ok(await untilDead(urlA), "owner's dispose killed the server");
    if (process.platform === "win32") {
      assert.strictEqual(cmdlineForPort(port), "", "no process left on the port");
    }
  });

  test("exposeToNetwork plumbs --mdns into the spawned command line", async function () {
    const port = await freePort();
    const { sm, hub } = await boot(port, true);
    const url = await waitForUrl(hub);
    assert.strictEqual(url, `http://localhost:${port}`);
    if (process.platform === "win32") {
      const cl = cmdlineForPort(port);
      assert.ok(cl.includes("--mdns"), `--mdns in: ${cl}`);
    }
    await sm.dispose();
    assert.ok(await untilDead(url), "mdns server killed on dispose");
  });

  suiteTeardown(async function () {
    for (const sm of managers) await sm.dispose();
  });
});
