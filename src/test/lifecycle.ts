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

suite("opencode GUI lifecycle", function () {
  let api: Api;

  suiteSetup(async function () {
    const ext = vscode.extensions.getExtension("chinese-room-solutions.vsc-opencode-gui")!;
    api = (await ext.activate()) as Api;
  });

  test("openChat boots the server and serves the app", async function () {
    await vscode.commands.executeCommand("opencodeGui.openChat");
    const url = await waitForUrl(api);
    const res = await fetch(url);
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
    assert.strictEqual((await fetch(after)).status, 200);
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
      assert.strictEqual((await fetch(next)).status, 200);
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

  suiteTeardown(function () {
    assert.deepStrictEqual(
      uncaught,
      [],
      `uncaught exceptions in extension host: ${uncaught.join(" | ")}`,
    );
  });
});
