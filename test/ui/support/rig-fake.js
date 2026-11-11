#!/usr/bin/env node
// Clone of scripts/ui-rig.js serving the webview app against the FAKE API
// server (test/ui/support/fake-api.mjs) instead of a real `opencode serve`.
// Same shell HTML, same page-side relay, same URL adoption from child
// stdout. Only the child spawn and its kill path differ, and the skill
// installs are left out.
//
// Usage: node test/ui/support/rig-fake.js <workspaceDir> [rigPort]

const { spawn, spawnSync } = require("child_process");
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const workspaceDir = process.argv[2];
if (!workspaceDir) {
  console.error("usage: node test/ui/support/rig-fake.js <workspaceDir> [rigPort]");
  process.exit(1);
}

const root = path.join(__dirname, "..", "..", "..");
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

const fakeApi = path.join(__dirname, "fake-api.mjs");
const child = spawn(process.execPath, [fakeApi, String(apiPort), workspaceDir], {
  cwd: root,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});

// Plain node child — no detached worker, so tree-killing the pid is enough.
const kill = () => {
  if (process.platform === "win32") {
    if (child.pid) {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    }
  } else {
    child.kill("SIGTERM");
    spawnSync("pkill", ["-f", "fake-api.mjs"], {
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
const stubFor = (nonce, serverUrl) =>
  `<script nonce="${nonce}">` +
  `(() => {` +
  `let pumped = false;` +
  `const startPump = () => {` +
  `if (pumped) return; pumped = true;` +
  `window.postMessage({ type: "sse-state", state: "connecting" }, "*");` +
  // Two streams, like AppHost: /api/event (v2 asks, state authority) and
  // /event (the v1 turn dialect). The v1 envelope addresses `properties`;
  // normalized here so the app sees one shape.
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
  `feed("${serverUrl}/api/event", true);` +
  `feed("${serverUrl}/event", false);` +
  `};` +
  `window.acquireVsCodeApi = () => ({` +
  `postMessage: (m) => {` +
  `if (m && m.type === "api-request") {` +
  `startPump();` +
  `(async () => {` +
  `try {` +
  `const res = await fetch("${serverUrl}" + m.path, {` +
  `method: m.method,` +
  `headers: m.body === undefined ? undefined : { "content-type": "application/json" },` +
  `body: m.body === undefined ? undefined : JSON.stringify(m.body),` +
  `});` +
  `const isJson = (res.headers.get("content-type") || "").includes("application/json");` +
  `const json = isJson ? await res.json() : undefined;` +
  // Mirror AppHost's failure reason (like scripts/ui-rig.js) so
  // status-dependent reads — a 404 vs a dropped request — behave the
  // same in the rig as in the extension.
  `let error;` +
  `if (!res.ok) { const d = (json && json.data && json.data.message) || (json && json.message) || (json && json.error); error = "HTTP " + res.status + (d ? ": " + String(d).slice(0, 140) : ""); }` +
  `else if (!isJson) { error = "HTTP " + res.status + " (" + (res.headers.get("content-type") || "no content type").split(";")[0] + " reply)"; }` +
  `window.postMessage({ type: "api-result", id: m.id, ok: res.ok, json: json, error: error }, "*");` +
  `} catch {` +
  `window.postMessage({ type: "api-result", id: m.id, ok: false, error: "fetch failed" }, "*");` +
  `}` +
  `})();` +
  `} else if (m && m.type === "save-attachment") {` +
  // The rig has no disk: answer the snapshot with a fake path so the chip
  // swap (data: -> file://) runs in the rig like it does against the host.
  // A spec can hold the reply open (window.__slowAttach, ms) to race a
  // send against the still-attaching paste.
  `const saved = () => window.postMessage({ type: "attachment-saved", sessionId: m.sessionId, rid: m.rid, path: "file:///repo/.opencode/attachments/" + m.sessionId + "/1-" + m.name }, "*");` +
  `setTimeout(saved, Number(window.__slowAttach) || 0);` +
  `} else if (m && m.type === "read-attachment" && typeof m.path === "string" && m.path.includes("/.opencode/attachments/")) {` +
  // Mirror the host's path guard: only attachments-root paths get a
  // preview (a tiny decodable PNG); anything else falls through to the
  // log branch below with no reply, like the host staying silent.
  `window.postMessage({ type: "attachment-preview", path: m.path, url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" }, "*");` +
  `} else if (m && m.type === "bell-claim") {` +
  // Like ChatHub.claimBell: the rig's single page always wins the
  // window, so the grant comes straight back.
  `(window.__hostPosted = window.__hostPosted || []).push(m);` +
  `window.postMessage({ type: "bell-grant", kind: m.kind }, "*");` +
  `} else {` +
  // Host-directed posts (open-session, open-project, …) recorded for
  // specs to assert; the console line stays for manual rig sessions.
  `(window.__hostPosted = window.__hostPosted || []).push(m);` +
  `console.log("[host-msg]", JSON.stringify(m));` +
  `}` +
  `},` +
  `getState: () => ({}), setState: () => {} });` +
  `})();` +
  `</script>`;

const shellHtml = (serverUrl) => {
  const nonce = crypto.randomBytes(16).toString("hex");
  // Same escaping rule as AppHost's escapeAttr: these go into double-quoted
  // meta attributes, and the JSON ones carry double quotes.
  const attr = (s) =>
    s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
  // The session id behind a session-route boot ("" for any other route).
  const routeSessionId = () => {
    try {
      const r = JSON.parse(process.env.OPENCODE_ROUTE || "");
      return r && r.view === "session" && typeof r.id === "string" ? r.id : "";
    } catch {
      return "";
    }
  };
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
    // The fake API speaks the v1 dialect by default; OPENCODE_DIALECT=v2
    // bakes v2 (the fake serves both surfaces).
    .replaceAll("{{DIALECT}}", process.env.OPENCODE_DIALECT === "v2" ? "v2" : "")
    .replaceAll("{{ERROR_MESSAGE}}", "")
    .replaceAll("{{INSTALL_HINT}}", "")
    // Which host the page is baked for: OPENCODE_HOST=navigator boots the
    // sidebar view; every other value is a session panel.
    .replaceAll(
      "{{HOST_KIND}}",
      process.env.OPENCODE_HOST === "navigator" ? "navigator" : "session",
    )
    // The session a session panel is pinned to (AppHost bakes the same
    // from its options) — derived from the boot route, or
    // OPENCODE_RIG_PIN when a spec needs the pin and the route to
    // disagree (the re-rooted drill). Rig-only name: the ambient
    // environment carries opencode's own vars (a shell spawned from an
    // opencode session exports OPENCODE_SESSION_ID), and the rig
    // inherits process.env verbatim.
    .replaceAll(
      "{{SESSION_ID}}",
      attr(process.env.OPENCODE_RIG_PIN ?? routeSessionId()),
    )
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
    console.log(`API   ${serverUrl} (from fake-api output)`);
  }
};
child.stdout.on("data", handle);
child.stderr.on("data", handle);
child.on("exit", (code) => {
  if (!done) {
    console.error(`fake-api exited early (code ${code})`);
    process.exit(1);
  }
});

// Fallback if the URL never appears in output.
setTimeout(() => { done = true; }, 5000);
