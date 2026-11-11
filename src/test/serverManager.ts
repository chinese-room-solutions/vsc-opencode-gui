import * as assert from "assert";
import * as net from "net";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { ServerManager, normWorktree } from "../server/ServerManager";
import { ChatHub } from "../webview/ChatHub";
import { serverAuthHeaders, setSpawnedServerPassword } from "../server/serverAuth";

// Runs inside the extension host (see lifecycle.ts for the harness). Covers
// ServerManager directly, complementing lifecycle.ts's end-to-end runs:
// argv/path handling, attach-vs-spawn on a live port, the lease/store
// bookkeeping, and dispose's kill path. Real `opencode serve` boots are
// allowed but kept to six; every manager lands in `managers` so a failure
// cannot leak a child past the suite.

const managers: ServerManager[] = [];

// ServerManager only reads context.globalState and context.secrets;
// in-memory stores keep these boots from touching the globalState and
// secret storage the lifecycle.ts runs rely on.
function fakeContext(): {
  ctx: vscode.ExtensionContext;
  store: Map<string, unknown>;
  secrets: Map<string, string>;
} {
  const store = new Map<string, unknown>();
  const secrets = new Map<string, string>();
  const ctx = {
    globalState: {
      get: (key: string) => store.get(key),
      update: (key: string, value: unknown) => {
        store.set(key, value);
        return Promise.resolve();
      },
    },
    secrets: {
      get: (key: string) => Promise.resolve(secrets.get(key)),
      store: (key: string, value: string) => {
        secrets.set(key, value);
        return Promise.resolve();
      },
      delete: (key: string) => {
        secrets.delete(key);
        return Promise.resolve();
      },
    },
  } as unknown as vscode.ExtensionContext;
  return { ctx, store, secrets };
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
        `Where-Object { $_.CommandLine -match 'serve --port ${port}( |$)' } | ` +
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
): Promise<{
  sm: ServerManager;
  hub: ChatHub;
  store: Map<string, unknown>;
  secrets: Map<string, string>;
}> {
  const hub = new ChatHub();
  const sm = new ServerManager();
  const { ctx, store, secrets } = fakeContext();
  managers.push(sm);
  await sm.start(hub, ctx, port, exposeToNetwork, opencodePath);
  return { sm, hub, store, secrets };
}

// Sets env vars for the duration of fn and restores the ambient values
// after — the extension host process env is shared by every suite.
async function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const prev = Object.entries(vars).map(
    ([k]) => [k, process.env[k]] as const,
  );
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await fn();
  } finally {
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
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

  test("serverAuthHeaders prefers the spawned password, then OPENCODE_PASSWORD", async function () {
    // The module state leaks across tests, so pin it here and below.
    setSpawnedServerPassword(undefined);
    await withEnv(
      { OPENCODE_PASSWORD: "inherited", OPENCODE_SERVER_PASSWORD: "legacy" },
      async () => {
        assert.strictEqual(
          serverAuthHeaders().authorization,
          "Basic " + Buffer.from("opencode:inherited").toString("base64"),
          "v2's order: an inherited OPENCODE_PASSWORD wins",
        );
        setSpawnedServerPassword("ours");
        assert.strictEqual(
          serverAuthHeaders().authorization,
          "Basic " + Buffer.from("opencode:ours").toString("base64"),
          "our spawned server's password wins",
        );
        setSpawnedServerPassword(undefined);
      },
    );
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
    // The first /session after a boot can take ~12s inside the harness
    // (a one-time lazy init in the server binary — instant standalone,
    // and the second call is always fast). Poll past it instead of
    // racing ServerManager's 10s request cap.
    let sessions: unknown;
    for (let i = 0; i < 6 && !Array.isArray(sessions); i++) {
      sessions = await sm.listSessions();
      if (!Array.isArray(sessions)) await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(Array.isArray(sessions), "GET /session works");
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

  test("a crashed host's orphan re-attaches with the stored password", async function () {
    const port = await freePort();
    const a = await boot(port);
    const url = await waitForUrl(a.hub);
    // v2 spawns store their generated password for this port; v1 spawns
    // (the pinned CI binary) run open and store nothing.
    const key = `opencode.spawnedPassword.${port}`;
    const stored = await a.secrets.get(key);
    if (stored !== undefined) assert.ok(stored.length > 0);
    // Crash, not dispose: the host disappears without killing its child.
    // _live is compile-time private — the runtime set is what matters.
    (ServerManager as unknown as { _live: Set<ServerManager> })._live.delete(
      a.sm,
    );
    // A fresh host: fresh globalState, but secret storage persists.
    const hub = new ChatHub();
    const sm = new ServerManager();
    managers.push(sm);
    const { ctx, secrets } = fakeContext();
    if (stored !== undefined) await ctx.secrets.store(key, stored);
    await sm.start(hub, ctx, port);
    assert.strictEqual(
      await waitForUrl(hub, 30_000),
      url,
      "re-attached to the orphan, no second spawn",
    );
    assert.strictEqual(sm.serverPort, port);
    assert.ok(
      secrets.has(key),
      "the re-attach consumed nothing: the secret stays for the next host",
    );
    await sm.dispose();
    assert.strictEqual((await fetch(url)).status, 200, "attacher spared the orphan");
    await a.sm.dispose();
    assert.ok(await untilDead(url), "the spawner's dispose killed the orphan");
  });

  test("exposeToNetwork binds all interfaces on v2 and dials localhost", async function () {
    const port = await freePort();
    const { sm, hub } = await boot(port, true);
    const url = await waitForUrl(hub);
    // The wide bind announces 0.0.0.0; the manager must normalize it.
    assert.strictEqual(url, `http://localhost:${port}`);
    if (process.platform === "win32") {
      const cl = cmdlineForPort(port);
      assert.ok(cl.includes("--hostname"), `--hostname in: ${cl}`);
      assert.ok(!cl.includes("--mdns"), `--mdns must not reach v2: ${cl}`);
    }
    await sm.dispose();
    assert.ok(await untilDead(url), "exposed server killed on dispose");
  });

  test("a failed config read aborts the provider toggle, file untouched", async function () {
    const port = await freePort();
    const { sm, hub } = await boot(port);
    await waitForUrl(hub);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oc-test-config-"));
    const configRoot = path.join(tmp, "opencode");
    const file = path.join(configRoot, "opencode.json");
    fs.mkdirSync(configRoot, { recursive: true });
    const before = `{ "model": "anthropic/claude-sonnet-4-5" }\n`;
    fs.writeFileSync(file, before);
    process.env.XDG_CONFIG_HOME = tmp;
    // tsc's __importStar wraps modules in getter-only copies, so patch the
    // raw module object those getters delegate to. The extension host
    // bundle is CJS, so it is the same object ServerManager reads through.
    const fsRaw = require("fs") as {
      readFileSync: (p: fs.PathOrFileDescriptor, o?: unknown) => string | Buffer;
    };
    const realRead = fsRaw.readFileSync.bind(fsRaw);
    const busy = Object.assign(new Error("EBUSY"), { code: "EBUSY" });
    fsRaw.readFileSync = (p, options) => {
      if (p === file) throw busy;
      return realRead(p, options);
    };
    try {
      // The old behavior treated any read error as "no config yet" and
      // replaced the whole file with just the provider key.
      assert.strictEqual(await sm.setDisabledProviders(["x"]), false);
      assert.strictEqual(realRead(file, "utf8"), before);
    } finally {
      fsRaw.readFileSync = realRead;
      delete process.env.XDG_CONFIG_HOME;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    await sm.dispose();
  });

  test("an inherited OPENCODE_PASSWORD does not break the spawned server", async function () {
    let sm: ServerManager | undefined;
    let url = "";
    try {
      await withEnv({ OPENCODE_PASSWORD: "wrong" }, async () => {
        const booted = await boot(await freePort());
        sm = booted.sm;
        // v2 would otherwise prefer the inherited password, 401 every
        // call, and bake a v1 dialect for the server's lifetime.
        url = await waitForUrl(booted.hub);
        let sessions: unknown;
        for (let i = 0; i < 6 && !Array.isArray(sessions); i++) {
          sessions = await booted.sm.listSessions();
          if (!Array.isArray(sessions))
            await new Promise((r) => setTimeout(r, 500));
        }
        assert.ok(
          Array.isArray(sessions),
          "listSessions answers despite the inherited password",
        );
      });
    } finally {
      if (sm) await sm.dispose();
    }
    assert.ok(await untilDead(url), "dispose killed the server");
  });

  suiteTeardown(async function () {
    for (const sm of managers) await sm.dispose();
  });
});
