#!/usr/bin/env node
// Serves the webview app standalone so a browser sees exactly what the
// webview iframe sees (same chat.html template, same CSP shape) against a
// real `opencode serve`. The app's traffic is relayed by the stub (as the
// extension host does in VS Code); the rig only serves static shell assets.
// UI behavior can't be driven through the vscode harness — test it here
// with Playwright instead.
//
// Usage: node scripts/ui-rig.js <workspaceDir> [rigPort]
// Prints the URL to open. SIGINT/Ctrl+C kills the opencode child too.

const { spawn, spawnSync } = require("child_process");
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const workspaceDir = process.argv[2];
if (!workspaceDir) {
  console.error("usage: node scripts/ui-rig.js <workspaceDir> [rigPort]");
  process.exit(1);
}

const root = path.join(__dirname, "..");
const appJs = path.join(root, "out", "webview", "app.js");
const appCss = path.join(root, "out", "webview", "app.css");
const template = path.join(root, "out", "webview", "templates", "chat.html");
if (!fs.existsSync(appJs) || !fs.existsSync(template)) {
  console.error("out/webview is missing — run `npm run compile` first.");
  process.exit(1);
}

const rigPort = process.argv[3]
  ? parseInt(process.argv[3], 10)
  : 43100 + Math.floor(Math.random() * 1000);
let apiPort = 43100 + Math.floor(Math.random() * 1000);
if (apiPort === rigPort) apiPort++;

// The opencode binary: OPENCODE_BIN overrides (e.g. a v2 @opencode/cli
// exe), bare `opencode` from PATH otherwise. `--version` sniffs the
// dialect (v1 prints "1.18.30", v2 "opencode v2.0.18"): a v2 serve is
// password-protected by default, so the rig generates one (env-provided
// wins) and bakes the Basic header — mirroring ServerManager. The dialect
// is baked into the page meta like AppHost does.
const opencodeBin = process.env.OPENCODE_BIN || "opencode";
let isV2 = false;
try {
  const ver = require("child_process").spawnSync(opencodeBin, ["--version"], {
    encoding: "utf8",
    timeout: 10000,
    shell: process.platform === "win32",
  });
  isV2 = /^opencode\s+v?2\./m.test(`${ver.stdout || ""}${ver.stderr || ""}`);
} catch {
  // Sniff failed — assume v1.
}
const serverPassword =
  process.env.OPENCODE_SERVER_PASSWORD ||
  (isV2 ? crypto.randomBytes(24).toString("hex") : undefined);
console.log(`BIN   ${opencodeBin} (${isV2 ? "dialect v2" : "dialect v1"})`);

// Install the oc-attachments skill before the server boots — skills are
// discovered at boot. Same install the extension's ServerManager does.
const configRoot =
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
const installSkill = (name, content) => {
  const dir = path.join(configRoot, "opencode", "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), content);
};
const attachmentsSkill = path.join(root, "out", "oc-attachments-skill.md");
if (fs.existsSync(attachmentsSkill)) {
  installSkill("oc-attachments", fs.readFileSync(attachmentsSkill, "utf-8"));
}

const child = spawn(opencodeBin, ["serve", "--port", String(apiPort)], {
  cwd: workspaceDir,
  shell: process.platform === "win32",
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
  // Isolate the server's data (sessions, DB) inside the rig workspace.
  // Without this it uses ~/.local/share/opencode — the user's real global
  // store — and any test cleanup (session deletes) destroys real data.
  env: {
    ...process.env,
    XDG_DATA_HOME: path.join(workspaceDir, ".oc-data"),
    ...(serverPassword
      ? { OPENCODE_SERVER_PASSWORD: serverPassword }
      : {}),
  },
});

// Windows: the child goes through a shell and `serve` spawns a detached
// worker, so kill the tree AND sweep by port (unique to this server).
const kill = () => {
  if (process.platform === "win32") {
    if (child.pid) {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    }
    spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-c",
        `Get-CimInstance Win32_Process -Filter "Name='opencode.exe'" | ` +
          `Where-Object { $_.CommandLine -like '*serve --port ${apiPort}*' } | ` +
          `ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
      ],
      { windowsHide: true, stdio: "ignore", timeout: 5000 },
    );
  } else {
    child.kill("SIGTERM");
    spawnSync("pkill", ["-f", `serve --port ${apiPort}`], {
      stdio: "ignore",
      timeout: 5000,
    });
  }
};
process.on("SIGINT", () => { server.close(); kill(); process.exit(0); });
process.on("SIGTERM", () => { server.close(); kill(); process.exit(0); });
process.on("exit", kill); // hard kills (taskkill on node) still tree-kill the child

// VS Code API stand-in emulating AppHost's relay: api-requests are fetched
// from the server here and SSE frames are forwarded as window messages
// (e.data IS the message, like a webview postMessage), so the app runs
// unchanged in a plain browser. Same nonce as the app script so CSP passes.
const stubFor = (nonce, serverUrl) => {
  // Basic auth for password-protected servers, mirroring the extension
  // host's serverAuthHeaders (any username). The password is whatever the
  // rig gave the server (env-provided or generated for v2).
  const auth = serverPassword
    ? `"authorization": "Basic ${Buffer.from(
        "opencode:" + serverPassword,
      ).toString("base64")}",`
    : "";
  return `<script nonce="${nonce}">` +
  `(() => {` +
  `let pumped = false;` +
  `const startPump = () => {` +
  `if (pumped) return; pumped = true;` +
  `window.postMessage({ type: "sse-state", state: "connecting" }, "*");` +
  // Two streams, like AppHost: /api/event (v2 asks, state authority) and
  // /event (the v1 turn dialect; v2 servers never frame it, and the rig
  // proxies both with auth — a browser EventSource cannot send the Basic
  // header itself). The v1 envelope addresses `properties`; normalized
  // here so the app sees one shape.
  `const feed = (url, primary) => {` +
  `const es = new EventSource(url);` +
  `if (primary) {` +
  `es.onopen = () => window.postMessage({ type: "sse-state", state: "connected" }, "*");` +
  `es.onerror = () => window.postMessage({ type: "sse-state", state: "offline" }, "*");` +
  `}` +
  `es.onmessage = (e) => {` +
  `try { const raw = JSON.parse(e.data); window.postMessage({ type: "sse-event", event: { id: raw.id, type: raw.type, data: raw.data === undefined ? raw.properties : raw.data } }, "*"); }` +
  `catch {}` +
  `};` +
  `};` +
  `feed("/sse/api-event", true);` +
  (isV2 ? "" : `feed("/sse/event", false);`) +
  `};` +
  `window.acquireVsCodeApi = () => ({` +
  `postMessage: (m) => {` +
  `if (m && m.type === "api-request") {` +
  `startPump();` +
  `(async () => {` +
  `try {` +
  `const res = await fetch("${serverUrl}" + m.path, {` +
  `method: m.method,` +
  `headers: { ${auth}"content-type": m.body === undefined ? undefined : "application/json" },` +
  `body: m.body === undefined ? undefined : JSON.stringify(m.body),` +
  `});` +
  `const isJson = (res.headers.get("content-type") || "").includes("application/json");` +
  `const json = isJson ? await res.json() : undefined;` +
  // Mirror AppHost's failure reason so banners read the same in the rig.
  `let error;` +
  `if (!res.ok) { const d = (json && json.data && json.data.message) || (json && json.message); error = "HTTP " + res.status + (d ? ": " + String(d).slice(0, 140) : ""); }` +
  `else if (!isJson) { error = "HTTP " + res.status + " (" + (res.headers.get("content-type") || "no content type").split(";")[0] + " reply)"; }` +
  `window.postMessage({ type: "api-result", id: m.id, ok: res.ok, json: json, error: error }, "*");` +
  `} catch (e) {` +
  `window.postMessage({ type: "api-result", id: m.id, ok: false, error: e && e.name === "TimeoutError" ? "request timed out" : "fetch failed" }, "*");` +
  `}` +
  `})();` +
  `} else {` +
  `console.log("[host-msg]", JSON.stringify(m));` +
  `}` +
  `},` +
  `getState: () => ({}), setState: () => {} });` +
  `})();` +
  `</script>`;
};

const shellHtml = (serverUrl) => {
  const nonce = crypto.randomBytes(16).toString("hex");
  // Same escaping rule as AppHost's escapeAttr: these go into double-quoted
  // meta attributes, and the JSON ones carry double quotes.
  const attr = (s) =>
    s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
  return fs
    .readFileSync(template, "utf-8")
    // The theme style carries its own {{NONCE}} placeholder, so it goes
    // first and the nonce pass below fills it — same ordering as AppHost.
    .replaceAll("{{THEME_STYLE}}", process.env.OPENCODE_THEME_STYLE || "")
    .replaceAll("{{NONCE}}", nonce)
    .replaceAll("{{CSP_SOURCE}}", "*")
    // Unlike the real webview, the stub relay runs in the page and needs
    // network access to the server.
    .replace("default-src 'none';", "default-src 'none'; connect-src *;")
    .replaceAll("{{APP_JS}}", "/app.js")
    .replaceAll("{{APP_CSS}}", "/app.css")
    .replaceAll("{{ORIGIN}}", serverUrl)
    // Same contract as AppHost: the probed dialect baked at boot.
    .replaceAll("{{DIALECT}}", isV2 ? "v2" : "")
    .replaceAll("{{ERROR_MESSAGE}}", "")
    .replaceAll("{{INSTALL_HINT}}", "")
    // Boot-restore metas honor env so Playwright can exercise restore
    // (same contract as AppHost: the host bakes what it stored).
    .replaceAll("{{ROUTE}}", attr(process.env.OPENCODE_ROUTE || ""))
    .replaceAll("{{TABS}}", attr(process.env.OPENCODE_TABS || "[]"))
    .replaceAll("{{TOMBSTONES}}", attr(process.env.OPENCODE_TOMBSTONES || "[]"))
    .replaceAll("{{WORKSPACE}}", attr(workspaceDir))
    .replaceAll(
      "{{HIDDEN_MODELS}}",
      attr(process.env.OPENCODE_HIDDEN_MODELS || "[]"),
    )
    .replaceAll(
      "{{COPY_MODIFIER}}",
      attr(process.env.OPENCODE_COPY_MODIFIER || "alt"),
    )
    // The ready-sound default is on; env opts the rig out like a user would.
    .replaceAll(
      "{{READY_SOUND}}",
      process.env.OPENCODE_READY_SOUND === "0" ? "" : "1",
    )
    .replaceAll(
      "{{PERMISSION_SOUND}}",
      process.env.OPENCODE_PERMISSION_SOUND === "0" ? "" : "1",
    )
    .replaceAll(
      "{{QUESTION_SOUND}}",
      process.env.OPENCODE_QUESTION_SOUND === "0" ? "" : "1",
    )
    .replaceAll(
      "{{STUCK_TOOL}}",
      attr(process.env.OPENCODE_STUCK_TOOL || "120"),
    )
    .replaceAll(
      "{{STUCK_AUTO_ABORT}}",
      attr(process.env.OPENCODE_STUCK_AUTO_ABORT || "0"),
    )
    .replace(
      `<script nonce="${nonce}" src="/app.js"></script>`,
      stubFor(nonce, serverUrl) + `<script nonce="${nonce}" src="/app.js"></script>`,
    );
};

// SSE proxy: pipe one of the server's event streams to the page with the
// auth header attached. A browser EventSource cannot send Basic auth, so
// password-protected servers (v2 always; v1 with a password) would show
// SSE offline without this. The page's EventSource reconnects when the
// upstream ends — ending the response on drop is the whole retry story.
const sseHeaders = serverPassword
  ? {
      authorization:
        "Basic " + Buffer.from("opencode:" + serverPassword).toString("base64"),
    }
  : {};
const proxyEvents = (res, path) => {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  const abort = new AbortController();
  res.on("close", () => abort.abort());
  fetch(serverUrl + path, { headers: sseHeaders, signal: abort.signal })
    .then(async (upstream) => {
      if (!upstream.ok || !upstream.body) throw new Error(String(upstream.status));
      const reader = upstream.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done || res.destroyed) break;
        res.write(value);
      }
    })
    .catch(() => {})
    .finally(() => res.end());
};

const server = http.createServer((req, res) => {
  if (req.url === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(shellHtml(serverUrl));
  } else if (req.url === "/app.js") {
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
    fs.createReadStream(appJs).pipe(res);
  } else if (req.url === "/app.css") {
    res.writeHead(200, { "content-type": "text/css; charset=utf-8" });
    fs.createReadStream(appCss).pipe(res);
  } else if (req.url === "/sse/api-event") {
    proxyEvents(res, "/api/event");
  } else if (req.url === "/sse/event") {
    proxyEvents(res, "/event");
  } else {
    res.writeHead(404);
    res.end();
  }
});

let serverUrl = `http://localhost:${apiPort}`;
server.listen(rigPort, () => {
  console.log(`READY http://localhost:${rigPort}/`);
  console.log(`API   ${serverUrl}`);
});

let done = false;
const handle = (data) => {
  if (done) return;
  const match = data.toString().match(/https?:\/\/[^\s]+/);
  if (match) {
    done = true;
    serverUrl = match[0];
    console.log(`API   ${serverUrl} (from opencode output)`);
  }
};
child.stdout.on("data", handle);
child.stderr.on("data", handle);
child.on("exit", (code) => {
  if (!done) {
    console.error(`opencode serve exited early (code ${code})`);
    process.exit(1);
  }
});

// Fallback if the URL never appears in output.
setTimeout(() => { done = true; }, 5000);
