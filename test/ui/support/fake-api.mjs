#!/usr/bin/env node
// Fake `opencode serve` for browser-level UI tests (no real opencode, no
// model calls). Speaks the endpoints and SSE dialects the webview app
// uses (src/webview/app/api.ts, store.ts): v2 under /api/* with {data,...}
// envelopes, v1 flat rows, and two event streams — /api/event frames
// {id,type,data}, /event frames {id,type,properties}. Prints a READY URL
// so the rig adopts the server address from stdout.
//
// Usage: node fake-api.mjs <port> [workspaceDir]

import http from "node:http";

const port = parseInt(process.argv[2] ?? "0", 10);
const directory = (process.argv[3] ?? "D:/fake/workspace").replace(/\\/g, "/");

const SESSION_ID = "ses_seed_1";
const SEED_TURNS = 12;

// --- deterministic filler text (tall enough to overflow any viewport) ---
const SENTENCES = [
  "The scroller follows the tail while the reader is at the bottom.",
  "A prompt pins itself to the top and holds until the reply fills the fold.",
  "Wheel intent latches the follow off before the first scroll event lands.",
  "Rubber-band recoil moves nothing when the scroller already rests at zero.",
  "The clearance pad keeps the last line above the floating composer card.",
  "Streaming deltas arrive on the v1 feed as message.part.delta frames.",
  "The durable user row retires the optimistic pending echo without a gap.",
  "Session idle lands after the last delta and rings nothing in the rig.",
  "Turns group by prompt boundary and the footer hangs off the whole turn.",
  "Clamped rising scroll after a shrink above is not leave intent.",
  "The awaiting dot renders while the newest visible row is still the prompt.",
  "Load older anchors the viewport to the content the reader was on.",
  "Deltas coalesce in the drain when several frames arrive within a tick.",
  "The context ring fills from usage stamped at each step boundary.",
];
const sentence = (i) => SENTENCES[((i % SENTENCES.length) + SENTENCES.length) % SENTENCES.length];
function filler(seed, paragraphs) {
  let n = seed * 7;
  const out = [];
  for (let p = 0; p < paragraphs; p++) {
    const lines = [];
    for (let s = 0; s < 3; s++) lines.push(sentence(n++));
    out.push(lines.join(" "));
  }
  return out.join("\n\n");
}

// --- seeded transcript: 12 user/assistant turns, several paragraphs each ---
const T0 = Date.now() - SEED_TURNS * 60_000;

// Code-block copy fixture: appended to turn 6's reply. A short fence (in
// place for modifier+click), a tall fence (button-only, over the 10-line
// small-block cap), a fenced block inside a list, and an inline span.
const CODE_TAIL = [
  "Plain fence:",
  "",
  "```ts",
  "const a = 1;",
  "const b = 2;",
  "console.log(a + b);",
  "```",
  "",
  "Tall fence:",
  "",
  "```js",
  ...Array.from({ length: 14 }, (_, i) => `// line ${i + 1} of the tall block`),
  "```",
  "",
  "In a list:",
  "",
  "- step one",
  "- run it:",
  "",
  "  ```sh",
  "  npm run compile",
  "  npm test",
  "  ```",
  "",
  "And an `inlineSpan(42)` in prose.",
].join("\n");

const seedRows = [];
for (let i = 1; i <= SEED_TURNS; i++) {
  const cu = T0 + (i - 1) * 8_000;
  // The last turn's prompt ends in an @-mention (with its durable file part)
  // so the rig can exercise mention pills in the sent message.
  const userText =
    `Question ${i}: ${filler(i * 3, 1)}` +
    (i === SEED_TURNS ? " Tune @src/retry.ts please" : "");
  seedRows.push({
    id: `msg_u${i}`,
    type: "user",
    time: { created: cu, completed: cu + 200 },
    text: userText,
    ...(i === SEED_TURNS
      ? {
          content: [
            {
              type: "file",
              id: `pt_u${i}m`,
              mime: "text/plain",
              url: "file:///repo/src/retry.ts",
              source: {
                type: "file",
                path: "/repo/src/retry.ts",
                text: {
                  value: "@src/retry.ts",
                  start: userText.indexOf("@src/retry.ts"),
                  end: userText.indexOf("@src/retry.ts") + 13,
                },
              },
            },
            {
              // A long-named attachment: the message chip row exercises the
              // cap shared with the composer's pending chip.
              type: "file",
              id: `pt_u${i}f`,
              mime: "application/pdf",
              filename: "DT DevOps - Software Engineer Nomination Form.pdf",
              url: "data:application/pdf;base64,ZmFrZQ==",
            },
            {
              // "+"-picked attachments keep their on-disk path — the chips
              // open on click (text in the editor, pdf with the system tool).
              type: "file",
              id: `pt_u${i}j`,
              mime: "application/json",
              filename: "picked-config.json",
              url: "file:///repo/picks/config.json",
            },
            {
              type: "file",
              id: `pt_u${i}p`,
              mime: "application/pdf",
              filename: "picked-handbook.pdf",
              url: "file:///repo/picks/handbook.pdf",
            },
          ],
        }
      : {}),
  });
  const ca = cu + 1_000;
  // The last turn leads with settled tool calls so the rig can exercise
  // tool cards: one shell, a fold of reads/searches, one edit with a diff.
  const tools =
    i === SEED_TURNS
      ? [
          {
            type: "tool",
            id: "pt_tbash",
            name: "bash",
            state: {
              status: "completed",
              input: { command: "npm run compile" },
              output: "out/webview/app.js   390.6kb\nDone in 19ms",
              time: { start: ca, end: ca + 5_200 },
            },
          },
          {
            type: "tool",
            id: "pt_tr1",
            name: "read",
            state: {
              status: "completed",
              input: { filePath: "README.md" },
              output: "# vsc-opencode-gui\n...",
              time: { start: ca + 5_400, end: ca + 5_900 },
            },
          },
          {
            type: "tool",
            id: "pt_tr2",
            name: "read",
            state: {
              status: "completed",
              input: { filePath: "package.json" },
              output: "{\n  \"name\": \"vsc-opencode-gui\",\n...",
              time: { start: ca + 5_400, end: ca + 6_100 },
            },
          },
          {
            type: "tool",
            id: "pt_tg1",
            name: "grep",
            state: {
              status: "completed",
              input: { pattern: "panelOpen" },
              output: "src/main.ts:41",
              time: { start: ca + 6_300, end: ca + 6_700 },
            },
          },
          {
            type: "tool",
            id: "pt_te1",
            name: "edit",
            state: {
              status: "completed",
              input: { filePath: "src/main.ts" },
              metadata: { diff: "--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1,1 +1,2 @@\n+// tuned" },
              output: "Edited src/main.ts",
              time: { start: ca + 6_900, end: ca + 8_400 },
            },
          },
          {
            type: "tool",
            id: "pt_task1",
            name: "task",
            state: {
              status: "completed",
              input: { description: "Check the retry paths", subagent_type: "general" },
              output: "done",
              time: { start: ca + 8_600, end: ca + 9_400 },
            },
          },
          {
            type: "tool",
            id: "pt_task2",
            name: "task",
            state: {
              status: "completed",
              input: {
                description: "Explore the attribution retry paths",
                subagent_type: "oc-model-ai-gateway-fireworks-glm-5-3-flash",
              },
              output: "done",
              time: { start: ca + 9_600, end: ca + 10_400 },
            },
          },
        ]
      : [];
  seedRows.push({
    id: `msg_a${i}`,
    type: "assistant",
    time: { created: ca, completed: ca + 4_000 },
    agent: "build",
    model: { id: "fake-model", providerID: "fake" },
    cost: 0.01,
    tokens: { input: 100 * i, output: 400 * i, reasoning: 0, cache: { read: 0, write: 0 }, total: 500 * i },
    content: [
      ...tools,
      {
        type: "text",
        id: `pt_a${i}`,
        text: i === 6 ? `${filler(i * 11, 6)}\n\n${CODE_TAIL}` : filler(i * 11, 6),
      },
    ],
  });
}
const lastSeedAssistant = `msg_a${SEED_TURNS}`;
const lastSeedPart = `pt_a${SEED_TURNS}`;
const lastSeedText = filler(SEED_TURNS * 11, 6);

const sessionRow = {
  id: SESSION_ID,
  title: "Seeded long session",
  cost: 0.12,
  tokens: { input: 6_000, output: 24_000, reasoning: 0, cache: { read: 0, write: 0 }, total: 30_000 },
  time: { created: T0, updated: Date.now() },
  location: { directory },
  agent: "build",
  model: { id: "fake-model", providerID: "fake" },
};
const flatSession = ({ ...sessionRow, directory });

// --- SSE plumbing ---
const v2Clients = new Set();
const v1Clients = new Set();
let eid = 0;
function writeFrame(clients, payload) {
  const body = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) res.write(body);
}
const emitV2 = (type, data) => writeFrame(v2Clients, { id: String(++eid), type, data });
const emitV1 = (type, properties) => writeFrame(v1Clients, { id: String(++eid), type, properties });
setInterval(() => {
  for (const res of v2Clients) res.write(": ping\n\n");
  for (const res of v1Clients) res.write(": ping\n\n");
}, 15_000).unref();

// --- synthetic streaming ---
let streamCount = 0;
const timers = new Set();
function later(fn, ms) {
  const t = setTimeout(() => {
    timers.delete(t);
    fn();
  }, ms);
  timers.add(t);
  return t;
}// Grow a text part over the v1 stream (message.part.delta), then call onDone.
function streamText(sid, messageID, partID, { first = 100, count, chars, interval = 150, onChunk, onDone }) {
  streamCount++;
  let s = Math.floor(Math.random() * SENTENCES.length);
  let tick = 0;
  const step = () => {
    // One delta per tick, ~`chars` long: sentences until the budget fills,
    // a paragraph break every 4th delta.
    let delta = "";
    while (delta.length < chars) delta += sentence(s++) + " ";
    if (tick % 4 === 3) delta += "\n\n";
    emitV1("message.part.delta", { sessionID: sid, messageID, partID, field: "text", delta });
    onChunk?.(delta);
    tick++;
    if (tick < count) {
      later(step, interval);
    } else {
      streamCount--;
      onDone?.();
    }
  };
  later(step, first);
}

// POST /session/:id/prompt_async — durable user row, assistant row, growing
// text part, completion, idle. The first delta is delayed so the pinned
// prompt's hold window (everything on screen, dist <= 0) is observable.
let nextTurn = SEED_TURNS + 1;
function runPrompt(sid) {
  const n = nextTurn++;
  const t = Date.now();
  const u = `msg_u${n}`;
  const a = `msg_a${n}`;
  const pt = `pt_a${n}`;
  later(() => emitV1("message.updated", { sessionID: sid, info: { id: u, role: "user", time: { created: t } } }), 150);
  later(() => emitV1("message.updated", {
    sessionID: sid,
    info: { id: a, role: "assistant", time: { created: t + 200 }, providerID: "fake", modelID: "fake-model", agent: "build" },
  }), 300);
  later(() => emitV1("message.part.updated", { sessionID: sid, part: { id: pt, messageID: a, sessionID: sid, type: "text", text: "" } }), 380);
  const full = [];
  streamText(sid, a, pt, {
    first: 2000,
    count: 44,
    chars: 170,
    onChunk: (delta) => full.push(delta),
    onDone: () => {
      emitV1("session.idle", { sessionID: sid });
      // Final durable part write AFTER idle: the turn footer settles on the
      // idle render, and the part swap re-fires the follow effect so the
      // view lands exactly at the bottom.
      later(() => emitV1("message.part.updated", {
        sessionID: sid,
        part: { id: pt, messageID: a, sessionID: sid, type: "text", text: full.join("") },
      }), 150);
    },
  });
}

// Multi-step scenario for the live token-rate counter: a turn that streams
// text, hits a step boundary with a large usage report (the tool-call burst),
// waits on a tool, streams again, then sits through a tool-only step (a new
// assistant row with no text for seconds) before settling. All offsets are
// absolute ms from the POST; /session/status serves busy until the final idle.
let stepsActive = false;
// Rows and parts the scenario has emitted, in the v2 page shape. The app
// re-pulls the message page while the session reads busy (the 30s busy
// refresh); a static page would wipe every live row and later events would
// re-dock them without their prompt.
let stepsRows = [];
function trackInfo(info) {
  let r = stepsRows.find((x) => x.id === info.id);
  if (!r) {
    r = { id: info.id, type: info.role, time: info.time, content: [] };
    stepsRows.push(r);
  }
  if (info.time) r.time = info.time;
  if (info.agent) r.agent = info.agent;
  if (info.modelID) r.model = { id: info.modelID, providerID: info.providerID };
}
function trackPart(p) {
  if (!p || p.type === "step-finish" || p.type === "step-start") return;
  const r = stepsRows.find((x) => x.id === p.messageID);
  if (!r) return;
  const c = { ...p, id: p.id };
  delete c.messageID;
  delete c.sessionID;
  if (c.type === "tool" && c.tool) c.name = c.tool;
  const i = r.content.findIndex((q) => q.id === p.id);
  if (i >= 0) r.content[i] = c;
  else r.content.push(c);
}
function trackText(messageID, partID, delta) {
  const r = stepsRows.find((x) => x.id === messageID);
  const c = r?.content.find((q) => q.id === partID);
  if (c) c.text = (c.text ?? "") + delta;
}
function runSteps(sid) {
  stepsActive = true;
  stepsRows = [];
  const n = nextTurn++;
  const t = Date.now();
  const u = `msg_u${n}`;
  const A = `msg_aA${n}`;
  const B = `msg_aB${n}`;
  const C = `msg_aC${n}`;
  const p1 = `pt_s1${n}`;
  const p2 = `pt_s2${n}`;
  const p3 = `pt_s3${n}`;
  const T1 = `pt_sT1${n}`;
  const T2 = `pt_sT2${n}`;
  const T3 = `pt_sT3${n}`;
  const D = `msg_aD${n}`;
  const now = () => Date.now();
  // Timestamps must be taken when the event fires, not when it is
  // scheduled — an eagerly-built info lands every stamp at scenario start
  // and the app reads nonsense orderings.
  const at = (ms, fn) => later(fn, ms);
  const msg = (ms, info) =>
    at(ms, () => { const i = typeof info === "function" ? info() : info; emitV1("message.updated", { sessionID: sid, info: i }); trackInfo(i); });
  const part = (ms, p) =>
    at(ms, () => { const q = typeof p === "function" ? p() : p; emitV1("message.part.updated", { sessionID: sid, part: q }); trackPart(q); });

  msg(150, { id: u, role: "user", time: { created: t } });
  msg(300, { id: A, role: "assistant", time: { created: t + 250 }, providerID: "fake", modelID: "fake-model", agent: "build" });
  part(400, { id: p1, messageID: A, sessionID: sid, type: "text", text: "" });

  // Phase 1: steady text, 40 deltas x ~170 chars every 150ms (0.5s-6.4s).
  const f1 = [];
  streamText(sid, A, p1, { first: 500, count: 40, chars: 170, interval: 150, onChunk: (d) => { f1.push(d); trackText(A, p1, d); } });

  // Burst: the step emits a tool call (the part exists before the step
  // finishes, as on the real server), usage far past the streamed chars
  // (the call's tokens), then the step completes and the tool runs 3s.
  part(6300, () => ({ id: T1, messageID: A, sessionID: sid, type: "tool", tool: "bash", state: { status: "pending", input: { command: "npm test" }, time: { start: Date.now() } } }));
  part(6550, { id: "sf_s1", messageID: A, sessionID: sid, type: "step-finish", tokens: { input: 200, output: 4000, reasoning: 300, cache: { read: 0, write: 0 } } });
  msg(6650, () => ({ id: A, role: "assistant", time: { created: t + 250, completed: Date.now() }, providerID: "fake", modelID: "fake-model", agent: "build" }));
  part(6750, () => ({ id: T1, messageID: A, sessionID: sid, type: "tool", tool: "bash", state: { status: "running", input: { command: "npm test" }, time: { start: Date.now() } } }));
  part(9550, () => ({ id: T1, messageID: A, sessionID: sid, type: "tool", tool: "bash", state: { status: "completed", input: { command: "npm test" }, output: "ok", time: { start: Date.now() - 2800, end: Date.now() } } }));

  // Phase 2: new step streams text again (10.05s-15.95s), then its own
  // small usage + a second tool wait.
  msg(9750, () => ({ id: B, role: "assistant", time: { created: Date.now() }, providerID: "fake", modelID: "fake-model", agent: "build" }));
  part(9850, { id: p2, messageID: B, sessionID: sid, type: "text", text: "" });
  const f2 = [];
  streamText(sid, B, p2, { first: 10050, count: 40, chars: 170, interval: 150, onChunk: (d) => { f2.push(d); trackText(B, p2, d); } });
  part(15800, () => ({ id: T2, messageID: B, sessionID: sid, type: "tool", tool: "read", state: { status: "pending", input: { filePath: "README.md" }, time: { start: Date.now() } } }));
  part(16100, { id: "sf_s2", messageID: B, sessionID: sid, type: "step-finish", tokens: { input: 100, output: 350, reasoning: 50, cache: { read: 0, write: 0 } } });
  msg(16200, () => ({ id: B, role: "assistant", time: { created: Date.now() - 6450, completed: Date.now() }, providerID: "fake", modelID: "fake-model", agent: "build" }));
  part(16300, () => ({ id: T2, messageID: B, sessionID: sid, type: "tool", tool: "read", state: { status: "running", input: { filePath: "README.md" }, time: { start: Date.now() } } }));
  part(18800, () => ({ id: T2, messageID: B, sessionID: sid, type: "tool", tool: "read", state: { status: "completed", input: { filePath: "README.md" }, output: "# vsc-opencode-gui", time: { start: Date.now() - 2500, end: Date.now() } } }));

  // Phase 3: tool-only step — the row carries just a running tool for 2.5s
  // before its text starts (the textless tool-call step of an agentic turn).
  msg(19000, () => ({ id: C, role: "assistant", time: { created: Date.now() }, providerID: "fake", modelID: "fake-model", agent: "build" }));
  part(19100, () => ({ id: T3, messageID: C, sessionID: sid, type: "tool", tool: "grep", state: { status: "running", input: { pattern: "tok" }, time: { start: Date.now() } } }));
  part(20900, () => ({ id: T3, messageID: C, sessionID: sid, type: "tool", tool: "grep", state: { status: "completed", input: { pattern: "tok" }, output: "src/main.ts:41", time: { start: Date.now() - 1800, end: Date.now() } } }));
  part(21450, { id: "sf_s3", messageID: C, sessionID: sid, type: "step-finish", tokens: { input: 80, output: 200, reasoning: 40, cache: { read: 0, write: 0 } } });
  msg(21550, () => ({ id: C, role: "assistant", time: { created: Date.now() - 2550, completed: Date.now() }, providerID: "fake", modelID: "fake-model", agent: "build" }));
  msg(21800, () => ({ id: D, role: "assistant", time: { created: Date.now() }, providerID: "fake", modelID: "fake-model", agent: "build" }));
  part(21900, { id: p3, messageID: D, sessionID: sid, type: "text", text: "" });
  const f3 = [];
  streamText(sid, D, p3, { first: 22500, count: 20, chars: 170, interval: 150, onChunk: (d) => { f3.push(d); trackText(D, p3, d); } });

  // Settle: small usage, completion, idle.
  part(25600, { id: "sf_s4", messageID: D, sessionID: sid, type: "step-finish", tokens: { input: 60, output: 180, reasoning: 30, cache: { read: 0, write: 0 } } });
  msg(25700, () => ({ id: D, role: "assistant", time: { created: Date.now() - 3900, completed: Date.now() }, providerID: "fake", modelID: "fake-model", agent: "build" }));
  at(25850, () => {
    emitV1("session.idle", { sessionID: sid });
    stepsActive = false;
  });
}

// Batched-delivery scenario for the live token-rate counter: one
// underlying pace (~170 chars/150ms) delivered two ways — steady 150ms
// deltas, then one 2.8k-char batch every 2.5s (the provider-offload
// pattern that reads as pace when seconds without movement are dropped
// from the window). Usage lands only at the end; the spec compares the
// two phases' displayed rates.
function runBatches(sid) {
  stepsActive = true;
  stepsRows = [];
  const n = nextTurn++;
  const t = Date.now();
  const u = `msg_u${n}`;
  const A = `msg_aA${n}`;
  const p1 = `pt_b1${n}`;
  const at = (ms, fn) => later(fn, ms);
  const msg = (ms, info) =>
    at(ms, () => { const i = typeof info === "function" ? info() : info; emitV1("message.updated", { sessionID: sid, info: i }); trackInfo(i); });
  const part = (ms, p) =>
    at(ms, () => { const q = typeof p === "function" ? p() : p; emitV1("message.part.updated", { sessionID: sid, part: q }); trackPart(q); });
  msg(150, { id: u, role: "user", time: { created: t } });
  msg(300, { id: A, role: "assistant", time: { created: t + 250 }, providerID: "fake", modelID: "fake-model", agent: "build" });
  part(400, { id: p1, messageID: A, sessionID: sid, type: "text", text: "" });
  streamText(sid, A, p1, { first: 500, count: 20, chars: 170, interval: 150, onChunk: (d) => trackText(A, p1, d) });
  streamText(sid, A, p1, { first: 4000, count: 6, chars: 2800, interval: 2500, onChunk: (d) => trackText(A, p1, d) });
  part(17200, { id: "sf_b1", messageID: A, sessionID: sid, type: "step-finish", tokens: { input: 100, output: 5000, reasoning: 0, cache: { read: 0, write: 0 } } });
  msg(17300, () => ({ id: A, role: "assistant", time: { created: t + 250, completed: Date.now() }, providerID: "fake", modelID: "fake-model", agent: "build" }));
  at(17500, () => {
    emitV1("session.idle", { sessionID: sid });
    stepsActive = false;
  });
}

// --- HTTP plumbing ---
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
  "access-control-allow-headers": "content-type",
};
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { ...CORS, "content-type": "application/json; charset=utf-8" });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname.replace(/\/{2,}/g, "/") || "/";
  const method = req.method;

  if (method === "OPTIONS") {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  // SSE
  if (method === "GET" && path === "/api/event") {
    res.writeHead(200, { ...CORS, "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    v2Clients.add(res);
    req.on("close", () => v2Clients.delete(res));
    return;
  }
  if (method === "GET" && path === "/event") {
    res.writeHead(200, { ...CORS, "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    v1Clients.add(res);
    req.on("close", () => v1Clients.delete(res));
    return;
  }

  // control endpoints (tests only)
  if (path.startsWith("/__control/")) {
    if (method === "GET" && path === "/__control/status") {
      json(res, 200, { streaming: streamCount > 0 });
      return;
    }
    if (method === "POST" && path === "/__control/steps") {
      if (streamCount > 0 || stepsActive) {
        json(res, 409, { error: "scenario in flight" });
        return;
      }
      runSteps(SESSION_ID);
      json(res, 200, { ok: true });
      return;
    }
    if (method === "POST" && path === "/__control/batches") {
      if (streamCount > 0 || stepsActive) {
        json(res, 409, { error: "scenario in flight" });
        return;
      }
      runBatches(SESSION_ID);
      json(res, 200, { ok: true });
      return;
    }
    if (method === "POST" && path === "/__control/stream-more") {
      const body = await readBody(req);
      if (streamCount > 0) {
        json(res, 409, { error: "already streaming" });
        return;
      }
      const count = Math.max(1, Math.min(200, body.count ?? 26));
      const full = [];
      streamText(SESSION_ID, lastSeedAssistant, lastSeedPart, {
        first: 100,
        count,
        chars: body.chars ?? 170,
        onChunk: (delta) => full.push(delta),
        onDone: () => {
          emitV1("session.idle", { sessionID: SESSION_ID });
          later(() => emitV1("message.part.updated", {
            sessionID: SESSION_ID,
            part: { id: lastSeedPart, messageID: lastSeedAssistant, sessionID: SESSION_ID, type: "text", text: lastSeedText + full.join("") },
          }), 150);
        },
      });
      json(res, 200, { ok: true, count });
      return;
    }
    if (method === "POST" && path === "/__control/shrink") {
      const body = await readBody(req);
      if (streamCount > 0) {
        json(res, 409, { error: "streaming" });
        return;
      }
      const i = Math.max(1, Math.min(SEED_TURNS, body.index ?? 1));
      emitV1("message.part.updated", {
        sessionID: SESSION_ID,
        part: { id: `pt_a${i}`, messageID: `msg_a${i}`, sessionID: SESSION_ID, type: "text", text: "Shortened for the clamp test." },
      });
      json(res, 200, { ok: true });
      return;
    }
    json(res, 404, { error: "no such control" });
    return;
  }

  // boot / reads
  if (method === "GET") {
    if (path === "/session/status") { json(res, 200, { [SESSION_ID]: { type: stepsActive ? "busy" : "idle" } }); return; }
    if (path === "/api/session") { json(res, 200, { data: [sessionRow], cursor: {} }); return; }
    if (path === "/provider") {
      json(res, 200, {
        all: [{
          id: "fake",
          name: "Fake Labs",
          models: {
            // The seeded session's model: legacy-ish multimodal (image+pdf,
            // no audio/video) — existing attachment specs ride on it.
            "fake-model": {
              name: "Fake Model",
              limit: { context: 200_000 },
              variants: { default: {}, high: {} },
              capabilities: { input: { text: true, image: true, pdf: true, audio: false, video: false } },
            },
            // Audio-only twin for the attach-gate spec: denies image/pdf.
            "fake-audio": {
              name: "Fake Audio",
              limit: { context: 100_000 },
              capabilities: { input: { text: true, image: false, pdf: false, audio: true, video: false } },
            },
          },
        }],
        default: { fake: "fake-model" },
        connected: ["fake"],
      });
      return;
    }
    if (path === "/agent") {
      json(res, 200, [
        { name: "build", description: "Write code", mode: "primary" },
        { name: "plan", description: "Plan first", mode: "primary" },
        { name: "general", description: "Sub-agent", mode: "subagent" },
      ]);
      return;
    }
    if (path === "/command") { json(res, 200, []); return; }
    if (path === "/config") { json(res, 200, { model: "fake/fake-model", provider: { fake: {} } }); return; }
    if (path === "/project") { json(res, 200, [{ id: "prj_1", worktree: directory, icon: { color: "pink" }, time: { created: T0, updated: T0 } }]); return; }
    if (path === "/project/current") { json(res, 200, { id: "prj_1", worktree: directory }); return; }
    if (path === "/permission") { json(res, 200, []); return; }
    if (path === "/question") { json(res, 200, []); return; }
    if (path === "/find/file") { json(res, 200, []); return; }
    let m;
    if ((m = path.match(/^\/api\/session\/([^/]+)\/message$/))) {
      // v2 page: {data}, newest first; short page proves the transcript complete.
      json(res, 200, { data: [...seedRows, ...stepsRows].sort((a, b) => b.time.created - a.time.created), cursor: {} });
      return;
    }
    if ((m = path.match(/^\/api\/session\/([^/]+)\/(permission|question)$/))) {
      json(res, 200, { data: [] });
      return;
    }
    if ((m = path.match(/^\/session\/([^/]+)\/message$/))) { json(res, 200, []); return; }
    if ((m = path.match(/^\/session\/([^/]+)$/)) && m[1] !== "status") { json(res, 200, flatSession); return; }
    json(res, 404, { error: `no route ${path}` });
    return;
  }

  if (method === "POST") {
    let m;
    if (path === "/session") {
      const body = await readBody(req);
      const id = `ses_${Date.now()}`;
      json(res, 200, { id, title: body.title || `New session - ${new Date().toISOString()}`, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: Date.now(), updated: Date.now() }, directory });
      return;
    }
    if ((m = path.match(/^\/session\/([^/]+)\/prompt_async$/))) {
      await readBody(req);
      runPrompt(m[1]);
      // 200+JSON, not 204: Chrome logs ERR_ABORTED on preflighted CORS
      // POSTs answered 204 (fetch resolves fine, the network log cries).
      json(res, 200, {});
      return;
    }
    if ((m = path.match(/^\/session\/([^/]+)\/(abort|command|summarize)$/))) {
      await readBody(req);
      json(res, 200, {});
      return;
    }
    if ((m = path.match(/^\/api\/session\/([^/]+)\/(agent|model)$/))) {
      await readBody(req);
      json(res, 200, {});
      return;
    }
    if ((m = path.match(/^\/(permission|question)\/([^/]+)\/(reply|reject)$/))) {
      await readBody(req);
      json(res, 200, {});
      return;
    }
    json(res, 404, { error: `no route ${path}` });
    return;
  }

  if (method === "PATCH" || method === "DELETE") {
    json(res, 200, {});
    return;
  }
  json(res, 404, { error: `no route ${method} ${path}` });
});

server.on("error", (err) => {
  console.error(`fake-api: ${err.message}`);
  process.exit(1);
});
server.listen(port, () => {
  // No trailing slash: the rig adopts this URL verbatim as the API base.
  console.log(`READY http://localhost:${server.address().port}`);
  console.log(`WORKSPACE ${directory}`);
});
