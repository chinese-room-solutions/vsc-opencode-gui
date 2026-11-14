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
// FAKE_API_LONG=1 seeds 100 turns (200+ rows) so the v2 message page the
// endpoint serves (50) actually windows the transcript, and "Load older
// messages" needs its cursor walk (a page is 100). Default stays small:
// every other spec's session fits one page.
const SEED_TURNS = process.env.FAKE_API_LONG === "1" ? 100 : 12;
// FAKE_API_BLOCKED=1 rigs the parent session mid-turn, blocked on a live
// foreground sub-agent: the last turn's first task part reads running
// (vouching for child ses_child_1) and the status endpoints serve the
// parent busy — the fixture for sendPrompt's auto-background release.
const blocked = process.env.FAKE_API_BLOCKED === "1";
// FAKE_API_CHILD_PENDING=1 seeds the wire shape the stuck turn-mark
// misread: the parent busy mid-turn with its task part still "pending"
// (the running transition missed) while the child session works — the
// chip spins on the child's status, so "no progress" would be false.
const childPending = process.env.FAKE_API_CHILD_PENDING === "1";
// FAKE_API_CHILD_UNBOUND=1 seeds what a real v2 server serves for a
// foreground sub-agent mid-run: the task part "running" with empty
// metadata (the child's id rides only the ephemeral progress frame) while
// the child session works.
const childUnbound = process.env.FAKE_API_CHILD_UNBOUND === "1";
// FAKE_API_DUP_CHILD=1 seeds two live task parts bound to the SAME child
// session (a steer re-opening it, or the title fallback double-binding) —
// the roster must count the sub-agent once, not once per part.
const dupChild = process.env.FAKE_API_DUP_CHILD === "1";
// FAKE_API_CHILD_IDLE=1 drops the child from /api/session/active: a
// working sub-agent spins its parent's tab, so the tabsignal specs need it
// idle to see the seeded session's own turn end.
const childIdle = process.env.FAKE_API_CHILD_IDLE === "1";
// FAKE_API_STALLED=1 seeds the live turn with a "running" edit whose
// input never arrived — the wire shape a stalled provider stream leaves
// (v2 tool args stream as ephemeral deltas; the durable row keeps {}
// until they close) — and the status endpoints serve the session busy.
const stalled = process.env.FAKE_API_STALLED === "1";
// FAKE_API_SHELL=1 seeds a running native shell row (live tail + stop
// specs) plus a durable running row whose shell no server holds (the
// restart-healing spec). See the registry after the SSE plumbing.
const shellMode = process.env.FAKE_API_SHELL === "1";
// FAKE_API_SKILL=1 appends a completed skill tool call to the last turn:
// the pill names the skill (input.name, metadata.name, or the title).
const skillMode = process.env.FAKE_API_SKILL === "1";
// FAKE_API_LONG_P1=1 appends turn 2's long tail to turn 1's prompt too —
// a long FIRST pill, the sub-agent spawn-prompt shape (expand-at-the-
// origin pin repros need an expandable pill at the transcript origin).
const longP1 = process.env.FAKE_API_LONG_P1 === "1";
// FAKE_API_GHOST=1 seeds a dead turn's fingerprint: the last assistant
// row holds a bash tool part still status "running" with an old start
// stamp (what the v2 store keeps when a turn dies without terminal tool
// events — an interrupt, a server restart), while the status endpoints
// serve the session idle. The UI must read the row as settled and must
// not re-animate it (running visuals, a large elapsed) when the next
// prompt flips the session busy.
const ghost = process.env.FAKE_API_GHOST === "1";
// FAKE_API_INBOX=1 admits v2 prompts the way 2.x does onto a running
// session: into the inbox. The POST replies the admitted row, but the
// message page serves nothing until the next step boundary delivers it
// (/__control/deliver-inbox), under the same id and admission time.
const inboxMode = process.env.FAKE_API_INBOX === "1";

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
  "Nested fence:",
  "",
  "````markdown",
  "# Doc",
  "",
  "```js",
  "console.log(1)",
  "```",
  "",
  "tail line",
  "````",
  "",
  "Quote with code:",
  "",
  "> quote intro",
  ">",
  "> ```go",
  "> func main() {}",
  "> ```",
  "",
  "And an `inlineSpan(42)` in prose.",
].join("\n");

const seedRows = [];
for (let i = 1; i <= SEED_TURNS; i++) {
  const cu = T0 + (i - 1) * 8_000;
  // Turn 11's prompt ends in a directory @-mention (x-directory part) so
  // the rig can exercise dir pills — they open with the OS tool, not the
  // editor. The last turn's prompt ends in a file @-mention (with its
  // durable file part) for the regular pills.
  const userText =
    `Question ${i}: ${filler(i * 3, 1)}` +
    // Turn 2's prompt runs long: the pin bar specs fold and expand it.
    // FAKE_API_LONG_P1 gives turn 1 the same tail (long first pill).
    (i === 2 || (longP1 && i === 1) ? `\n\n${filler(2, 6)}` : "") +
    (i === SEED_TURNS ? " Tune @src/retry.ts please" : "") +
    (i === SEED_TURNS - 1 ? " Browse @docs/ too" : "") +
    // Turn 9's prompt mentions an image the server inlined as a data:
    // part without a source — resourcedParts must re-derive the pill.
    (i === SEED_TURNS - 2 ? " Shot @picks/5.png here" : "");
  seedRows.push({
    id: `msg_u${i}`,
    type: "user",
    time: { created: cu, completed: cu + 200 },
    text: userText,
    ...(i === SEED_TURNS - 2
      ? {
          content: [
            {
              type: "file",
              id: `pt_u${i}img`,
              mime: "image/jpeg",
              url: "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEA",
            },
          ],
        }
      : {}),
    ...(i === SEED_TURNS - 1
      ? {
          content: [
            {
              type: "file",
              id: `pt_u${i}d`,
              mime: "application/x-directory",
              url: "file:///repo/docs/",
              source: {
                type: "file",
                path: "/repo/docs/",
                text: {
                  value: "@docs/",
                  start: userText.indexOf("@docs/"),
                  end: userText.indexOf("@docs/") + 6,
                },
              },
            },
          ],
        }
      : {}),
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
  // The second-to-last turn carries the v2 wire-shape file tools (edit
  // FileDiff.Info in metadata.files, apply_patch spanning files, a write
  // with no diff) — turn 12's height must stay untouched: the pin specs
  // hinge on its pill staying inside one viewport at bottom scroll.
  const v2FileTools =
    i === SEED_TURNS - 1
      ? [
          {
            type: "tool",
            id: "pt_te2",
            name: "edit",
            state: {
              status: "completed",
              input: { filePath: "src/webview/app/store.ts" },
              metadata: {
                files: [
                  {
                    file: "src/webview/app/store.ts",
                    patch: "--- a/src/webview/app/store.ts\n+++ b/src/webview/app/store.ts\n@@ -1,2 +1,3 @@\n const a = 1\n+const b = 2\n const c = 3",
                    additions: 1,
                    deletions: 0,
                    status: "modified",
                  },
                ],
              },
              output: "Edited src/webview/app/store.ts (1 replacement)",
              time: { start: ca + 1_200, end: ca + 1_400 },
            },
          },
          {
            type: "tool",
            id: "pt_tap1",
            name: "apply_patch",
            state: {
              status: "completed",
              input: { patch: "*** Begin Patch\n*** End Patch" },
              metadata: {
                files: [
                  {
                    file: "docs/a.md",
                    patch: "--- a/docs/a.md\n+++ b/docs/a.md\n@@ -1,1 +1,2 @@\n+added line\n",
                    additions: 1,
                    deletions: 0,
                    status: "modified",
                  },
                  {
                    file: "docs/b.md",
                    patch: "--- a/docs/b.md\n+++ b/docs/b.md\n@@ -1,2 +1,1 @@\n-removed line\n rest",
                    additions: 0,
                    deletions: 1,
                    status: "modified",
                  },
                ],
              },
              output: "Success. Updated the following files: docs/a.md, docs/b.md",
              time: { start: ca + 1_500, end: ca + 1_900 },
            },
          },
          {
            type: "tool",
            id: "pt_tw1",
            name: "write",
            state: {
              status: "completed",
              input: { path: "notes.md", content: "# Notes\n" },
              output: "Wrote notes.md",
              time: { start: ca + 2_000, end: ca + 2_200 },
            },
          },
        ]
      : [];
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
            state: blocked
              ? {
                  status: "running",
                  input: { description: "Check the retry paths", subagent_type: "general" },
                  metadata: { sessionId: "ses_child_1" },
                  time: { start: ca + 8_600 },
                }
              : childPending
                ? {
                    status: "pending",
                    input: { description: "Check the retry paths", subagent_type: "general" },
                    metadata: { sessionId: "ses_child_1" },
                    time: { start: ca + 8_600 },
                  }
                : childUnbound
                  ? {
                      status: "running",
                      input: { description: "Check the retry paths", subagent_type: "general" },
                      metadata: {},
                      time: { start: ca + 8_600 },
                    }
                : {
                    status: "completed",
                    input: { description: "Check the retry paths", subagent_type: "general" },
                    ...(dupChild ? { metadata: { sessionId: "ses_child_1" } } : {}),
                    output: "done",
                    time: { start: ca + 8_600, end: ca + 9_400 },
                  },
          },
          {
            type: "tool",
            id: "pt_task2",
            name: "task",
            state: dupChild
              ? {
                  status: "running",
                  input: { description: "Check the retry paths", subagent_type: "general" },
                  metadata: { sessionId: "ses_child_1" },
                  time: { start: ca + 10_600 },
                }
              : {
                  status: "completed",
                  input: {
                    description: "Explore the attribution retry paths",
                    subagent_type: "oc-model-ai-gateway-fireworks-glm-5-3-flash",
                  },
                  output: "done",
                  time: { start: ca + 9_600, end: ca + 10_400 },
                },
          },
          ...(stalled
            ? [
                {
                  type: "tool",
                  id: "pt_tstall",
                  name: "edit",
                  state: {
                    status: "running",
                    input: {},
                    time: { start: ca + 10_600 },
                  },
                },
              ]
            : []),
          ...(skillMode
            ? [
                {
                  type: "tool",
                  id: "pt_tskill",
                  name: "skill",
                  state: {
                    status: "completed",
                    input: { name: "concise" },
                    output: '<skill_content name="concise">\n# Skill: concise\n</skill_content>',
                    title: "Loaded skill: concise",
                    metadata: { name: "concise", dir: "/skills/concise" },
                    time: { start: ca + 10_800, end: ca + 11_000 },
                  },
                },
              ]
            : []),
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
      ...v2FileTools,
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

// FAKE_API_SHELL's restart-healing half: a durable running shell row
// whose shell id no registry ever held — what a server restart leaves.
if (shellMode)
  seedRows.push({
    id: "msg_shell_gone",
    type: "shell",
    status: "running",
    shellID: "shl_gone_1",
    command: "cargo build",
    time: { created: T0 + 2_000 },
  });

// FAKE_API_GHOST's dead turn: a trailing user prompt + assistant row
// whose only content is a still-"running" bash part started long ago
// (the durable shape a killed turn leaves behind — wire-verified against
// a real 2.0.26 store). The session serves idle.
if (ghost) {
  const gu = T0 + SEED_TURNS * 8_000;
  const ga = gu + 1_500;
  const gStart = Date.now() - 15 * 60_000;
  seedRows.push({
    id: "msg_uguost",
    type: "user",
    time: { created: gu, completed: gu + 200 },
    text: "Run the watch task",
  });
  seedRows.push({
    id: "msg_aghost",
    type: "assistant",
    time: { created: ga },
    agent: "build",
    model: { id: "fake-model", providerID: "fake" },
    content: [
      {
        type: "tool",
        id: "pt_tghost",
        name: "bash",
        time: { created: gStart, ran: gStart },
        state: {
          status: "running",
          input: { command: "npm run watch" },
          metadata: { output: "" },
        },
      },
    ],
  });
}

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

// A spawned sub-agent child of the seeded session, still working: the
// durable task chip ("Check the retry paths", turn 12) resolves it by
// parentID + title prefix and vouches for liveness through the child's
// busy status — the running chip sendPrompt's background release answers.
const childRow = {
  id: "ses_child_1",
  parentID: SESSION_ID,
  title: "Check the retry paths (@general subagent)",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 }, total: 0 },
  time: { created: T0 + 60_000, updated: Date.now() },
  location: { directory },
  agent: "general",
};

// FAKE_API_HOME_LIST=1: extra listable sessions across a second project
// folder — the navigator's multiselect specs need several rows in both
// sections.
// FAKE_API_PAGINATE=1 grows the list past the store's page size (50):
// /api/session serves a full first page plus a cursor, the rest on the
// cursor page — the "Load older sessions" path. =2 seeds two full pages
// plus a 3-row tail (three cursor pages) — the scroll auto-load path.
// Flat order (updated desc) is stable: seeded first, then the bulk rows
// newest-first.
const paginate = Number(process.env.FAKE_API_PAGINATE) || 0;
const extraSessions =
  process.env.FAKE_API_HOME_LIST === "1" || paginate
    ? Array.from({
        length: paginate >= 2 ? 102 : paginate ? 52 : 6,
      }, (_, i) => ({
        id: `ses_bulk_${i + 1}`,
        title: `Bulk session ${i + 1}`,
        cost: 0,
        tokens: {
          input: 10,
          output: 20,
          reasoning: 0,
          cache: { read: 0, write: 0 },
          total: 30,
        },
        time: {
          created: T0 + 120_000 + i * 8_000,
          updated: T0 + 130_000 + i * 8_000,
        },
        location: { directory: i < 3 ? directory : `${directory}-other` },
        agent: "build",
        model: { id: "fake-model", providerID: "fake" },
      }))
    : [];
const sessionList = [sessionRow, childRow, ...extraSessions];

// /find/file seeds — the @-menu's autocomplete and the composer's chip
// verification both hit the endpoint. Case-insensitive substring match,
// like a fuzzy finder; directories keep the platform trailing "/".
const FIND_FILES = ["picks/config.json", "docs/", "src/retry.ts", "README.md", "package.json"];

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
// /api/event connections served — specs watch it climb to see the host
// pump reconnect (and the resync that follows it).
let eventConns = 0;
setInterval(() => {
  for (const res of v2Clients) res.write(": ping\n\n");
  for (const res of v1Clients) res.write(": ping\n\n");
}, 15_000).unref();

// --- FAKE_API_SHELL registry ---
// The live shell reveals one chunk per output poll (byte-cursor semantics
// on the concatenated text), mirroring a command whose output grows. A
// kill freezes it and emits the ended frame; unknown ids 404.
const shellChunks = ["watching for changes...\n", "rebuilt src/main.ts\n"];
const liveShell = { id: "shl_live_1", command: "npm run watch", status: "running", served: 0 };
const shellDeletes = [];
// Permission answers (dock-keys spec): {id, decision, message} per reply,
// from either dialect's reply route.
const permReplies = [];
// Live v2 asks, served by the per-session permission GET until replied —
// the real server's contract. A resync adopts that list as truth, so an
// ask known only from its SSE event vanished whenever one landed after it.
let liveAsks = [];
const shellText = () => shellChunks.slice(0, liveShell.served).join("");
const shellStartedFrame = () =>
  writeFrame(v2Clients, {
    id: "evt_shell_live",
    type: "session.shell.started",
    data: {
      sessionID: SESSION_ID,
      timestamp: Date.now(),
      shell: { id: liveShell.id, command: liveShell.command, status: "running" },
    },
  });

// --- synthetic streaming ---
let streamCount = 0;
// Wire-action records for the specs: session id + body text, stamped with
// a shared monotonic seq so tests can assert ordering ACROSS the two
// (background must precede the prompt it unblocks).
let recSeq = 0;
const backgroundCalls = [];
const promptCalls = [];
// FAKE_API_INBOX's held prompts, oldest first.
const inbox = [];
// One-shot failure for the next prompt POST (either dialect's send route):
// the failed-send take-back spec arms it via /__control/fail-next-prompt.
let failNextPrompt = false;
// The most recent scripted prompt turn (runPrompt), for specs that
// compare the rendered transcript against the wire truth.
let lastPrompt = null;
// One-shot reply script for the next runPrompt ({text, chars}), armed via
// /__control/next-reply: the turn streams exactly this text instead of
// the filler sentences.
let nextReply = null;
const timers = new Set();
function later(fn, ms) {
  const t = setTimeout(() => {
    timers.delete(t);
    fn();
  }, ms);
  timers.add(t);
  return t;
}// Grow a text part over the v1 stream (message.part.delta), then call onDone.
function streamText(sid, messageID, partID, { first = 100, count, chars, interval = 150, source, onChunk, onDone }) {
  streamCount++;
  let s = Math.floor(Math.random() * SENTENCES.length);
  let tick = 0;
  const step = () => {
    // One delta per tick: the next `chars` of a scripted `source`, else
    // ~`chars` of sentences with a paragraph break every 4th delta.
    let delta = "";
    if (source !== undefined) delta = source.slice(tick * chars, (tick + 1) * chars);
    else {
      while (delta.length < chars) delta += sentence(s++) + " ";
      if (tick % 4 === 3) delta += "\n\n";
    }
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

// v2 twin of streamText: same pacing, deltas on the v2 turn dialect
// (session.text.delta on /api/event, the part addressed as
// assistantMessageID + ordinal-within-kind).
function streamTextV2(sid, messageID, { first = 100, count, chars, interval = 150, onChunk, onDone }) {
  streamCount++;
  let s = Math.floor(Math.random() * SENTENCES.length);
  let tick = 0;
  const step = () => {
    let delta = "";
    while (delta.length < chars) delta += sentence(s++) + " ";
    if (tick % 4 === 3) delta += "\n\n";
    emitV2("session.text.delta", { sessionID: sid, assistantMessageID: messageID, ordinal: 0, delta });
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

// Reasoning twin of streamTextV2: same pacing, deltas on the reasoning
// family (session.reasoning.delta; ordinals count within their own kind,
// so the think and the answer are both ordinal 0).
function streamReasoningV2(sid, messageID, { first = 100, count, chars, interval = 150, onChunk, onDone }) {
  streamCount++;
  let s = Math.floor(Math.random() * SENTENCES.length);
  let tick = 0;
  const step = () => {
    let delta = "";
    while (delta.length < chars) delta += sentence(s++) + " ";
    if (tick % 4 === 3) delta += "\n\n";
    emitV2("session.reasoning.delta", { sessionID: sid, assistantMessageID: messageID, ordinal: 0, delta });
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

// v2 twin of runPrompt: the prompt POST's reply carries the admitted user
// row (api.ts promptSession upserts it in place of the optimistic echo),
// then the turn runs on the v2 dialect — execution.started (busy),
// step.started (the assistant row), a thinking phase (reasoning.started,
// reasoning deltas ordinal 0, reasoning.ended) before the answer, text
// deltas on (assistantMessageID, ordinal), text.ended, step.ended,
// execution.succeeded (idle) — the whole turn runs ~17 s. Rows track into
// the v2 message page so the busy refresh and a mid-turn reload see them.
function runPromptV2(sid, text) {
  const n = nextTurn++;
  const t = Date.now();
  const u = `msg_u${n}`;
  const a = `msg_a${n}`;
  const pt = `pt_a${n}`;
  const pr = `pr_a${n}`;
  stepsRows = [];
  trackInfo({ id: u, role: "user", time: { created: t } });
  trackPart({ id: `${u}:text`, messageID: u, sessionID: sid, type: "text", text });
  later(() => emitV2("session.execution.started", { sessionID: sid }), 150);
  later(() => {
    emitV2("session.step.started", {
      sessionID: sid,
      assistantMessageID: a,
      agent: "build",
      model: { providerID: "fake", id: "fake-model" },
      started: t,
    });
    trackInfo({ id: a, role: "assistant", time: { created: Date.now() }, agent: "build", modelID: "fake-model", providerID: "fake" });
  }, 300);
  // Thinking first: reasoning.started projects nothing (the part spawns on
  // its first delta), the think streams ~6 s, reasoning.ended carries the
  // full text, then the answer phase starts.
  later(() => {
    emitV2("session.reasoning.started", { sessionID: sid, assistantMessageID: a, ordinal: 0 });
    trackPart({ id: pr, messageID: a, sessionID: sid, type: "reasoning", text: "" });
  }, 380);
  const think = [];
  streamReasoningV2(sid, a, {
    first: 2000,
    count: 40,
    chars: 170,
    onChunk: (delta) => {
      think.push(delta);
      trackText(a, pr, delta);
    },
    onDone: () => {
      emitV2("session.reasoning.ended", { sessionID: sid, assistantMessageID: a, ordinal: 0, text: think.join("") });
      later(() => {
        emitV2("session.text.started", { sessionID: sid, assistantMessageID: a, ordinal: 0 });
        trackPart({ id: pt, messageID: a, sessionID: sid, type: "text", text: "" });
      }, 150);
      const full = [];
      streamTextV2(sid, a, {
        first: 2000,
        count: 44,
        chars: 170,
        onChunk: (delta) => {
          full.push(delta);
          trackText(a, pt, delta);
        },
        onDone: () => {
          lastPrompt = { sessionID: sid, messageID: a, partID: pt, text: full.join(""), reasoning: think.join("") };
          emitV2("session.text.ended", { sessionID: sid, assistantMessageID: a, ordinal: 0, text: full.join("") });
          later(() => emitV2("session.step.ended", {
            sessionID: sid,
            assistantMessageID: a,
            finish: "stop",
            cost: 0.001,
            tokens: { input: 120, output: 4000, reasoning: 0, cache: { read: 0, write: 0 } },
            timestamp: Date.now(),
          }), 100);
          later(() => emitV2("session.execution.succeeded", { sessionID: sid }), 250);
        },
      });
    },
  });
  return { user: { id: u, created: t, text } };
}

// POST /session/:id/prompt_async — durable user row, assistant row, growing
// text part, completion, idle. The first delta is delayed so the pinned
// prompt's hold window (everything on screen, dist <= 0) is observable.
let nextTurn = SEED_TURNS + 1;
function runPrompt(sid, text = "") {
  const n = nextTurn++;
  const t = Date.now();
  const u = `msg_u${n}`;
  const a = `msg_a${n}`;
  const pt = `pt_a${n}`;
  // Track alongside the emits (runSteps' pattern): the app re-pulls the
  // message page while the session reads busy — a mid-turn reload must see
  // the in-flight rows or the fresh page drops the turn and every later
  // delta lands on a row it doesn't know. No reset: earlier scripted turns
  // stay in the page like durable rows would.
  later(() => {
    const info = { id: u, role: "user", time: { created: t } };
    emitV1("message.updated", { sessionID: sid, info });
    trackInfo(info);
    trackPart({ id: `${u}:text`, messageID: u, sessionID: sid, type: "text", text });
  }, 150);
  later(() => {
    const info = { id: a, role: "assistant", time: { created: t + 200 }, providerID: "fake", modelID: "fake-model", agent: "build" };
    emitV1("message.updated", { sessionID: sid, info });
    trackInfo(info);
  }, 300);
  later(() => {
    const part = { id: pt, messageID: a, sessionID: sid, type: "text", text: "" };
    emitV1("message.part.updated", { sessionID: sid, part });
    trackPart(part);
  }, 380);
  const full = [];
  const script = nextReply;
  nextReply = null;
  const chars = script?.chars ?? 170;
  streamText(sid, a, pt, {
    first: 2000,
    count: script ? Math.ceil(script.text.length / chars) : 44,
    chars,
    source: script?.text,
    onChunk: (delta) => {
      full.push(delta);
      trackText(a, pt, delta);
    },
    onDone: () => {
      lastPrompt = { sessionID: sid, messageID: a, partID: pt, text: full.join("") };
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
    eventConns += 1;
    res.writeHead(200, { ...CORS, "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    v2Clients.add(res);
    if (shellMode) shellStartedFrame();
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
    if (method === "GET" && path === "/__control/last-prompt") {
      json(res, 200, lastPrompt);
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
    if (method === "GET" && path === "/__control/background") {
      json(res, 200, { calls: backgroundCalls });
      return;
    }
    // An inbound peer note on the real 2.1 wire: the injection lands as a
    // session.inbox.enqueued envelope (inboxID = the durable row id, the
    // note in item.payload) — the shape captured live from a real serve.
    if (method === "POST" && path === "/__control/peer-note") {
      const body = await readBody(req);
      emitV2("session.inbox.enqueued", {
        sessionID: SESSION_ID,
        inboxID: body.inboxID ?? "msg_peerlive1",
        item: {
          type: "synthetic",
          payload: {
            text: body.text ?? "Ping from the peer rig.",
            metadata: {
              peerMessage: {
                version: 2,
                messageId: body.messageId ?? "pm-rig-1",
                fromEndpointId: body.from ?? "ses_fakesender0000000000000",
                toSessionId: SESSION_ID,
              },
            },
          },
        },
      });
      json(res, 200, { ok: true });
      return;
    }
    // A manual /compact turn lands live on the v2 wire: the trigger row
    // (role user, no auto flag), its compaction part, then the summary
    // row — the shape a real compaction streams, row first, part second.
    // afterTurn=N stamps it between turn N and N+1, mid-transcript.
    if (method === "POST" && path === "/__control/compaction") {
      const body = await readBody(req);
      const created =
        typeof body.afterTurn === "number"
          ? T0 + (body.afterTurn - 1) * 8_000 + 6_000
          : Date.now();
      emitV2("message.updated", {
        sessionID: SESSION_ID,
        info: { id: "msg_compac_u", role: "user", time: { created } },
      });
      emitV2("message.part.updated", {
        sessionID: SESSION_ID,
        part: {
          id: "msg_compac_u:cp",
          messageID: "msg_compac_u",
          sessionID: SESSION_ID,
          type: "compaction",
        },
      });
      emitV2("message.updated", {
        sessionID: SESSION_ID,
        info: {
          id: "msg_compac_a",
          role: "assistant",
          agent: "compaction",
          time: { created: created + 40, completed: created + 90 },
          model: { id: "fake-model", providerID: "fake" },
        },
      });
      emitV2("message.part.updated", {
        sessionID: SESSION_ID,
        part: {
          id: "msg_compac_a:t",
          messageID: "msg_compac_a",
          sessionID: SESSION_ID,
          type: "text",
          text: body.text ?? "Older turns folded away.",
          time: { start: created + 40, end: created + 90 },
        },
      });
      json(res, 200, { ok: true });
      return;
    }
    // A permission ask on the v2 wire: permission.asked carries {id,
    // sessionID, action} — the shape v2events maps onto the dock. The spec
    // picks the asking session, so one control can target this tab's
    // session or another one's.
    if (method === "POST" && path === "/__control/ask") {
      const body = await readBody(req);
      const ask = {
        id: body.id ?? "perm_rig1",
        sessionID: body.sessionID ?? SESSION_ID,
        action: body.action ?? "bash",
        resources: Array.isArray(body.resources) ? body.resources : [],
        save: Array.isArray(body.save) ? body.save : [],
      };
      liveAsks = liveAsks.filter((a) => a.id !== ask.id).concat(ask);
      emitV2("permission.asked", ask);
      json(res, 200, { ok: true });
      return;
    }
    // A shell lifecycle note / restart note on the same envelope — the
    // server's terminal report for a shell run (metadata.source "shell",
    // <shell…> wrapper around the captured bytes) and its restart notice
    // (metadata.notice "restart"). The shell payload stacks two repaint
    // frames, like a captured gh run watch.
    if (method === "POST" && path === "/__control/shell-note") {
      const body = await readBody(req);
      const frame = (step) =>
        [
          "Refreshing run status every 3 seconds. Press Ctrl+C to quit.",
          "v0.1.1 release · 41234939455",
          "JOBS",
          `release (ID 124636603351)`,
          `  ${step} Run npm ci`,
        ].join("\n");
      // A longer capture for the fold spec: N filler lines appended to
      // the current frame, past the shell-out box's 5-line clamp budget.
      const extra =
        typeof body.lines === "number" && body.lines > 0
          ? `\n${Array.from(
              { length: body.lines },
              (_, i) => `long-capture line ${i + 1}`,
            ).join("\n")}`
          : "";
      const payload =
        body.kind === "restart"
          ? {
              text: "The server restarted while you were working. Continue from where you left off without repeating completed work.",
              metadata: { notice: "restart" },
            }
          : {
              text: `<shell id="sh_rig1" state="completed" command="gh run watch 41234939455 --exit-status">\n${frame("*")}\n\n${frame("✓")}${extra}\n</shell>`,
              description: "gh run watch 41234939455 --exit-status",
              metadata: {
                source: "shell",
                shellID: "sh_rig1",
                state: "completed",
                exit: 0,
                truncated: false,
              },
            };
      emitV2("session.inbox.enqueued", {
        sessionID: SESSION_ID,
        inboxID: body.inboxID ?? (body.kind === "restart" ? "msg_restart1" : "msg_shellnote1"),
        item: { type: "synthetic", payload },
      });
      json(res, 200, { ok: true });
      return;
    }
    if (method === "GET" && path === "/__control/shell") {
      json(res, 200, { deletes: shellDeletes });
      return;
    }
    if (method === "GET" && path === "/__control/perm-replies") {
      json(res, 200, { replies: permReplies });
      return;
    }
    // Spec levers for the stalled-tool shape: deliver one arg delta to the
    // stalled part (the stream is alive again), or drop every v2 SSE
    // connection (the host pump reconnects and resyncs, which wipes the
    // streamed-args preview — the false-alarm regression).
    if (method === "GET" && path === "/__control/argdelta") {
      emitV2("session.next.tool.input.delta", {
        sessionID: SESSION_ID,
        assistantMessageID: lastSeedAssistant,
        callID: "pt_tstall",
        delta: '{"filePath":"/src/main.ts"',
      });
      json(res, 200, { ok: true });
      return;
    }
    if (method === "GET" && path === "/__control/ssedrop") {
      for (const r of v2Clients) r.end();
      json(res, 200, { dropped: v2Clients.size });
      return;
    }
    if (method === "GET" && path === "/__control/eventconns") {
      json(res, 200, { connections: eventConns });
      return;
    }
    if (method === "GET" && path === "/__control/prompts") {
      json(res, 200, { calls: promptCalls });
      return;
    }
    // FAKE_API_INBOX's step boundary: every held prompt becomes its message
    // row and the next step starts answering — the model starts to respond.
    if (method === "POST" && path === "/__control/deliver-inbox") {
      await readBody(req);
      const items = inbox.splice(0);
      for (const it of items) {
        // A v2 user row carries its text on the row, not in content.
        trackInfo({ id: it.id, role: "user", time: { created: it.created } });
        stepsRows.find((r) => r.id === it.id).text = it.text;
        emitV2("session.inbox.delivered", { sessionID: it.sessionID, inboxID: it.id });
      }
      if (items.length) {
        const sid = items[0].sessionID;
        const n = nextTurn++;
        const a = `msg_a${n}`;
        const pt = `pt_a${n}`;
        const t = Date.now();
        emitV2("session.step.started", {
          sessionID: sid,
          assistantMessageID: a,
          agent: "build",
          model: { providerID: "fake", id: "fake-model" },
          started: t,
        });
        trackInfo({ id: a, role: "assistant", time: { created: t }, agent: "build", modelID: "fake-model", providerID: "fake" });
        emitV2("session.text.started", { sessionID: sid, assistantMessageID: a, ordinal: 0 });
        trackPart({ id: pt, messageID: a, sessionID: sid, type: "text", text: "" });
        streamTextV2(sid, a, { first: 200, count: 200, chars: 60, onChunk: (d) => trackText(a, pt, d) });
      }
      json(res, 200, { delivered: items.map((i) => i.id) });
      return;
    }
    // The failed-send take-back's lever: the NEXT prompt POST answers 500
    // ({message} — the shape the relay reads a reason from), then normal
    // behavior resumes — the retry goes through with its scripted turn.
    if (method === "POST" && path === "/__control/fail-next-prompt") {
      await readBody(req);
      failNextPrompt = true;
      json(res, 200, { ok: true });
      return;
    }
    if (method === "POST" && path === "/__control/next-reply") {
      const body = await readBody(req);
      if (typeof body.text !== "string" || !body.text) {
        json(res, 400, { error: "text required" });
        return;
      }
      nextReply = { text: body.text, chars: Math.max(1, body.chars ?? 170) };
      json(res, 200, { ok: true });
      return;
    }
    json(res, 404, { error: "no such control" });
    return;
  }

  // v2's background conversion: records the call, answers like the real
  // server (204; idle sessions are a no-op there).
  if (method === "POST" && /^\/api\/session\/[^/]+\/background\/?$/.test(path)) {
    backgroundCalls.push({
      sessionID: path.split("/")[3],
      at: Date.now(),
      seq: ++recSeq,
    });
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  // boot / reads
  if (method === "GET") {
    if (path === "/session/status") { json(res, 200, { [SESSION_ID]: { type: stepsActive || blocked || stalled || childPending || childUnbound || dupChild ? "busy" : "idle" } }); return; }
    // v2: the child is mid-run — the seeded session itself stays idle so
    // the chip's running state comes from the child, not the parent,
    // except in the blocked rig (parent mid-turn on that child).
    if (path === "/api/session/active") {
      json(res, 200, {
        data: {
          ...(childIdle ? {} : { ses_child_1: { agent: "general" } }),
          ...((blocked || stalled || childPending || childUnbound || dupChild) ? { [SESSION_ID]: { agent: "build" } } : {}),
        },
      });
      return;
    }
    if (path === "/api/session") {
      if (paginate) {
        const cur = url.searchParams.get("cursor");
        const start = cur === "page2" ? 50 : cur === "page3" ? 100 : 0;
        const next = start === 0 ? "page2" : start === 50 ? "page3" : undefined;
        json(res, 200, {
          data: sessionList.slice(start, start + 50),
          cursor: next ? { next } : {},
        });
        return;
      }
      json(res, 200, { data: sessionList, cursor: {} });
      return;
    }
    // v2 twins of the v1 boot routes (same seeds, the app's v2 shapes):
    // /api/provider+model+config assemble the picker catalog, /api/agent
    // the agent list, /api/command+/api/skill the slash registry,
    // /api/project the Home list (bare array there, {data} elsewhere).
    if (path === "/api/provider") { json(res, 200, { data: [{ id: "fake", name: "Fake Labs" }] }); return; }
    if (path === "/api/model") {
      json(res, 200, {
        data: [
          { id: "fake-model", providerID: "fake", name: "Fake Model", capabilities: { tools: true, input: ["text", "image", "pdf"] }, variants: [{ id: "default" }, { id: "high" }], limit: { context: 200_000 } },
          { id: "fake-audio", providerID: "fake", name: "Fake Audio", capabilities: { tools: true, input: ["text", "audio"] }, variants: [{ id: "default" }], limit: { context: 100_000 } },
        ],
      });
      return;
    }
    if (path === "/api/config") { json(res, 200, [{ info: { model: { providerID: "fake", model: "fake-model" } } }]); return; }
    if (path === "/api/agent") {
      json(res, 200, {
        data: [
          { id: "build", name: "Build", description: "Write code", mode: "primary" },
          { id: "plan", name: "Plan", description: "Plan first", mode: "primary" },
          { id: "general", name: "General", description: "Sub-agent", mode: "subagent" },
        ],
      });
      return;
    }
    if (path === "/api/command") { json(res, 200, { data: [] }); return; }
    if (path === "/api/skill") { json(res, 200, { data: [] }); return; }
    if (path === "/api/project") { json(res, 200, [{ id: "prj_1", worktree: directory, canonical: directory, icon: { color: "pink" }, time: { created: T0, updated: T0 } }]); return; }
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
            // Third row so picker specs can arrow past a filter (2 rows kept
            // out of 3).
            "fake-mini": {
              name: "Fake Mini",
              limit: { context: 64_000 },
              capabilities: { input: { text: true, image: false, pdf: false, audio: false, video: false } },
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
    if (path === "/api/permission/request") { json(res, 200, { data: [] }); return; }
    if (path === "/question") { json(res, 200, []); return; }
    if (path === "/find/file") {
      const q = (url.searchParams.get("query") ?? "").toLowerCase();
      json(res, 200, FIND_FILES.filter((f) => f.toLowerCase().includes(q)));
      return;
    }
    let m;
    // v2 single-session GET: fetchSession reads it to tell a restored
    // route a dead id (404 = missing) — serve the seeded row like the
    // real server would.
    if ((m = path.match(/^\/api\/session\/([^/]+)$/)) && m[1] !== "active") {
      json(res, 200, { data: sessionRow });
      return;
    }
    if (path === "/api/shell") {
      json(res, 200, {
        data:
          liveShell.status === "running"
            ? [{ id: liveShell.id, command: liveShell.command, status: "running" }]
            : [],
      });
      return;
    }
    if ((m = path.match(/^\/api\/shell\/([^/]+)\/output$/))) {
      if (m[1] !== liveShell.id) {
        json(res, 404, { error: `no shell ${m[1]}` });
        return;
      }
      if (liveShell.status === "running")
        liveShell.served = Math.min(liveShell.served + 1, shellChunks.length);
      const full = shellText();
      const cursor = Math.max(
        0,
        Math.min(Number(url.searchParams.get("cursor") ?? "0") || 0, full.length),
      );
      json(res, 200, {
        data: { output: full.slice(cursor), cursor: full.length, size: full.length, truncated: false },
      });
      return;
    }
    // v2 inbox: admitted, undelivered work (FAKE_API_INBOX's held prompts).
    if ((m = path.match(/^\/api\/session\/([^/]+)\/inbox$/))) {
      json(res, 200, {
        data: inbox
          .filter((it) => it.sessionID === m[1])
          .map((it) => ({
            id: it.id,
            sessionID: it.sessionID,
            time: { created: it.created },
            type: "user",
            payload: { text: it.text },
            delivery: "steer",
          })),
      });
      return;
    }
    if ((m = path.match(/^\/api\/session\/([^/]+)\/message$/))) {
      // v2 page, paged like 2.0.26: limit (default 50, max 200 — above it
      // the endpoint 400s, it does not clamp), order asc|desc, and an
      // opaque base64url cursor {id, order, direction}. A cursor walks
      // rows after (next) or before (previous) its anchor; a page short
      // of the limit is the only "transcript complete" signal, and
      // cursor.next rides every non-empty page. The client re-sorts, so
      // only the row set and count matter — order is served anyway.
      const all = [...seedRows, ...stepsRows].sort(
        (a, b) => a.time.created - b.time.created || (a.id < b.id ? -1 : 1),
      );
      const limitRaw = Number(url.searchParams.get("limit") ?? "50") || 50;
      if (limitRaw > 200) {
        json(res, 400, {
          _tag: "InvalidRequestError",
          message: 'Expected a value less than or equal to 200\n  at ["limit"]',
          kind: "Query",
        });
        return;
      }
      const limit = Math.max(1, limitRaw);
      let order = url.searchParams.get("order") ?? "desc";
      let direction = "next";
      let anchor = -1;
      const raw = url.searchParams.get("cursor");
      if (raw) {
        try {
          const dec = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
          order = dec.order ?? order;
          direction = dec.direction ?? direction;
          anchor = all.findIndex((r) => r.id === dec.id);
        } catch {
          anchor = -1;
        }
      }
      if (raw && anchor < 0) {
        json(res, 200, { data: [], cursor: {} });
        return;
      }
      const eff = direction === "previous" ? (order === "asc" ? "desc" : "asc") : order;
      let page;
      if (anchor >= 0) {
        const before = all.slice(0, anchor);
        const after = all.slice(anchor + 1);
        page = eff === "asc" ? after.slice(0, limit) : before.slice(-limit).reverse();
      } else {
        page = eff === "asc" ? all.slice(0, limit) : all.slice(-limit).reverse();
      }
      if (direction === "previous") page.reverse();
      const last = page.at(-1);
      const enc = (row, dir) =>
        Buffer.from(JSON.stringify({ id: row.id, order, direction: dir })).toString("base64url");
      json(res, 200, {
        data: page,
        cursor: last ? { next: enc(last, "next") } : {},
      });
      return;
    }
    if ((m = path.match(/^\/api\/session\/([^/]+)\/(permission|question|form)$/))) {
      if (m[2] === "permission") {
        json(res, 200, { data: liveAsks.filter((a) => a.sessionID === m[1]) });
        return;
      }
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
    // The dock's answer (v2 asks reply on the per-session route): accepted
    // like the real server would — the app drops the ask optimistically,
    // but a 404 here would surface the failure banner in rig specs.
    if ((m = path.match(/^\/api\/session\/([^/]+)\/permission\/([^/]+)\/reply$/))) {
      const body = await readBody(req);
      liveAsks = liveAsks.filter((a) => a.id !== m[2]);
      permReplies.push({ id: m[2], decision: body.decision, message: body.message, at: Date.now() });
      json(res, 200, {});
      return;
    }
    if ((m = path.match(/^\/session\/([^/]+)\/prompt_async$/))) {
      const body = await readBody(req);
      if (failNextPrompt) {
        failNextPrompt = false;
        json(res, 500, { message: "Internal error" });
        return;
      }
      // Record the parts (the attach spec asserts the file:// swap);
      // promptCalls otherwise serves the v2 route below.
      promptCalls.push({
        sessionID: m[1],
        text: "",
        parts: Array.isArray(body.parts) ? body.parts : [],
        at: Date.now(),
        seq: ++recSeq,
      });
      const text = (Array.isArray(body.parts) ? body.parts : [])
        .filter((p) => p?.type === "text" && typeof p.text === "string")
        .map((p) => p.text)
        .join("");
      runPrompt(m[1], text);
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
    if ((m = path.match(/^\/api\/session\/([^/]+)\/prompt$/))) {
      const body = await readBody(req);
      if (failNextPrompt) {
        failNextPrompt = false;
        json(res, 500, { message: "Internal error" });
        return;
      }
      const text = typeof body.text === "string" ? body.text : "";
      promptCalls.push({
        sessionID: m[1],
        text,
        at: Date.now(),
        seq: ++recSeq,
      });
      if (inboxMode) {
        const item = {
          id: typeof body.id === "string" && body.id ? body.id : `msg_in${promptCalls.length}`,
          sessionID: m[1],
          text,
          created: Date.now(),
        };
        inbox.push(item);
        emitV2("session.inbox.enqueued", {
          sessionID: m[1],
          inboxID: item.id,
          item: { type: "user", payload: { text }, delivery: "steer" },
        });
        json(res, 200, {
          data: {
            id: item.id,
            sessionID: m[1],
            time: { created: item.created },
            type: "user",
            payload: { text },
            delivery: "steer",
          },
        });
        return;
      }
      // The scripted turn runs on the v2 dialect; the reply carries the
      // admitted user row (promptSession upserts it in place of the
      // optimistic echo). 200+JSON, not 204: Chrome logs ERR_ABORTED on
      // preflighted CORS POSTs answered 204 (fetch resolves fine, the
      // network log cries).
      const turn = runPromptV2(m[1], text);
      json(res, 200, {
        data: { id: turn.user.id, time: { created: turn.user.created }, payload: { text: turn.user.text } },
      });
      return;
    }
    if ((m = path.match(/^\/api\/session\/([^/]+)\/(agent|model)$/))) {
      await readBody(req);
      json(res, 200, {});
      return;
    }
    if ((m = path.match(/^\/(permission|question)\/([^/]+)\/(reply|reject)$/))) {
      const body = await readBody(req);
      if (m[1] === "permission")
        permReplies.push({ id: m[2], decision: body.reply, message: body.message, at: Date.now() });
      json(res, 200, {});
      return;
    }
    json(res, 404, { error: `no route ${path}` });
    return;
  }

  if (method === "DELETE") {
    let m;
    if ((m = path.match(/^\/api\/shell\/([^/]+)\/?$/))) {
      shellDeletes.push({ id: m[1], at: Date.now() });
      if (m[1] === liveShell.id && liveShell.status === "running") {
        liveShell.status = "killed";
        writeFrame(v2Clients, {
          id: "evt_shell_live_end",
          type: "session.shell.ended",
          data: {
            sessionID: SESSION_ID,
            timestamp: Date.now(),
            shell: {
              id: liveShell.id,
              command: liveShell.command,
              status: "killed",
              time: { completed: Date.now() },
            },
            output: shellText(),
          },
        });
      }
      res.writeHead(204, CORS);
      res.end();
      return;
    }
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
