import "./setup.test";
import { strict as assert } from "node:assert";
import {
  apiLog,
  ApiCall,
  bellRang,
  callsFor,
  dispatchWindowMessage,
  fireExact,
  fireTimeouts,
  flushEvents,
  hostPosted,
  localStorageStub,
  messageMock,
  onApi,
  API_FAIL,
  apiFailWith,
  pendingTimers,
  sessRow,
  setNow,
  settle,
  T0,
} from "./setup.test";
import {
  baseLoaded,
  charsPerToken,
  closeSessionTab,
  commands,
  composerFiles,
  composerInsert,
  contextLimit,
  currentDir,
  currentSelection,
  attachInputs,
  defaultAgent,
  deleteSession,
  displayModel,
  fmtDur,
  formatDateTime,
  hasOlder,
  hasQueued,
  hostMessage,
  init,
  interruptedPrompts,
  isEmptySession,
  isSubagentSession,
  loadOlderMessages,
  liveAssistantId,
  markPromptStopped,
  messagesBySession,
  messagesCursor,
  messagesFor,
  modelFree,
  modelLabel,
  modelVariants,
  newSession,
  normPath,
  pendingPermissions,
  pendingQuestions,
  projects,
  projectDisplayName,
  providers,
  purgeProject,
  purgeState,
  queueCommand,
  queuedTurns,
  refreshMessages,
  refreshPermissions,
  refreshQuestions,
  renameProject,
  resyncFromServer,
  resolveFileRef,
  revertQueuedTurn,
  revertSession,
  runSlashCommand,
  failedMsgLoads,
  sendError,
  sendPrompt,
  serverDefaultModel,
  sessionsStalled,
  sessionStatus,
  sessionTile,
  sessionTitle,
  sessionWorking,
  sessions,
  setProviderColor,
  providerColors,
  setProjectColor,
  setSelection,
  status,
  stepUsage,
  stopSession,
  stoppedPrompts,
  tombstones,
  homeFilter,
  agents,
  hiddenModels,
  hiddenProviders,
  peerNames,
} from "./store";
import { setDialect } from "./api";
import type { ChatMessage, Status } from "./store";
import { clampPartText, isTruncatedPart, PART_TEXT_CAP, streamingArg } from "./api";
import type {
  Message,
  MessageTokens,
  Part,
  Providers,
  Session,
} from "./api";
import { activeTab, navigate, route, unreadTabs } from "./router";

function row(
  id: string,
  role: "user" | "assistant",
  created: number,
  over: Partial<Message> = {},
): ChatMessage {
  return { info: { id, role, time: { created }, ...over }, parts: [] };
}

function textPart(
  pid: string,
  mid: string,
  sid: string,
  text: string,
  type: "text" | "reasoning" = "text",
): Part {
  return { id: pid, messageID: mid, sessionID: sid, type, text };
}

function toolPart(
  pid: string,
  mid: string,
  sid: string,
  input: Record<string, unknown>,
): Part {
  return {
    id: pid,
    messageID: mid,
    sessionID: sid,
    type: "tool",
    tool: "read",
    state: { status: "completed", input },
  };
}

const tok = (over: Partial<MessageTokens> = {}): MessageTokens => ({
  input: 0,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
  ...over,
});

function open(sid: string, rows: ChatMessage[]): void {
  messagesBySession.value = new Map([...messagesBySession.value, [sid, rows]]);
}

function setBusy(sid: string): void {
  sessionStatus.value = { ...sessionStatus.value, [sid]: { type: "busy" } };
}

let evSeq = 0;
function sse(type: string, data: Record<string, unknown>): void {
  dispatchWindowMessage({
    type: "sse-event",
    event: { id: `e${++evSeq}`, type, data },
  });
}
async function sseFlush(
  type: string,
  data: Record<string, unknown>,
): Promise<void> {
  sse(type, data);
  await flushEvents();
}

function listOf(sid: string): ChatMessage[] {
  return messagesBySession.value.get(sid) ?? [];
}
function usageOf(sid: string): { timestamp: number; tokens: MessageTokens } {
  return stepUsage.value[sid];
}
function findRow(sid: string, id: string): ChatMessage | undefined {
  return listOf(sid).find((m) => m.info.id === id);
}
function findPart(sid: string, pid: string): Part | undefined {
  for (const m of listOf(sid))
    for (const p of m.parts) if (p.id === pid) return p;
  return undefined;
}

before(async () => {
  init();
  await settle(4);
});
beforeEach(() => {
  apiLog.length = 0;
});
// Root hook: store-owned signals leak between tests otherwise (this file is
// where the store module is first loaded, so the imports are safe here).
afterEach(() => {
  sendError.value = undefined;
  queuedTurns.value = [];
  interruptedPrompts.value = new Set();
  stoppedPrompts.value = new Set();
  pendingPermissions.value = [];
  pendingQuestions.value = [];
  composerFiles.value = {};
  commands.value = [];
  agents.value = [];
  tombstones.value = [];
  homeFilter.value = undefined;
});

describe("smoke", () => {
  it("boots from the baked meta origin", () => {
    assert.deepEqual(status.value, {
      kind: "ready",
      origin: "http://test.local",
    } satisfies Status);
  });
  it("key signals start in boot state", () => {
    assert.deepEqual(sessions.value, []);
    assert.deepEqual(queuedTurns.value, []);
    assert.equal(messagesBySession.value.size, 0);
    assert.deepEqual(route.value, { view: "home" });
    assert.equal(baseLoaded.value, true);
  });
});

// fa244c7
describe("resyncFromServer rate limit (fa244c7)", () => {
  it("pulls immediately, then at most once per 5s window", async () => {
    setNow(100_000);
    resyncFromServer();
    await settle();
    // one pull = refreshBase + refreshStatuses
    assert.equal(callsFor("/session/status").length, 2);

    setNow(101_500);
    resyncFromServer();
    await settle();
    assert.equal(callsFor("/session/status").length, 2);
    assert.equal(pendingTimers(), 1);

    setNow(102_500);
    resyncFromServer();
    await settle();
    assert.equal(pendingTimers(), 1); // one trailing timer, not two

    setNow(106_000);
    assert.equal(fireTimeouts(5_000), 1);
    await settle();
    assert.equal(callsFor("/session/status").length, 4);

    setNow(120_000);
    resyncFromServer();
    await settle();
    assert.equal(callsFor("/session/status").length, 6);
    assert.equal(pendingTimers(), 0);
  });
});

// ff679c9 + 286784b
describe("completion chime (ff679c9, 286784b)", () => {
  async function ringFromTurnEnd(sid: string): Promise<void> {
    sessions.value = [sessRow(sid)];
    setBusy(sid);
    await sseFlush("session.idle", { sessionID: sid });
    assert.equal(pendingTimers(), 1);
  }

  it("rings after the grace when the session stays idle", async () => {
    await ringFromTurnEnd("ch1");
    assert.equal(fireExact(1_500), 1);
    await settle(4);
    assert.ok(bellRang());
  });

  it("a seen user row (turn-end summary write) does not cancel the ring", async () => {
    const sid = "ch2";
    open(sid, [row("u1", "user", T0)]);
    await ringFromTurnEnd(sid);
    await sseFlush("message.updated", {
      sessionID: sid,
      info: { id: "u1", role: "user", time: { created: T0 } },
    });
    assert.equal(fireExact(1_500), 1);
    await settle(4);
    assert.ok(bellRang());
  });

  it("an unseen row resumes the session and cancels the ring", async () => {
    const sid = "ch3";
    open(sid, [row("u1", "user", T0)]);
    await ringFromTurnEnd(sid);
    await sseFlush("message.updated", {
      sessionID: sid,
      info: { id: "u-other", role: "user", time: { created: T0 + 5 } },
    });
    assert.equal(fireExact(1_500), 0);
    await settle(4);
    assert.equal(bellRang(), false);
  });

  it("a status adoption that dropped the entry reads as idle (rings)", async () => {
    await ringFromTurnEnd("ch4");
    sessionStatus.value = {}; // wholesale adoption, sid absent
    assert.equal(fireExact(1_500), 1);
    await settle(4);
    assert.ok(bellRang());
  });

  it("a busy status adoption silences the pending ring", async () => {
    await ringFromTurnEnd("ch5");
    setBusy("ch5");
    assert.equal(fireExact(1_500), 1);
    await settle(4);
    assert.equal(bellRang(), false);
  });

  it("a step within the grace cancels the ring (standstill only)", async () => {
    await ringFromTurnEnd("ch6");
    await sseFlush("session.next.step.started", { sessionID: "ch6" });
    assert.equal(fireExact(1_500), 0);
    assert.equal(sessionStatus.value["ch6"]?.type, "busy");
  });

  it("sub-agent sessions never ring", async () => {
    const sid = "ch7";
    sessions.value = [sessRow(sid, { parentID: "parent" })];
    setBusy(sid);
    await sseFlush("session.idle", { sessionID: sid });
    assert.equal(pendingTimers(), 0);
  });
});

// 530a2f2
describe("reasoning window reopen (530a2f2)", () => {
  it("drops the ended stamp when a delta reopens the part", async () => {
    const sid = "rs1";
    open(sid, [
      {
        info: { id: "a1", role: "assistant", time: { created: T0 } },
        parts: [
          {
            id: "r1",
            messageID: "a1",
            sessionID: sid,
            type: "reasoning",
            text: "think",
            time: { start: T0, end: T0 + 5 },
          },
        ],
      },
    ]);
    await sseFlush("session.next.reasoning.delta", {
      sessionID: sid,
      assistantMessageID: "a1",
      reasoningID: "r1",
      delta: " more",
    });
    const p = findPart(sid, "r1") as {
      text?: string;
      time?: { start?: number; end?: number };
    };
    assert.equal(p.text, "think more");
    assert.equal(p.time?.end, undefined);
    assert.equal(p.time?.start, T0);
  });
});

// The reconnect leak: a reasoning part whose typed full write
// (reasoning-start's message.part.updated) was lost in an SSE gap is
// created by the first delta — which carries field:"text" even for
// reasoning (server processor sends the part field, not the part type) —
// so it streams into the main transcript. The resync's fetch brings the
// typed durable copy, but its text lags the stream, and the old
// keep-longer-text merge preserved the mis-typed live part until
// reasoning.ended snapped it under the Thought block. The merge now
// adopts the durable type while keeping the fresher text.
describe("reconnect resync heals a mis-typed reasoning part", () => {
  it("keeps the streamed text and adopts the durable type", async () => {
    const sid = "rk1";
    open(sid, [row("m1", "assistant", T0)]);
    setBusy(sid);
    await sseFlush("message.part.delta", {
      sessionID: sid,
      messageID: "m1",
      partID: "p1",
      field: "text", // the server's reasoning deltas say "text"
      delta: "leaked thought",
    });
    assert.equal(findPart(sid, "p1")?.type, "text"); // the leak premise
    onApi(
      messageMock(
        sid,
        { data: [], cursor: {} },
        [
          {
            info: { id: "m1", role: "assistant", time: { created: T0 } },
            parts: [textPart("p1", "m1", sid, "", "reasoning")],
          },
        ],
      ),
    );
    await refreshMessages(sid);
    const healed = findPart(sid, "p1");
    assert.equal(healed?.type, "reasoning");
    assert.equal((healed as { text?: string }).text, "leaked thought");
  });
});

// A steer admitted mid-turn lands its user row while the turn still
// streams; the live sweep must not treat it as the turn boundary (the
// streaming row's Thinking label would freeze into "Thought" until the
// turn's next row lands). A tail that settled through an idle is the next
// turn warming up — it must not re-animate either.
describe("liveAssistantId (mid-turn steer)", () => {
  it("keeps the streaming tail live; an idle-settled tail stays settled", async () => {
    const sid = "st1";
    open(sid, [row("u1", "user", T0), row("a1", "assistant", T0 + 1)]);
    setBusy(sid);
    // The steer's echo lands while a1 still streams.
    open(sid, [...listOf(sid), row("u2", "user", T0 + 2)]);
    assert.equal(liveAssistantId(sid, listOf(sid)), "a1");
    // The turn's next row takes live back.
    open(sid, [...listOf(sid), row("a2", "assistant", T0 + 3)]);
    assert.equal(liveAssistantId(sid, listOf(sid)), "a2");
    // The turn ends; the next turn's warmup must not re-animate a2.
    await sseFlush("session.idle", { sessionID: sid });
    setBusy(sid);
    open(sid, [...listOf(sid), row("u3", "user", T0 + 4)]);
    assert.equal(liveAssistantId(sid, listOf(sid)), undefined);
    open(sid, [...listOf(sid), row("a3", "assistant", T0 + 5)]);
    assert.equal(liveAssistantId(sid, listOf(sid)), "a3");
  });
});

// The zhipuai endpoint's spurious empty steps idle the session mid-turn;
// nothing else re-busies a v1 turn, so streaming evidence must — in both
// wire dialects (the live server streams parts as full
// message.part.updated writes, not deltas; verified in the durable log).
describe("streaming deltas re-busy a mid-turn idle", () => {
  it("a v1 reasoning delta after session.idle restores busy and cancels the ring", async () => {
    const sid = "rb1";
    sessions.value = [sessRow(sid)];
    open(sid, [row("a1", "assistant", T0)]);
    setBusy(sid);
    await sseFlush("session.idle", { sessionID: sid });
    assert.equal(sessionStatus.value[sid]?.type, "idle");
    assert.equal(pendingTimers(), 1); // the idle rang
    await sseFlush("message.part.delta", {
      sessionID: sid,
      messageID: "a1",
      partID: "a1:r1",
      field: "reasoning",
      delta: "hm",
    });
    assert.equal(sessionStatus.value[sid]?.type, "busy");
    assert.equal(pendingTimers(), 0); // ring canceled — turn still running
  });

  it("a v2 text delta within the idle grace holds the turn busy", async () => {
    const sid = "rb2";
    open(sid, [row("a2", "assistant", T0)]);
    setBusy(sid);
    await sseFlush("session.next.step.ended", {
      sessionID: sid,
      assistantMessageID: "a2",
      finish: "stop",
      tokens: tok({ output: 5 }),
    });
    assert.equal(pendingTimers(), 1); // 3s idle grace armed
    await sseFlush("session.next.text.delta", {
      sessionID: sid,
      assistantMessageID: "a2",
      textID: "t1",
      delta: "hi",
    });
    assert.equal(sessionStatus.value[sid]?.type, "busy");
    assert.equal(pendingTimers(), 0);
  });

  it("a growing open-part write (the live dialect) restores busy after session.idle", async () => {
    const sid = "rb3";
    sessions.value = [sessRow(sid)];
    open(sid, [
      {
        info: { id: "a3", role: "assistant", time: { created: T0 } },
        parts: [textPart("r3", "a3", sid, "think", "reasoning")],
      },
    ]);
    setBusy(sid);
    await sseFlush("session.idle", { sessionID: sid });
    assert.equal(sessionStatus.value[sid]?.type, "idle");
    await sseFlush("message.part.updated", {
      sessionID: sid,
      part: {
        id: "r3",
        messageID: "a3",
        sessionID: sid,
        type: "reasoning",
        text: "think more",
        time: { start: T0 },
      },
    });
    assert.equal(sessionStatus.value[sid]?.type, "busy");
    // The open-part write also lands as text growth.
    assert.equal(
      (findPart(sid, "r3") as { text?: string }).text,
      "think more",
    );
  });

  it("an end-stamped final write after idle does not raise the dead turn", async () => {
    const sid = "rb4";
    open(sid, [
      {
        info: { id: "a4", role: "assistant", time: { created: T0 } },
        parts: [textPart("r4", "a4", sid, "think", "reasoning")],
      },
    ]);
    setBusy(sid);
    await sseFlush("session.idle", { sessionID: sid });
    assert.equal(sessionStatus.value[sid]?.type, "idle");
    await sseFlush("message.part.updated", {
      sessionID: sid,
      part: {
        id: "r4",
        messageID: "a4",
        sessionID: sid,
        type: "reasoning",
        text: "think",
        time: { start: T0, end: T0 + 5 },
      },
    });
    assert.equal(sessionStatus.value[sid]?.type, "idle");
  });

  it("a same-length open-part rewrite does not re-busy", async () => {
    const sid = "rb5";
    open(sid, [
      {
        info: { id: "a5", role: "assistant", time: { created: T0 } },
        parts: [textPart("r5", "a5", sid, "think", "reasoning")],
      },
    ]);
    setBusy(sid);
    await sseFlush("session.idle", { sessionID: sid });
    await sseFlush("message.part.updated", {
      sessionID: sid,
      part: {
        id: "r5",
        messageID: "a5",
        sessionID: sid,
        type: "reasoning",
        text: "think",
        time: { start: T0 },
      },
    });
    assert.equal(sessionStatus.value[sid]?.type, "idle");
  });

  it("a background session's growing part write re-busies it (chips, Home)", async () => {
    const sid = "rb6"; // this window never opened it
    setBusy(sid);
    await sseFlush("session.idle", { sessionID: sid });
    assert.equal(sessionStatus.value[sid]?.type, "idle");
    await sseFlush("message.part.updated", {
      sessionID: sid,
      part: {
        id: "r6",
        messageID: "a6",
        sessionID: sid,
        type: "reasoning",
        text: "think",
        time: { start: T0 },
      },
    });
    assert.equal(sessionStatus.value[sid]?.type, "busy");
  });
});

// 5185f17
describe("transcript windowing and Load older (5185f17)", () => {
  const sid = "w1";
  const v2 = Array.from({ length: 50 }, (_, i) => ({
    id: `v${120 + i}`,
    type: i % 2 === 0 ? "user" : "assistant",
    time: { created: T0 + (120 + i) * 10 },
    text: i % 2 === 0 ? `q${120 + i}` : undefined,
  }));
  const legacy = Array.from({ length: 120 }, (_, i) => ({
    info: {
      id: `l${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      time: { created: T0 + i * 10 },
    },
    parts: i % 2 === 0 ? [textPart(`l${i}:text`, `l${i}`, sid, `q${i}`)] : [],
  }));
  beforeEach(() => {
    onApi(
      messageMock(
        sid,
        (call: ApiCall) => {
          // The older-row walk: page 1 is order=asc (no cursor), then cursor
          // pages — here the asc page holds only rows we already have (all
          // dups, short page) and the cursor page is empty: the v2 transcript
          // is exhausted, the legacy pool still holds rows.
          if (call.path.includes("cursor=c2"))
            return { data: [], cursor: { next: "c3" } };
          if (call.path.includes("order=asc")) return { data: v2 };
          return { data: v2, cursor: { next: "c1" } };
        },
        legacy,
      ),
    );
  });

  it("cold open shows only the newest window", async () => {
    await refreshMessages(sid);
    const list = listOf(sid);
    assert.equal(list.length, 50);
    assert.equal(list[0].info.id, "v120"); // boundary snapped to a user head
    assert.equal(messagesCursor.value.get(sid), true);
    assert.ok(hasOlder(sid));
    assert.ok(
      callsFor(`/api/session/${sid}/message`)[0].path.includes("order=desc"),
    );
  });

  it("Load older pages: exhausted cursor falls through to the pool", async () => {
    assert.equal(await loadOlderMessages(sid), true);
    assert.equal(listOf(sid).length, 150);
    assert.equal(listOf(sid)[0].info.id, "l20");
    assert.equal(await loadOlderMessages(sid), true);
    assert.equal(listOf(sid).length, 170);
    assert.equal(listOf(sid)[0].info.id, "l0");
    assert.equal(await loadOlderMessages(sid), false);
    assert.equal(hasOlder(sid), false);
  });

  it("a refresh never collapses an expanded view", async () => {
    await refreshMessages(sid);
    assert.equal(listOf(sid).length, 170);
    assert.equal(listOf(sid)[0].info.id, "l0");
    assert.equal(messagesCursor.value.get(sid), true);
  });

  it("walks older rows through the asc pages", async () => {
    const older = Array.from({ length: 100 }, (_, i) => ({
      id: `o${i}`,
      type: i % 2 === 0 ? "user" : "assistant",
      time: { created: T0 + i * 10 },
    }));
    onApi(
      messageMock(sid, (call: ApiCall) => {
        if (call.path.includes("cursor=w2"))
          return { data: older.slice(50), cursor: { next: "w3" } };
        if (call.path.includes("cursor=w1"))
          return { data: older.slice(0, 50), cursor: { next: "w2" } };
        if (call.path.includes("order=asc"))
          return { data: older, cursor: { next: "w1" } };
        return { data: v2, cursor: { next: "c1" } };
      }),
    );
    await refreshMessages(sid);
    assert.equal(await loadOlderMessages(sid), true);
    assert.equal(listOf(sid).length, 150);
    assert.equal(listOf(sid)[0].info.id, "o0");
    // A full asc page keeps the walk's continuation cursor.
    assert.equal(messagesCursor.value.get(sid), "w1");
    // Its next page overlaps nothing new and comes back short: the walk
    // ends there even though the endpoint still served a cursor.
    assert.equal(await loadOlderMessages(sid), false);
    assert.equal(messagesCursor.value.get(sid), undefined);
    assert.equal(listOf(sid).length, 150);
  });
});

// 50cba2d
describe("queued echo and command lines survive refreshes (50cba2d)", () => {
  it("keeps pending: and cmd: rows through refreshMessages", async () => {
    const sid = "pe1";
    open(sid, [
      {
        info: { id: "pending:1", role: "user", time: { created: T0 } },
        parts: [textPart("pending:1:text", "pending:1", sid, "queued echo")],
      },
      row("u1", "user", T0 - 10),
    ]);
    localStorageStub.setItem(
      `opencode-cmd-${sid}`,
      JSON.stringify([{ cid: "cmd:7", text: "/foo", created: T0 + 5 }]),
    );
    onApi(
      messageMock(sid, {
        data: [
          { id: "u1", type: "user", time: { created: T0 - 10 }, text: "real row" },
        ],
        cursor: {},
      }),
    );
    await refreshMessages(sid);
    const ids = listOf(sid).map((m) => m.info.id);
    assert.deepEqual(ids, ["u1", "pending:1", "cmd:7"]);
    const echo = findRow(sid, "pending:1");
    assert.equal((echo?.parts[0] as { text?: string }).text, "queued echo");
  });
});

// 0382677
describe("queued turns apply in publish order (0382677)", () => {
  it("runs commands and prompts head-first as the session idles", async () => {
    const sid = "q1";
    commands.value = [{ name: "foo" }];
    setBusy(sid);
    queueCommand(sid, "/foo bar");
    await sendPrompt(sid, "a");
    await sendPrompt(sid, "b");
    assert.equal(queuedTurns.value.length, 3);
    assert.equal(callsFor(`/session/${sid}/prompt_async`).length, 0);

    await sseFlush("session.idle", { sessionID: sid });
    assert.equal(queuedTurns.value.length, 2);
    assert.equal(callsFor(`/session/${sid}/command`).length, 1);
    assert.equal(
      (callsFor(`/session/${sid}/command`)[0].body as { command?: string })
        ?.command,
      "foo",
    );

    await sseFlush("session.idle", { sessionID: sid });
    assert.equal(queuedTurns.value.length, 1);
    await sseFlush("session.idle", { sessionID: sid });
    assert.equal(queuedTurns.value.length, 0);

    const order = apiLog
      .map((c) => c.path.split("?")[0])
      .filter((p) =>
        [`/session/${sid}/command`, `/session/${sid}/prompt_async`].includes(p),
      );
    assert.deepEqual(order, [
      `/session/${sid}/command`,
      `/session/${sid}/prompt_async`,
      `/session/${sid}/prompt_async`,
    ]);
    const bodies = callsFor(`/session/${sid}/prompt_async`).map(
      (c) =>
        (c.body as { parts: { type: string; text?: string }[] }).parts[0].text,
    );
    assert.deepEqual(bodies, ["a", "b"]);
  });

  it("a prompt onto a busy session with an empty queue POSTs now", async () => {
    const sid = "q2";
    setBusy(sid);
    await sendPrompt(sid, "steering");
    assert.equal(callsFor(`/session/${sid}/prompt_async`).length, 1);
    assert.equal(queuedTurns.value.length, 0);
    assert.ok(
      listOf(sid).some((m) => m.info.id.startsWith("pending:")),
    );
  });

  it("revertQueuedTurn takes back a queued prompt without posting it", async () => {
    const sid = "q2r";
    commands.value = [{ name: "foo" }];
    setBusy(sid);
    queueCommand(sid, "/foo");
    await sendPrompt(sid, "held back");
    assert.equal(queuedTurns.value.length, 2);
    assert.equal(callsFor(`/session/${sid}/prompt_async`).length, 0);
    // Nothing queued under that text — the take-back refuses.
    assert.equal(revertQueuedTurn(sid, "never queued"), false);
    assert.equal(revertQueuedTurn(sid, "held back"), true);
    assert.equal(queuedTurns.value.length, 1);
    assert.equal(queuedTurns.value[0].kind, "command");
    assert.equal(
      listOf(sid).some((m) => m.info.id.startsWith("pending:")),
      false,
    );
    // The dequeued prompt must never fire — the command still does.
    await sseFlush("session.idle", { sessionID: sid });
    assert.equal(callsFor(`/session/${sid}/prompt_async`).length, 0);
    assert.equal(callsFor(`/session/${sid}/command`).length, 1);
  });

  it("queueCommand rejects unknown commands", () => {
    commands.value = [];
    queueCommand("q3", "/nope");
    assert.equal(queuedTurns.value.length, 0);
    assert.equal(sendError.value?.text, "Unknown command /nope.");
  });

  it("/compact is queueable without a command list", () => {
    const sid = "q4";
    commands.value = [];
    setBusy(sid);
    queueCommand(sid, "/compact");
    assert.equal(hasQueued(sid), true);
    assert.ok(listOf(sid).some((m) => m.info.id.startsWith("cmd:")));
    assert.ok(localStorageStub.getItem(`opencode-cmd-${sid}`));
  });
});

// 9a595b4
describe("session-local caches release on close (9a595b4)", () => {
  it("closeSessionTab drops transcript, cursor, truncation, and the computed view", () => {
    const sid = "cl1";
    clampPartText("big1", "x".repeat(PART_TEXT_CAP + 100));
    assert.ok(isTruncatedPart("big1"));
    open(sid, [
      {
        info: { id: "u1", role: "user", time: { created: T0 } },
        parts: [textPart("big1", "u1", sid, "clamped away")],
      },
    ]);
    messagesCursor.value = new Map(messagesCursor.value).set(sid, "c9");
    const view1 = messagesFor(sid);
    closeSessionTab(sid);
    assert.equal(isTruncatedPart("big1"), false);
    assert.equal(messagesBySession.value.has(sid), false);
    assert.equal(messagesCursor.value.has(sid), false);
    assert.equal(hasOlder(sid), false);
    open(sid, []);
    assert.notEqual(messagesFor(sid), view1);
  });

  it("deleteSession cancels idle/ring/ghost timers and clears stores", async () => {
    const sid = "cl2";
    sessions.value = [sessRow(sid)];
    open(sid, [row("u1", "user", T0)]);
    setBusy(sid);
    await sseFlush("session.idle", { sessionID: sid });
    assert.equal(pendingTimers(), 1); // ring
    await stopSession(sid);
    assert.equal(pendingTimers(), 1); // ghost watch replaced the ring
    localStorageStub.setItem(`opencode-cmd-${sid}`, "[]");
    assert.equal(await deleteSession(sid), true);
    assert.equal(pendingTimers(), 0);
    assert.equal(sessions.value.some((s) => s.id === sid), false);
    assert.equal(messagesBySession.value.has(sid), false);
    assert.equal(localStorageStub.getItem(`opencode-cmd-${sid}`), null);
  });
});

// 5185f17 (ghost watch half)
describe("ghost turns after a stop (5185f17)", () => {
  it("aborts a user row nobody submitted right after a stop", async () => {
    const sid = "gh1";
    sessions.value = [sessRow(sid)];
    open(sid, [
      {
        info: { id: "u0", role: "user", time: { created: T0 } },
        parts: [textPart("u0:text", "u0", sid, "hi")],
      },
    ]);
    setBusy(sid);
    await stopSession(sid);
    assert.equal(callsFor(`/session/${sid}/abort`).length, 1);
    await sseFlush("message.updated", {
      sessionID: sid,
      info: { id: "u_ghost", role: "user", time: { created: T0 + 9 } },
    });
    await settle(2);
    assert.equal(callsFor(`/session/${sid}/abort`).length, 2);
    assert.ok(stoppedPrompts.value.has("u_ghost"));
  });
});

// 443203b
describe("reasoning-effort variant guard (443203b)", () => {
  beforeEach(() => setDialect("v2"));
  afterEach(() => setDialect("v1"));
  it("adopts a variant still set on the row", async () => {
    const sid = "vg1";
    await sseFlush("session.updated", {
      info: sessRow(sid, {
        model: { id: "m1", providerID: "p1", variant: "high" },
      }),
    });
    const saved = JSON.parse(
      localStorageStub.getItem("opencode-variant-picks") ?? "{}",
    ) as Record<string, unknown>;
    assert.ok(saved[sid]);
  });
  it("re-asserts the pick when a row comes back without it", async () => {
    const sid = "vg2";
    await sseFlush("session.updated", {
      info: sessRow(sid, {
        model: { id: "m1", providerID: "p1", variant: "high" },
      }),
    });
    await sseFlush("session.updated", {
      info: sessRow(sid, { model: { id: "m1", providerID: "p1" } }),
    });
    await settle(2);
    const calls = callsFor(`/api/session/${sid}/model`);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body, {
      model: { providerID: "p1", id: "m1", variant: "high" },
    });
    assert.equal(
      sessions.value.find((s) => s.id === sid)?.model?.variant,
      "high",
    );
  });
  it("a different model drops the pick", async () => {
    const sid = "vg3";
    await sseFlush("session.updated", {
      info: sessRow(sid, {
        model: { id: "m1", providerID: "p1", variant: "high" },
      }),
    });
    await sseFlush("session.updated", {
      info: sessRow(sid, { model: { id: "other", providerID: "p1" } }),
    });
    await settle(2);
    assert.equal(callsFor(`/api/session/${sid}/model`).length, 0);
    const saved = JSON.parse(
      localStorageStub.getItem("opencode-variant-picks") ?? "{}",
    ) as Record<string, unknown>;
    assert.equal(saved[sid], undefined);
  });
  it('a bare "default" variant is not an intent to guard', async () => {
    const sid = "vg4";
    await sseFlush("session.updated", {
      info: sessRow(sid, {
        model: { id: "m1", providerID: "p1", variant: "default" },
      }),
    });
    const saved = JSON.parse(
      localStorageStub.getItem("opencode-variant-picks") ?? "{}",
    ) as Record<string, unknown>;
    assert.equal(saved[sid], undefined);
  });
});

// 19592cc
describe("interrupted-mark writes (19592cc)", () => {
  it("skips redundant mark writes", () => {
    markPromptStopped("p1");
    const before = interruptedPrompts.value;
    markPromptStopped("p1");
    assert.strictEqual(interruptedPrompts.value, before);
    assert.ok(stoppedPrompts.value.has("p1"));
  });
});

// e7cc7ec
describe("delta coalescing in the drain (e7cc7ec)", () => {
  it("concatenates consecutive deltas for the same part in one pass", async () => {
    const sid = "co1";
    open(sid, [row("a1", "assistant", T0)]);
    sse("session.next.text.delta", {
      sessionID: sid,
      assistantMessageID: "a1",
      textID: "t1",
      delta: "He",
    });
    sse("session.next.text.delta", {
      sessionID: sid,
      assistantMessageID: "a1",
      textID: "t1",
      delta: "ll",
    });
    sse("session.next.text.delta", {
      sessionID: sid,
      assistantMessageID: "a1",
      textID: "t1",
      delta: "o",
    });
    sse("session.next.text.delta", {
      sessionID: sid,
      assistantMessageID: "a1",
      textID: "t2",
      delta: "!",
    });
    sse("message.part.delta", {
      sessionID: sid,
      messageID: "a1",
      partID: "d1",
      field: "reasoning",
      delta: "R",
    });
    sse("message.part.delta", {
      sessionID: sid,
      messageID: "a1",
      partID: "d1",
      field: "reasoning",
      delta: "R",
    });
    await flushEvents();
    assert.equal((findPart(sid, "t1") as { text?: string }).text, "Hello");
    assert.equal((findPart(sid, "t2") as { text?: string }).text, "!");
    assert.equal(
      (findPart(sid, "d1") as { text?: string; type?: string }).text,
      "RR",
    );
    assert.equal(findPart(sid, "d1")?.type, "reasoning");
  });
});

// da0d298
describe("message identity across refreshes (da0d298)", () => {
  it("keeps the stored object for local rows the server does not know", async () => {
    const sid = "id1";
    const localEcho: ChatMessage = {
      info: { id: "cmd:3", role: "user", time: { created: 3 } },
      parts: [textPart("cmd:3:text", "cmd:3", sid, "/run")],
    };
    open(sid, [localEcho]);
    const fetchPage = () => ({
      data: [
        { id: "u1", type: "user", time: { created: 1 }, text: "hi" },
        {
          id: "a1",
          type: "assistant",
          time: { created: 2 },
          content: [{ type: "text", id: "p1", text: "yo" }],
        },
      ],
      cursor: {},
    });
    onApi(messageMock(sid, fetchPage));
    await refreshMessages(sid);
    const echoRow = findRow(sid, "cmd:3");
    assert.strictEqual(echoRow, localEcho);
    await refreshMessages(sid);
    assert.strictEqual(findRow(sid, "cmd:3"), localEcho);
  });

  it("keeps whichever text copy carries more (durable lag)", async () => {
    const sid = "id2";
    open(sid, [
      {
        info: { id: "a1", role: "assistant", time: { created: 2 } },
        parts: [textPart("p1", "a1", sid, "0123456789")],
      },
    ]);
    onApi(
      messageMock(sid, {
        data: [
          {
            id: "a1",
            type: "assistant",
            time: { created: 2 },
            content: [{ type: "text", id: "p1", text: "012" }],
          },
        ],
        cursor: {},
      }),
    );
    await refreshMessages(sid);
    assert.equal(
      (findPart(sid, "p1") as { text?: string }).text,
      "0123456789",
    );
  });
});

// 9b6dd50 (store half)
describe("per-session transcript views (9b6dd50)", () => {
  it("caches one view per session and skips other sessions' mutations", () => {
    const a = [row("u1", "user", 1)];
    const b = [row("u2", "user", 2)];
    open("svA", a);
    open("svB", b);
    const viewA = messagesFor("svA");
    assert.strictEqual(messagesFor("svA"), viewA);
    assert.strictEqual(viewA.value, a);
    open("svB", [...b, row("u3", "user", 3)]);
    assert.strictEqual(viewA.value, a);
  });
});

describe("turn projection from stream events", () => {
  it("message.updated seeds the real user row from the pending echo", async () => {
    const sid = "tp1";
    open(sid, [
      {
        info: { id: "pending:9", role: "user", time: { created: T0 } },
        parts: [textPart("pending:9:text", "pending:9", sid, "hello world")],
      },
    ]);
    await sseFlush("message.updated", {
      sessionID: sid,
      info: { id: "u9", role: "user", time: { created: T0 } },
    });
    assert.equal(findRow(sid, "pending:9"), undefined);
    const u9 = findRow(sid, "u9");
    assert.equal((u9?.parts[0] as { text?: string }).text, "hello world");
    assert.equal(u9?.parts[0].id, "u9:text");
  });

  it("prompt.admitted clears the echo and writes the prompt row", async () => {
    const sid = "tp2";
    open(sid, [
      {
        info: { id: "pending:1", role: "user", time: { created: T0 } },
        parts: [textPart("pending:1:text", "pending:1", sid, "x")],
      },
    ]);
    await sseFlush("session.next.prompt.admitted", {
      sessionID: sid,
      messageID: "u1",
      timestamp: T0,
      prompt: { text: "the prompt" },
    });
    assert.equal(findRow(sid, "pending:1"), undefined);
    assert.equal(
      (findPart(sid, "u1:text") as { text?: string }).text,
      "the prompt",
    );
  });

  it("step.started announces the assistant row with its model", async () => {
    const sid = "tp3";
    open(sid, []);
    await sseFlush("session.next.step.started", {
      sessionID: sid,
      assistantMessageID: "a1",
      timestamp: T0,
      agent: "build",
      model: { id: "m1", providerID: "p1" },
    });
    const a1 = findRow(sid, "a1");
    assert.equal(a1?.info.role, "assistant");
    assert.equal(a1?.info.modelID, "m1");
    assert.equal(a1?.info.providerID, "p1");
    assert.equal(sessionStatus.value[sid]?.type, "busy");
  });

  it("tool lifecycle: pending â†’ running â†’ completed/failed", async () => {
    const sid = "tp4";
    open(sid, [row("a1", "assistant", T0)]);
    await sseFlush("session.next.tool.input.started", {
      sessionID: sid,
      assistantMessageID: "a1",
      callID: "c1",
      name: "bash",
    });
    let st = findPart(sid, "c1") as {
      state?: { status?: string; input?: unknown; output?: string };
    };
    assert.equal(st.state?.status, "pending");
    await sseFlush("session.next.tool.called", {
      sessionID: sid,
      assistantMessageID: "a1",
      callID: "c1",
      input: { command: "ls" },
      timestamp: T0 + 1,
    });
    st = findPart(sid, "c1") as {
      state?: { status?: string; input?: unknown };
    };
    assert.equal(st.state?.status, "running");
    assert.deepEqual(st.state?.input, { command: "ls" });
    await sseFlush("session.next.tool.success", {
      sessionID: sid,
      assistantMessageID: "a1",
      callID: "c1",
      result: "done",
      timestamp: T0 + 2,
    });
    st = findPart(sid, "c1") as {
      state?: { status?: string; input?: unknown; output?: string };
    };
    assert.equal(st.state?.status, "completed");
    assert.equal(st.state?.output, "done");
    await sseFlush("session.next.tool.failed", {
      sessionID: sid,
      assistantMessageID: "a1",
      callID: "c2",
      error: { message: "boom" },
      timestamp: T0 + 3,
    });
    await sseFlush("session.next.tool.input.started", {
      sessionID: sid,
      assistantMessageID: "a1",
      callID: "c2",
      name: "bash",
    });
    await sseFlush("session.next.tool.failed", {
      sessionID: sid,
      assistantMessageID: "a1",
      callID: "c2",
      error: { message: "boom" },
      timestamp: T0 + 4,
    });
    const f = findPart(sid, "c2") as {
      state?: { status?: string; error?: string };
    };
    assert.equal(f.state?.status, "error");
    assert.equal(f.state?.error, "boom");
  });

  it("tool args stream: deltas preview live, ended parses, called supersedes", async () => {
    const sid = "tpq";
    open(sid, [row("a1", "assistant", T0)]);
    await sseFlush("session.next.tool.input.started", {
      sessionID: sid,
      assistantMessageID: "a1",
      callID: "c1",
      name: "write",
    });
    await sseFlush("session.next.tool.input.delta", {
      sessionID: sid,
      assistantMessageID: "a1",
      callID: "c1",
      delta: '{"filePath":"src/a',
    });
    let st = findPart(sid, "c1") as {
      state?: { status?: string; inputText?: string; input?: unknown };
    };
    // Pre-execution: pending status, but the raw args already preview.
    assert.equal(st.state?.status, "pending");
    assert.equal(st.state?.input, undefined);
    assert.equal(st.state?.inputText, '{"filePath":"src/a');
    assert.equal(
      streamingArg(st.state?.inputText, ["filePath", "file", "path"]),
      "src/a",
    );
    await sseFlush("session.next.tool.input.delta", {
      sessionID: sid,
      assistantMessageID: "a1",
      callID: "c1",
      delta: '.ts","content":"hi"}',
    });
    st = findPart(sid, "c1") as {
      state?: { inputText?: string };
    };
    assert.equal(st.state?.inputText, '{"filePath":"src/a.ts","content":"hi"}');
    // The whole text parses before execution confirms it.
    await sseFlush("session.next.tool.input.ended", {
      sessionID: sid,
      assistantMessageID: "a1",
      callID: "c1",
      text: '{"filePath":"src/a.ts","content":"hi"}',
    });
    st = findPart(sid, "c1") as {
      state?: { status?: string; inputText?: string; input?: unknown };
    };
    assert.equal(st.state?.status, "pending");
    assert.deepEqual(st.state?.input, { filePath: "src/a.ts", content: "hi" });
    await sseFlush("session.next.tool.called", {
      sessionID: sid,
      assistantMessageID: "a1",
      callID: "c1",
      input: { filePath: "src/a.ts", content: "hi" },
      timestamp: T0 + 1,
    });
    st = findPart(sid, "c1") as {
      state?: { status?: string; inputText?: string; input?: unknown };
    };
    assert.equal(st.state?.status, "running");
    assert.deepEqual(st.state?.input, { filePath: "src/a.ts", content: "hi" });
    // The parsed args supersede the streamed raw — the buffer is freed.
    assert.equal(st.state?.inputText, undefined);
  });

  it("tool.success folds content items when there is no result string", async () => {
    const sid = "tp5";
    open(sid, [row("a1", "assistant", T0)]);
    await sseFlush("session.next.tool.input.started", {
      sessionID: sid,
      assistantMessageID: "a1",
      callID: "c1",
      name: "edit",
    });
    await sseFlush("session.next.tool.called", {
      sessionID: sid,
      assistantMessageID: "a1",
      callID: "c1",
      timestamp: T0,
    });
    await sseFlush("session.next.tool.success", {
      sessionID: sid,
      assistantMessageID: "a1",
      callID: "c1",
      content: [{ type: "text", text: "a" }, { type: "text", text: "b" }],
      structured: { files: ["f.ts"] },
      timestamp: T0 + 1,
    });
    const st = findPart(sid, "c1") as {
      state?: { output?: string; structured?: unknown };
    };
    assert.equal(st.state?.output, "a\nb");
    assert.deepEqual(st.state?.structured, { files: ["f.ts"] });
  });

  it("step.ended accumulates the step's usage as a delta", async () => {
    const sid = "tp6";
    sessions.value = [sessRow(sid)];
    open(sid, [
      {
        info: {
          id: "a1",
          role: "assistant",
          time: { created: T0 },
          tokens: tok({ input: 100, output: 20 }),
        },
        parts: [textPart("p1", "a1", sid, "0123456789")],
      },
    ]);
    setBusy(sid);
    await sseFlush("session.next.step.ended", {
      sessionID: sid,
      assistantMessageID: "a1",
      timestamp: T0 + 9,
      cost: 0.5,
      finish: "stop",
      tokens: tok({ input: 50, output: 10, total: 180 }),
    });
    const a1 = findRow(sid, "a1");
    assert.equal(a1?.info.tokens?.input, 150);
    assert.equal(a1?.info.tokens?.output, 30);
    assert.equal(a1?.info.tokens?.total, 180);
    assert.equal(a1?.info.reportedChars, 10);
    assert.equal(a1?.info.time.completed, T0 + 9);
    assert.equal(a1?.info.cost, 0.5);
    assert.equal(sessions.value.find((s) => s.id === sid)?.tokens.input, 50);
    assert.equal(pendingTimers(), 1); // idle scheduled
    await sseFlush("session.next.step.started", { sessionID: sid });
    assert.equal(pendingTimers(), 0); // re-busy cancels the idle
  });

  it("a zero-output step never schedules the idle", async () => {
    const sid = "tp7";
    open(sid, [row("a1", "assistant", T0)]);
    await sseFlush("session.next.step.ended", {
      sessionID: sid,
      assistantMessageID: "a1",
      timestamp: T0,
      finish: "stop",
      tokens: tok({ input: 5, output: 0 }),
    });
    assert.equal(pendingTimers(), 0);
  });

  it("v1 step-finish: zeroed usage is an announcement, not a measurement", async () => {
    const sid = "tp8";
    open(sid, [row("a1", "assistant", T0)]);
    await sseFlush("message.part.updated", {
      sessionID: sid,
      timestamp: T0,
      part: {
        id: "sf1",
        messageID: "a1",
        sessionID: sid,
        type: "step-finish",
        tokens: tok(),
        cost: 0,
      },
    });
    assert.equal(usageOf(sid), undefined);
    await sseFlush("message.part.updated", {
      sessionID: sid,
      timestamp: T0 + 1,
      part: {
        id: "sf2",
        messageID: "a1",
        sessionID: sid,
        type: "step-finish",
        tokens: tok({ input: 5, total: 5 }),
        cost: 0.25,
      },
    });
    assert.equal(usageOf(sid)?.tokens.input, 5);
    const a1 = findRow(sid, "a1");
    assert.equal(a1?.info.tokens?.input, 5);
    assert.equal(a1?.info.cost, 0.25);
  });

  it("v2 step.ended: zeroed usage is an announcement, not a measurement", async () => {
    const sid = "tpz";
    sessions.value = [sessRow(sid)];
    open(sid, [row("a1", "assistant", T0)]);
    await sseFlush("session.next.step.ended", {
      sessionID: sid,
      assistantMessageID: "a1",
      timestamp: T0,
      tokens: tok(),
      cost: 0,
    });
    assert.equal(usageOf(sid), undefined);
    const before = sessions.value.find((s) => s.id === sid)?.tokens.input;
    await sseFlush("session.next.step.ended", {
      sessionID: sid,
      assistantMessageID: "a1",
      timestamp: T0 + 1,
      tokens: tok({ input: 5, total: 5 }),
      cost: 0.25,
    });
    assert.equal(usageOf(sid)?.tokens.input, 5);
    const sess = sessions.value.find((s) => s.id === sid);
    assert.equal(sess?.tokens.input, (before ?? 0) + 5);
    assert.equal(sess?.cost, 0.25);
  });

  it("v1 step-finish accumulates, stamps the boundary, and calibrates the ratio", async () => {
    const sid = "sfcal";
    open(sid, [row("a1", "assistant", T0)]);
    setBusy(sid);
    await sseFlush("message.part.delta", {
      sessionID: sid,
      messageID: "a1",
      partID: "p1",
      delta: "0123456789",
    });
    await sseFlush("message.part.updated", {
      sessionID: sid,
      timestamp: T0,
      part: {
        id: "sf1",
        messageID: "a1",
        sessionID: sid,
        type: "step-finish",
        tokens: tok({ input: 5, output: 12, reasoning: 8 }),
        cost: 0.25,
      },
    });
    let a1 = findRow(sid, "a1");
    assert.equal(a1?.info.tokens?.output, 12);
    assert.equal(a1?.info.tokens?.reasoning, 8);
    assert.equal(a1?.info.reportedChars, 10);
    // The row keeps streaming past the boundary; a second step adds on.
    await sseFlush("message.part.delta", {
      sessionID: sid,
      messageID: "a1",
      partID: "p1",
      delta: "abc",
    });
    await sseFlush("message.part.updated", {
      sessionID: sid,
      timestamp: T0 + 1,
      part: {
        id: "sf2",
        messageID: "a1",
        sessionID: sid,
        type: "step-finish",
        tokens: tok({ output: 6, reasoning: 2 }),
      },
    });
    a1 = findRow(sid, "a1");
    assert.equal(a1?.info.tokens?.output, 18);
    assert.equal(a1?.info.tokens?.reasoning, 10);
    assert.equal(a1?.info.reportedChars, 13);
    // The streamed-chars/usage pairs feed the tail estimator's ratio: one
    // dominant pair (1M chars / 100M tokens â†’ 0.01) pins it regardless of
    // whatever earlier tests contributed.
    await sseFlush("message.part.delta", {
      sessionID: sid,
      messageID: "a1",
      partID: "p2",
      delta: "x".repeat(500_000),
    });
    await sseFlush("message.part.delta", {
      sessionID: sid,
      messageID: "a1",
      partID: "p2",
      delta: "x".repeat(500_000),
    });
    await sseFlush("message.part.updated", {
      sessionID: sid,
      timestamp: T0 + 2,
      part: {
        id: "sf3",
        messageID: "a1",
        sessionID: sid,
        type: "step-finish",
        tokens: tok({ output: 100_000_000 }),
      },
    });
    assert.ok(Math.abs(charsPerToken() - 0.01) < 1e-3);
  });

  it("v2 step.ended calibrates only tool-free rows and still accumulates", async () => {
    const sid = "v2cal";
    setBusy(sid);
    open(sid, [
      {
        info: { id: "a1", role: "assistant", time: { created: T0 } },
        parts: [textPart("p1", "a1", sid, "x".repeat(1_000_000))],
      },
    ]);
    await sseFlush("session.next.step.ended", {
      sessionID: sid,
      assistantMessageID: "a1",
      timestamp: T0,
      tokens: tok({ output: 100_000_000 }),
    });
    assert.ok(Math.abs(charsPerToken() - 0.01) < 1e-3);
    // A tool-carrying row bills the call's tokens against almost no chars:
    // the extreme pair must not recalibrate the ratio.
    open(sid, [
      {
        info: { id: "a1", role: "assistant", time: { created: T0 } },
        parts: [textPart("p1", "a1", sid, "x".repeat(1_000_000))],
      },
      {
        info: { id: "a2", role: "assistant", time: { created: T0 + 1 } },
        parts: [toolPart("t1", "a2", sid, { path: "f" }), textPart("p2", "a2", sid, "hi")],
      },
    ]);
    await sseFlush("session.next.step.ended", {
      sessionID: sid,
      assistantMessageID: "a2",
      timestamp: T0 + 2,
      tokens: tok({ output: 10_000_000 }),
    });
    assert.ok(Math.abs(charsPerToken() - 0.01) < 1e-3);
    // The step's own numbers still land on the row.
    const a2 = findRow(sid, "a2");
    assert.equal(a2?.info.tokens?.output, 10_000_000);
    assert.equal(a2?.info.reportedChars, 2);
    assert.equal(a2?.info.time.completed, T0 + 2);
  });

  it("v2 step.ended skips the compaction summarizer for ring and session sums", async () => {
    const sid = "v2comp";
    sessions.value = [sessRow(sid)];
    open(sid, [
      {
        info: {
          id: "c1",
          role: "assistant",
          agent: "compaction",
          time: { created: T0 },
        },
        parts: [textPart("p1", "c1", sid, "summary text")],
      },
    ]);
    setBusy(sid);
    await sseFlush("session.next.step.ended", {
      sessionID: sid,
      assistantMessageID: "c1",
      timestamp: T0,
      tokens: tok({ input: 5000, output: 100 }),
    });
    // The summarizer's usage measures the summary turn, not the session's
    // context: the ring's freshest-step slot and the session sums stay
    // untouched, while the row keeps its own numbers.
    assert.equal(usageOf(sid), undefined);
    assert.equal(
      sessions.value.find((s) => s.id === sid)?.tokens.input,
      0,
    );
    assert.equal(findRow(sid, "c1")?.info.tokens?.output, 100);
  });

  it("compaction steps never touch the ring numbers", async () => {
    const sid = "tp9";
    open(sid, [
      {
        info: {
          id: "a1",
          role: "assistant",
          time: { created: T0 },
          agent: "compaction",
        },
        parts: [],
      },
    ]);
    await sseFlush("message.part.updated", {
      sessionID: sid,
      timestamp: T0,
      part: {
        id: "sf1",
        messageID: "a1",
        sessionID: sid,
        type: "step-finish",
        tokens: tok({ input: 9, total: 9 }),
      },
    });
    assert.equal(usageOf(sid), undefined);
    assert.equal(findRow(sid, "a1")?.info.tokens, undefined);
  });

  it("session.created normalizes a flat row", async () => {
    await sseFlush("session.created", {
      info: { ...sessRow("nw1"), location: undefined, directory: "C:\\other" },
    });
    assert.equal(
      sessions.value.find((s) => s.id === "nw1")?.location.directory,
      "C:\\other",
    );
  });
});

describe("asks: permissions and questions", () => {
  it("docks and normalizes v1 asks, retires the turn on reject", async () => {
    const sid = "ak1";
    open(sid, [row("u1", "user", T0)]);
    setBusy(sid);
    await sseFlush("permission.asked", {
      id: "per1",
      sessionID: sid,
      permission: "bash",
      patterns: ["rm -rf"],
      always: [],
      tool: { messageID: "a1", callID: "c1" },
    });
    const p = pendingPermissions.value[0];
    assert.equal(p.id, "per1");
    assert.equal(p.action, "bash");
    assert.equal(p.v1, true);
    await sseFlush("permission.replied", {
      sessionID: sid,
      requestID: "per1",
      reply: "reject",
    });
    assert.equal(pendingPermissions.value.length, 0);
    assert.equal(sessionStatus.value[sid]?.type, "idle");
    assert.ok(interruptedPrompts.value.has("u1"));
  });

  it("docks v2 asks with the same facts", async () => {
    await sseFlush("permission.v2.asked", {
      id: "per2",
      sessionID: "ak2",
      action: "edit",
      resources: ["a.ts"],
      save: ["save:a.ts"],
    });
    const p = pendingPermissions.value.find((x) => x.id === "per2");
    assert.equal(p?.action, "edit");
    assert.equal(p?.v1, false);
    assert.deepEqual(p?.save, ["save:a.ts"]);
  });

  it("question.asked flags the v1 pipeline; reject retires", async () => {
    const sid = "ak3";
    open(sid, [row("u1", "user", T0)]);
    setBusy(sid);
    await sseFlush("question.asked", {
      id: "qq1",
      sessionID: sid,
      questions: [{ question: "which?", header: "Q", options: [] }],
    });
    assert.equal(pendingQuestions.value[0].v1, true);
    await sseFlush("question.rejected", { sessionID: sid, requestID: "qq1" });
    assert.equal(pendingQuestions.value.length, 0);
    assert.equal(sessionStatus.value[sid]?.type, "idle");
  });
});

// A session-open refresh must never retire an ask its own pipeline's list
// did not confirm absent: 1.18.30 serves tool asks on /permission only (the
// /api per-session route reads a registry tools never write), so a wiped
// dock locks the turn behind an ask the UI can no longer answer.
describe("ask refresh is pipeline-scoped", () => {
  it("keeps a docked v1 ask when the v1 list fails to load", async () => {
    const sid = "ak4";
    await sseFlush("permission.asked", {
      id: "per4",
      sessionID: sid,
      permission: "bash",
      patterns: ["cargo test"],
      always: [],
    });
    onApi((call) => {
      if (call.path === `/api/session/${sid}/permission`) return { data: [] };
      if (call.path === "/permission") return API_FAIL;
      return undefined;
    });
    await refreshPermissions(sid);
    assert.equal(pendingPermissions.value.length, 1);
    assert.equal(pendingPermissions.value[0].id, "per4");
  });

  it("retires the v1 ask once the v1 list loads without it", async () => {
    const sid = "ak5";
    await sseFlush("permission.asked", {
      id: "per5",
      sessionID: sid,
      permission: "bash",
      patterns: ["cargo test"],
      always: [],
    });
    onApi((call) => {
      if (call.path === `/api/session/${sid}/permission`) return { data: [] };
      if (call.path === "/permission") return [];
      return undefined;
    });
    await refreshPermissions(sid);
    assert.equal(pendingPermissions.value.length, 0);
  });

  it("keeps a docked v2 ask when the v2 list fails to load", async () => {
    const sid = "ak6";
    await sseFlush("permission.v2.asked", {
      id: "per6",
      sessionID: sid,
      action: "edit",
      resources: ["a.ts"],
      save: [],
    });
    onApi((call) => {
      if (call.path === `/api/session/${sid}/permission`) return API_FAIL;
      if (call.path === "/permission") return [];
      return undefined;
    });
    await refreshPermissions(sid);
    assert.equal(pendingPermissions.value.length, 1);
    assert.equal(pendingPermissions.value[0].v1 ?? false, false);
  });

  it("keeps a docked v1 question when the global list fails to load", async () => {
    const sid = "ak7";
    await sseFlush("question.asked", {
      id: "qq7",
      sessionID: sid,
      questions: [{ question: "which?", header: "Q", options: [] }],
    });
    onApi((call) => {
      if (call.path === `/api/session/${sid}/question`) return { data: [] };
      if (call.path === "/question") return API_FAIL;
      return undefined;
    });
    await refreshQuestions(sid);
    assert.equal(pendingQuestions.value.length, 1);
  });

  it("retires the v1 question once the global list loads without it", async () => {
    const sid = "ak8";
    await sseFlush("question.asked", {
      id: "qq8",
      sessionID: sid,
      questions: [{ question: "which?", header: "Q", options: [] }],
    });
    onApi((call) => {
      if (call.path === `/api/session/${sid}/question`) return { data: [] };
      if (call.path === "/question") return [];
      return undefined;
    });
    await refreshQuestions(sid);
    assert.equal(pendingQuestions.value.length, 0);
  });
});

// The chip's pulse and stop button follow the child's status: a retrying
// provider step is mid-turn (backoffs run minutes), and a failed step under
// the server's retry policy is not a turn end — the server's own idle truth
// settles it.
describe("a retrying turn stays working", () => {
  it("counts retry as working (sessionWorking)", async () => {
    const sid = "rk1";
    await sseFlush("session.next.step.started", { sessionID: sid });
    assert.equal(sessionWorking(sid), true);
    await sseFlush("session.status", {
      sessionID: sid,
      status: { type: "retry", attempt: 2, message: "429" },
    });
    assert.equal(sessionWorking(sid), true);
    await sseFlush("session.status", {
      sessionID: sid,
      status: { type: "idle" },
    });
    assert.equal(sessionWorking(sid), false);
  });

  it("a failed step holds busy through the grace; idle truth settles it", async () => {
    const sid = "rk2";
    await sseFlush("session.next.step.started", { sessionID: sid });
    await sseFlush("session.next.step.failed", { sessionID: sid });
    assert.equal(sessionStatus.value[sid]?.type, "busy");
    await sseFlush("session.status", {
      sessionID: sid,
      status: { type: "retry", attempt: 1 },
    });
    // The grace must not idle over a live retry status.
    fireExact(3000);
    assert.equal(sessionWorking(sid), true);
    await sseFlush("session.idle", { sessionID: sid });
    assert.equal(sessionWorking(sid), false);
  });

  it("a failed step with no follow-up idles after the grace", async () => {
    const sid = "rk3";
    open(sid, [row("u1", "user", T0)]);
    await sseFlush("session.next.step.started", { sessionID: sid });
    await sseFlush("session.next.step.failed", { sessionID: sid });
    fireExact(3000);
    assert.equal(sessionStatus.value[sid]?.type, "idle");
  });
});

describe("session.error", () => {
  it("surfaces the failure and retires the turn", async () => {
    const sid = "se1";
    open(sid, [row("u1", "user", T0)]);
    setBusy(sid);
    await sseFlush("session.error", {
      sessionID: sid,
      error: { name: "RetryError", data: { message: "boom" } },
    });
    assert.equal(sessionStatus.value[sid]?.type, "idle");
    assert.deepEqual(sendError.value, { for: sid, text: "boom" });
  });
  it("reads the flat message of v2's structured error", async () => {
    const sid = "se3";
    open(sid, [row("u1", "user", T0)]);
    setBusy(sid);
    await sseFlush("session.error", {
      sessionID: sid,
      error: {
        type: "AI_APICallError",
        message: "glm-5.3 does not support image input",
      },
    });
    assert.equal(
      sendError.value?.text,
      "glm-5.3 does not support image input",
    );
  });
  it("stays silent for a user-stopped turn (Interrupted tells it)", async () => {
    const sid = "se2";
    open(sid, [row("u1", "user", T0)]);
    setBusy(sid);
    markPromptStopped("u1");
    await sseFlush("session.error", {
      sessionID: sid,
      error: { name: "Aborted" },
    });
    assert.equal(sendError.value, undefined);
  });
});

describe("stop and interrupt", () => {
  it("stopSession marks the turn, aborts, and retires", async () => {
    const sid = "st1";
    sessions.value = [sessRow(sid)];
    open(sid, [row("u1", "user", T0)]);
    setBusy(sid);
    await stopSession(sid);
    assert.equal(callsFor(`/session/${sid}/abort`).length, 1);
    assert.equal(sessionStatus.value[sid]?.type, "idle");
    assert.ok(stoppedPrompts.value.has("u1"));
    assert.ok(interruptedPrompts.value.has("u1"));
  });
  it("a failed abort unmarks the turn", async () => {
    const sid = "st2";
    open(sid, [row("u1", "user", T0)]);
    onApi((call) =>
      call.path.startsWith(`/session/${sid}/abort`) ? API_FAIL : undefined,
    );
    await stopSession(sid);
    assert.equal(sendError.value?.text, "Could not interrupt the session.");
    assert.equal(stoppedPrompts.value.has("u1"), false);
  });
});

// ff714f0 (store side: the trigger echo and the summarize call)
describe("/compact (store side of ff714f0)", () => {
  it("refuses a draft, a blank session, and a busy turn", async () => {
    await runSlashCommand("draft", "/compact");
    assert.equal(
      sendError.value?.text,
      "Nothing to compact yet — send a message first.",
    );
    const sid = "cp1";
    open(sid, [row("u1", "user", T0)]);
    await runSlashCommand(sid, "/compact");
    assert.equal(
      sendError.value?.text,
      "Nothing to compact yet — send a message first.",
    );
    setBusy(sid);
    open(sid, [
      row("u1", "user", T0),
      row("a1", "assistant", T0 + 1, { providerID: "p1", modelID: "m1" }),
    ]);
    await runSlashCommand(sid, "/compact");
    assert.equal(sendError.value?.text, "Wait for the running turn to finish.");
  });
  it("runs the summarize call and echoes the trigger line", async () => {
    const sid = "cp2";
    open(sid, [
      row("u1", "user", T0),
      row("a1", "assistant", T0 + 1, { providerID: "pp", modelID: "mm" }),
    ]);
    await runSlashCommand(sid, "/compact");
    const calls = callsFor(`/session/${sid}/summarize`);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body, { providerID: "pp", modelID: "mm" });
    const echo = listOf(sid).find((m) => m.info.id.startsWith("pending:"));
    assert.equal((echo?.parts[0] as { text?: string }).text, "/compact");
    assert.equal(sessionStatus.value[sid]?.type, "idle");
  });
  it("a /compact queued behind a running turn fires when it idles", async () => {
    const sid = "cp4";
    open(sid, [
      row("u1", "user", T0),
      row("a1", "assistant", T0 + 1, { providerID: "pp", modelID: "mm" }),
    ]);
    setBusy(sid);
    queueCommand(sid, "/compact");
    assert.equal(queuedTurns.value.length, 1);
    await sseFlush("session.idle", { sessionID: sid });
    await settle(4);
    // The flush effect's own optimistic busy must not refuse the compact.
    assert.equal(queuedTurns.value.length, 0);
    assert.equal(callsFor(`/session/${sid}/summarize`).length, 1);
    assert.equal(sendError.value?.text, undefined);
    // The run completed — its queue-time echo retires with it. One run,
    // one local row gone: nothing doubles.
    const echoes = listOf(sid).filter((m) =>
      m.info.id.startsWith("pending:") || m.info.id.startsWith("cmd:"),
    );
    assert.equal(echoes.length, 0);
  });
  it("three queued compacts fire head-first without duplicate echoes", async () => {
    const sid = "cp5";
    open(sid, [
      row("u1", "user", T0),
      row("a1", "assistant", T0 + 1, { providerID: "pp", modelID: "mm" }),
    ]);
    setBusy(sid);
    queueCommand(sid, "/compact");
    queueCommand(sid, "/compact");
    queueCommand(sid, "/compact");
    assert.equal(queuedTurns.value.length, 3);
    await sseFlush("session.idle", { sessionID: sid });
    await settle(10);
    assert.equal(queuedTurns.value.length, 0);
    assert.equal(callsFor(`/session/${sid}/summarize`).length, 3);
    // Each run retires its own queue-time echo — three runs, zero local
    // rows left.
    const bubbles = listOf(sid).filter(
      (m) =>
        m.info.role === "user" &&
        (m.info.id.startsWith("pending:") || m.info.id.startsWith("cmd:")),
    );
    assert.equal(bubbles.length, 0);
  });
  it("a queued compact's echo retires when its run completes", async () => {
    const sid = "cp6";
    open(sid, [
      row("u1", "user", T0),
      row("a1", "assistant", T0 + 1, { providerID: "pp", modelID: "mm" }),
    ]);
    setBusy(sid);
    queueCommand(sid, "/compact");
    assert.ok(queuedTurns.value[0].echoCid);
    // The real server writes the run's rows with no "/compact" text: a
    // trigger user row (a lone `compaction` part) and the summary. Serve
    // them on the legacy route the post-run refresh reads.
    onApi(
      messageMock(
        sid,
        () => ({ data: [] }),
        () => [
          {
            info: { id: "srv_t", role: "user", time: { created: Date.now() } },
            parts: [
              { id: "srv_t:0", messageID: "srv_t", sessionID: sid, type: "compaction" },
            ],
          },
          {
            info: { id: "srv_s", role: "assistant", agent: "compaction", time: { created: Date.now() + 1 } },
            parts: [],
          },
        ],
      ),
    );
    await sseFlush("session.idle", { sessionID: sid });
    await settle(6);
    // Exactly one local record per run, retired on completion: nothing
    // with "/compact" text remains, and the server's rows merged in.
    const bubbles = listOf(sid).filter(
      (m) =>
        m.info.role === "user" &&
        (m.info.id.startsWith("pending:") || m.info.id.startsWith("cmd:")),
    );
    assert.equal(bubbles.length, 0);
    assert.ok(findRow(sid, "srv_t"));
    assert.ok(findRow(sid, "srv_s"));
  });
  it("a refresh pairs durable /compact echoes with the server's rows one-to-one", async () => {
    const sid = "cp7";
    open(sid, [
      row("u1", "user", T0),
      row("a1", "assistant", T0 + 1, { providerID: "pp", modelID: "mm" }),
    ]);
    // Three durable echoes (two stand for orphans an older build left);
    // busy holds the flush so the echoes stay put.
    setBusy(sid);
    queueCommand(sid, "/compact");
    queueCommand(sid, "/compact");
    queueCommand(sid, "/compact");
    // The server has run twice: two "/compact" rows postdating the echoes.
    const now = Date.now();
    onApi(
      messageMock(sid, () => ({ data: [] }), () => [
        {
          info: { id: "sv1", role: "user", time: { created: now } },
          parts: [textPart("sv1:0", "sv1", sid, "/compact")],
        },
        {
          info: { id: "sv2", role: "user", time: { created: now + 1 } },
          parts: [textPart("sv2:0", "sv2", sid, "/compact")],
        },
      ]),
    );
    await refreshMessages(sid);
    const lines = listOf(sid).filter(
      (m) =>
        m.info.role === "user" &&
        (m.parts[0] as { text?: string }).text === "/compact",
    );
    // Two server rows plus the one unpaired echo (its run is still owed).
    assert.equal(lines.length, 3);
    assert.equal(lines.filter((m) => m.info.id.startsWith("cmd:")).length, 1);
  });
  it("reports a failed compaction", async () => {
    const sid = "cp3";
    open(sid, [
      row("u1", "user", T0),
      row("a1", "assistant", T0 + 1, { providerID: "pp", modelID: "mm" }),
    ]);
    onApi((call) =>
      call.path.startsWith(`/session/${sid}/summarize`) ? API_FAIL : undefined,
    );
    await runSlashCommand(sid, "/compact");
    assert.equal(sendError.value?.text, "The session could not be compacted.");
    assert.equal(
      listOf(sid).some((m) => m.info.id.startsWith("pending:")),
      false,
    );
  });
});

describe("sendPrompt", () => {
  it("draft: creates the session, rides the pick, moves files, posts", async () => {
    agents.value = [{ name: "reviewer", mode: "subagent" }];
    setSelection(undefined, { agent: "plan" });
    onApi((call) => {
      if (call.method === "POST" && call.path === "/session")
        return sessRow("d1");
      return undefined;
    });
    composerFiles.value = {
      ...composerFiles.value,
      draft: [{ uri: "data:image/png;base64,AA", name: "p.png" }],
    };
    navigate({ view: "draft" });
    const files = [{ uri: "data:image/png;base64,AA", name: "p.png" }];
    await sendPrompt("draft", "cc @reviewer", files);
    assert.deepEqual(route.value, { view: "session", id: "d1" });
    assert.equal((callsFor("/session")[0].body as { agent?: string }).agent, "plan");
    assert.deepEqual(composerFiles.value.draft, []);
    // a successful send clears the session's attachments (they were sent)
    assert.deepEqual(composerFiles.value["d1"], []);
    const body = callsFor("/session/d1/prompt_async")[0].body as {
      parts: { type: string; name?: string; mime?: string }[];
    };
    assert.equal(body.parts[0].type, "text");
    assert.ok(
      body.parts.some((p) => p.type === "file" && p.mime === "image/png"),
    );
    assert.ok(
      body.parts.some((p) => p.type === "agent" && p.name === "reviewer"),
    );
    assert.ok(listOf("d1").some((m) => m.info.id.startsWith("pending:")));
  });
  it("failure keeps the echo and reports", async () => {
    const sid = "sp2";
    open(sid, []);
    onApi((call) =>
      call.path.startsWith(`/session/${sid}/prompt_async`)
        ? API_FAIL
        : undefined,
    );
    await sendPrompt(sid, "hi");
    // The composer already cleared — the bubble is the only copy of the
    // text, so a failed send must not delete it.
    assert.equal(
      listOf(sid).some((m) => m.info.id.startsWith("pending:")),
      true,
    );
    assert.equal(sendError.value?.text, "The message could not be sent.");
  });
  it("failure carries the relay's reason", async () => {
    const sid = "sp3";
    open(sid, []);
    onApi((call) =>
      call.path.startsWith(`/session/${sid}/prompt_async`)
        ? apiFailWith("HTTP 500: Internal error")
        : undefined,
    );
    await sendPrompt(sid, "hi");
    assert.equal(
      sendError.value?.text,
      "The message could not be sent: HTTP 500: Internal error.",
    );
  });

  it("an idle during the POST flight keeps the echo until its row lands", async () => {
    const sid = "sp4";
    open(sid, []);
    await sendPrompt(sid, "in flight");
    // v1 prompt_async replies before any row exists — the POST is still
    // outstanding server-side when a stray idle lands.
    await sseFlush("session.idle", { sessionID: sid });
    assert.ok(
      listOf(sid).some((m) => m.info.id.startsWith("pending:")),
      "echo must survive an idle while its POST is outstanding",
    );
    await sseFlush("message.updated", {
      sessionID: sid,
      info: { id: "u4", role: "user", time: { created: T0 } },
    });
    assert.equal(
      listOf(sid).some((m) => m.info.id.startsWith("pending:")),
      false,
    );
    assert.ok(findRow(sid, "u4"));
  });

  it("one landed user row retires only one of two in-flight echoes", async () => {
    const sid = "sp5";
    setBusy(sid);
    await sendPrompt(sid, "first steer");
    await sendPrompt(sid, "second steer");
    const echoes = () =>
      listOf(sid).filter((m) => m.info.id.startsWith("pending:"));
    assert.equal(echoes().length, 2);
    await sseFlush("message.updated", {
      sessionID: sid,
      info: { id: "u1", role: "user", time: { created: T0 } },
    });
    assert.equal(echoes().length, 1, "the second steer's bubble must stay");
    await sseFlush("message.updated", {
      sessionID: sid,
      info: { id: "u2", role: "user", time: { created: T0 + 1 } },
    });
    assert.equal(echoes().length, 0);
    assert.ok(findRow(sid, "u1") && findRow(sid, "u2"));
  });

  it("a row delivered mid-fetch survives the refresh that missed it", async () => {
    const sid = "sp6";
    const now = Date.now();
    open(sid, [
      row("old", "user", T0),
      row("live1", "user", now),
    ]);
    onApi(
      messageMock(sid, {
        data: [{ id: "old", type: "user", time: { created: T0 }, text: "a" }],
        cursor: {},
      }),
    );
    await refreshMessages(sid);
    const ids = listOf(sid).map((m) => m.info.id);
    assert.ok(ids.includes("live1"), "the streamed row must survive");
    assert.ok(!ids.includes("gone"), "nothing stale is kept");
    assert.ok(ids.includes("old"));
  });

  it("v2: an undelivered inbox row survives a refresh that can't serve it", async () => {
    setDialect("v2");
    try {
      const sid = "sp7";
      sessions.value = [sessRow(sid, { agent: "build" })];
      open(sid, []);
      const created = Date.now() - 30_000;
      onApi((call) => {
        if (call.method === "POST" && call.path === `/api/session/${sid}/prompt`)
          return {
            data: {
              id: "usr_v2",
              sessionID: sid,
              time: { created },
              type: "user",
              payload: { text: "still in the inbox" },
              delivery: "steer",
            },
          };
        return messageMock(sid, { data: [], cursor: {} })(call);
      });
      await sendPrompt(sid, "still in the inbox");
      // The POST reply landed the row and retired the echo.
      assert.ok(findRow(sid, "usr_v2"));
      assert.ok(!listOf(sid).some((m) => m.info.id.startsWith("pending:")));
      // v2 serves the admitted row only at first step start — the refresh
      // mid-gap must not read its absence as a server-side deletion.
      await refreshMessages(sid);
      assert.ok(findRow(sid, "usr_v2"), "the young user row must survive");
    } finally {
      setDialect("v1");
    }
  });
  it("an old user row missing from the fetch is still dropped", async () => {
    const sid = "sp8";
    open(sid, [row("dead", "user", T0)]);
    onApi(messageMock(sid, { data: [], cursor: {} }));
    await refreshMessages(sid);
    assert.ok(!findRow(sid, "dead"), "server-side deletion must clear it");
  });
  it("a young assistant row missing from the fetch is still dropped", async () => {
    const sid = "sp9";
    open(sid, [row("a9", "assistant", Date.now() - 30_000)]);
    onApi(messageMock(sid, { data: [], cursor: {} }));
    await refreshMessages(sid);
    assert.ok(!findRow(sid, "a9"), "the user-row grace covers user rows only");
  });
});

describe("newSession and blank hiding", () => {
  it("a failed create reports the relay's reason", async () => {
    onApi((call) =>
      call.method === "POST" && call.path === "/session"
        ? apiFailWith("HTTP 500: nope")
        : undefined,
    );
    await newSession();
    assert.equal(
      sendError.value?.text,
      "Could not create the session: HTTP 500: nope.",
    );
  });
  it("creates, opens, and hides as blank until touched", async () => {
    onApi((call) => {
      if (call.method === "POST" && call.path === "/session")
        return sessRow("n1");
      return undefined;
    });
    await newSession();
    assert.deepEqual(route.value, { view: "session", id: "n1" });
    const created = sessions.value.find((s) => s.id === "n1");
    assert.ok(created);
    assert.ok(isEmptySession(created));
    await sseFlush("session.updated", {
      info: sessRow("n1", { time: { created: T0, updated: T0 + 1 } }),
    });
    const refreshed = sessions.value.find((s) => s.id === "n1");
    assert.ok(refreshed);
    assert.equal(isEmptySession(refreshed), false);
  });
});

describe("selection", () => {
  it("defaultAgent skips hidden primaries", () => {
    agents.value = [
      { name: "ghost", mode: "primary", hidden: true },
      { name: "plan", mode: "primary" },
    ];
    assert.equal(defaultAgent(), "plan");
  });
  it("currentSelection falls back through row, draft, and server default", () => {
    agents.value = [];
    assert.deepEqual(currentSelection(undefined), {
      agent: "build",
      model: undefined,
    });
    const sid = "sel1";
    sessions.value = [
      sessRow(sid, {
        agent: "plan",
        model: { id: "m1", providerID: "p1" },
      }),
    ];
    assert.deepEqual(currentSelection(sid), {
      agent: "plan",
      model: { id: "m1", providerID: "p1" },
    });
  });
  it("setSelection switches agent on the server and patches the row", async () => {
    setDialect("v2");
    try {
      const sid = "sel2";
      sessions.value = [sessRow(sid)];
      await setSelection(sid, { agent: "plan" });
      assert.equal(callsFor(`/api/session/${sid}/agent`).length, 1);
      assert.equal(sessions.value.find((s) => s.id === sid)?.agent, "plan");
    } finally {
      setDialect("v1");
    }
  });
  it("v1 picker switches ride the next prompt instead of the switch routes", async () => {
    const sid = "sel3";
    sessions.value = [
      sessRow(sid, {
        agent: "build",
        model: { id: "m1", providerID: "p1" },
      }),
    ];
    open(sid, []);
    await setSelection(sid, {
      model: { providerID: "oc", id: "free", variant: "high" },
    });
    await setSelection(sid, { agent: "plan" });
    assert.equal(callsFor(`/api/session/${sid}/model`).length, 0);
    assert.equal(callsFor(`/api/session/${sid}/agent`).length, 0);
    assert.deepEqual(currentSelection(sid).model, {
      providerID: "oc",
      id: "free",
      variant: "high",
    });
    assert.equal(currentSelection(sid).agent, "plan");
    assert.equal(sessions.value.find((s) => s.id === sid)?.agent, "plan");
    await sendPrompt(sid, "hi");
    const body = callsFor(`/session/${sid}/prompt_async`)[0].body as {
      agent?: string;
      model?: { providerID?: string; modelID?: string };
      variant?: string;
    };
    assert.equal(body.agent, "plan");
    assert.deepEqual(body.model, { providerID: "oc", modelID: "free" });
    assert.equal(body.variant, "high");
  });
});

describe("catalog helpers", () => {
  before(() => {
    providers.value = {
      all: [
        {
          id: "zai",
          models: {
            m1: {
              name: "M One",
              limit: { context: 123_456 },
              variants: { low: {}, high: {} },
              cost: { input: 0, output: 0 },
            },
            m2: {},
            m3: {
              capabilities: { input: { text: true, audio: true } },
            },
          },
        },
      ],
      default: {},
      connected: ["zai"],
    } as unknown as Providers;
  });
  it("contextLimit looks up, else 200k", () => {
    assert.equal(contextLimit({ providerID: "zai", modelID: "m1" }), 123_456);
    assert.equal(contextLimit({ providerID: "zai", modelID: "zz" }), 200_000);
    assert.equal(contextLimit(), 200_000);
  });
  it("modelLabel prefers the catalog name", () => {
    assert.equal(modelLabel({ providerID: "zai", id: "m1" }), "M One");
    assert.equal(modelLabel({ providerID: "x", id: "pfx/m2" }), "m2");
    assert.equal(modelLabel(undefined), "");
  });
  it("modelVariants lists effort keys; modelFree needs zero cost", () => {
    assert.deepEqual(modelVariants({ providerID: "zai", id: "m1" }), [
      "low",
      "high",
    ]);
    assert.deepEqual(modelVariants(undefined), []);
    assert.equal(modelFree({ providerID: "zai", id: "m1" }), true);
    assert.equal(modelFree({ providerID: "zai", id: "m2" }), false);
  });
  it("displayModel re-homes the model under a connected provider", () => {
    assert.deepEqual(displayModel({ providerID: "cfg", id: "m1" }), {
      providerID: "zai",
      id: "m1",
    });
    assert.deepEqual(displayModel({ providerID: "cfg", id: "zz" }), {
      providerID: "cfg",
      id: "zz",
    });
  });
  it("attachInputs resolves the session model's flags, else undefined", () => {
    const sid = "ai1";
    sessions.value = [
      sessRow(sid, { model: { id: "m3", providerID: "zai" } }),
    ];
    assert.deepEqual(attachInputs(sid), { text: true, audio: true });
    // A model the catalog doesn't know (here: wrong provider) is unknown.
    const other = "ai2";
    sessions.value = [
      ...sessions.value.filter((s) => s.id !== other),
      sessRow(other, { model: { id: "m3", providerID: "nope" } }),
    ];
    assert.equal(attachInputs(other), undefined);
    sessions.value = [];
  });
});

describe("refreshBase keeps the provider catalog as reported", () => {
  it("lists every connected provider and parses the default model", async () => {
    onApi((call) => {
      if (call.path === "/provider")
        return {
          all: [{ id: "pa", models: {} }, { id: "pz", models: {} }],
          default: {},
          connected: ["pa", "pz"],
        };
      if (call.path === "/config") return { model: "pa/m9", provider: { pa: {} } };
      return undefined;
    });
    resyncFromServer(); // a full truth pull includes refreshBase
    await settle();
    assert.deepEqual(providers.value?.connected, ["pa", "pz"]);
    assert.deepEqual(serverDefaultModel.value, { providerID: "pa", id: "m9" });
  });
});

describe("display helpers", () => {
  it("fmtDur compacts durations", () => {
    assert.equal(fmtDur(59), "59s");
    assert.equal(fmtDur(95), "1m35s");
    assert.equal(fmtDur(3600), "1h");
    assert.equal(fmtDur(104_552), "1d5h2m32s");
  });
  it("normPath folds separators, drive case, and trailing slashes", () => {
    assert.equal(normPath("c:\\WORK\\repo\\"), "C:/WORK/repo");
    assert.equal(normPath("/x/y//"), "/x/y");
  });
  it("sessionTitle drops timestamps and subagent bookkeeping", () => {
    assert.equal(
      sessionTitle(
        { title: "New session - 2026-09-13T10:00:00Z" } as Session,
        "x",
      ),
      "New session",
    );
    assert.equal(
      sessionTitle({ title: "Do the thing (@general subagent)" } as Session, "x"),
      "Do the thing",
    );
    assert.equal(sessionTitle(undefined, "raw-id"), "raw-id");
  });
  it("sessionTitle labels untitled v2 rows, never with the id", () => {
    assert.equal(sessionTitle({ title: "" } as Session, "ses_raw"), "New session");
    assert.equal(
      sessionTitle({ parentID: "ses_parent" } as Session, "ses_raw"),
      "Child session",
    );
  });
  it("isSubagentSession recognizes both markers", () => {
    assert.ok(isSubagentSession(sessRow("s", { parentID: "p" })));
    assert.ok(isSubagentSession(sessRow("s", { title: "t (@x subagent)" })));
    assert.equal(isSubagentSession(sessRow("s")), false);
  });
  it("formatDateTime is fixed ISO order", () => {
    assert.equal(
      formatDateTime(new Date(2026, 8, 13, 14, 35, 29).getTime()),
      "2026-09-13 14:35:29",
    );
  });
  it("sessionTile colors from the project palette, else the folder hash", () => {
    projects.value = [
      { id: "pj", worktree: "C:\\work\\repo", icon: { color: "pink" } },
    ];
    currentDir.value = "C:\\work\\repo";
    const t1 = sessionTile(sessRow("s1"), "s1");
    assert.equal(t1.color, "#d6336c");
    assert.equal(t1.letter, "T");
    const t2 = sessionTile(undefined, "some-id");
    assert.notEqual(t2.color, "#d6336c");
  });
});

describe("resolveFileRef", () => {
  it("returns paths with a directory part as-is", async () => {
    assert.equal(await resolveFileRef("/abs/x.go"), "/abs/x.go");
  });
  it("prefers the most recently touched file", async () => {
    navigate({ view: "session", id: "fr1" });
    sessions.value = [sessRow("fr1")];
    open("fr1", [
      {
        info: { id: "a1", role: "assistant", time: { created: T0 } },
        parts: [
          toolPart("c1", "a1", "fr1", { filePath: "C:\\w\\deep\\client.go" }),
        ],
      },
    ]);
    assert.equal(await resolveFileRef("client.go"), "C:/w/deep/client.go");
  });
  it("falls back to the file index, shallowest first, absolutized", async () => {
    navigate({ view: "session", id: "fr2" });
    sessions.value = [sessRow("fr2")];
    open("fr2", []);
    onApi((call) => {
      if (call.path.startsWith("/find/file"))
        return ["deep\\nested\\path\\client.go", "src\\client.go"];
      return undefined;
    });
    assert.equal(await resolveFileRef("client.go"), "C:/work/repo/src/client.go");
  });
});

describe("revert fold", () => {
  it("folds the transcript at the pending revert marker", async () => {
    const sid = "rv1";
    sessions.value = [sessRow(sid, { revert: { messageID: "u2" } })];
    onApi(
      messageMock(sid, {
        data: [
          { id: "u1", type: "user", time: { created: 1 }, text: "one" },
          { id: "a1", type: "assistant", time: { created: 2 } },
          { id: "u2", type: "user", time: { created: 3 }, text: "two" },
          { id: "a2", type: "assistant", time: { created: 4 } },
        ],
        cursor: {},
      }),
    );
    await refreshMessages(sid);
    assert.deepEqual(
      listOf(sid).map((m) => m.info.id),
      ["u1", "a1"],
    );
  });
  it("revertSession adopts the marker row", async () => {
    const sid = "rv2";
    sessions.value = [sessRow(sid)];
    open(sid, []);
    onApi((call) => {
      if (call.method === "POST" && call.path.startsWith(`/session/${sid}/revert`))
        return sessRow(sid, { revert: { messageID: "u9" } });
      return undefined;
    });
    assert.equal(await revertSession(sid, "u9"), true);
    assert.deepEqual(sessions.value.find((s) => s.id === sid)?.revert, {
      messageID: "u9",
    });
  });
});

describe("unread tabs", () => {
  it("an idle turn in a background tab marks it unread until opened", async () => {
    const sid = "ur1";
    sessions.value = [sessRow(sid)];
    navigate({ view: "session", id: sid });
    navigate({ view: "session", id: "ur-other" });
    setBusy(sid);
    await sseFlush("session.idle", { sessionID: sid });
    assert.ok(unreadTabs.value.has(sid));
    navigate({ view: "session", id: sid });
    assert.equal(unreadTabs.value.has(sid), false);
    assert.equal(activeTab.value, sid);
  });
});

describe("hostMessage routing", () => {
  it("insert-text routes home to the draft composer", () => {
    hostMessage({ type: "insert-text", text: "hello" });
    assert.deepEqual(route.value, { view: "draft" });
    assert.deepEqual(composerInsert.value, {
      text: "hello",
      seq: 1,
      replace: false,
    });
    hostMessage({ type: "insert-text", text: "again" });
    assert.equal(composerInsert.value?.seq, 2);
  });
  it("hidden-models filters to strings", () => {
    hostMessage({ type: "hidden-models", ids: ["a", 2, "b"] });
    assert.deepEqual(hiddenModels.value, ["a", "b"]);
  });
  it("hidden-providers filters to strings", () => {
    hostMessage({ type: "hidden-providers", ids: ["zai", 1] });
    assert.deepEqual(hiddenProviders.value, ["zai"]);
  });
  it("peers builds the id â†’ name/title map", () => {
    hostMessage({
      type: "peers",
      peers: [
        { id: "ep1", name: "zen-garden", title: "Fix the rate" },
        { id: 2, name: "bad-id" },
        { id: "ep2", name: "", title: "empty name drops" },
        { id: "ep3", name: "no-title", title: 7 },
      ],
    });
    assert.deepEqual(peerNames.value, {
      ep1: { name: "zen-garden", title: "Fix the rate" },
      ep3: { name: "no-title", title: "" },
    });
  });
  it("files-picked filters unsupported types and lands on the draft", () => {
    // The draft's model (server default) is unknown to the catalog, so the
    // legacy allowlist applies: image+text pass, exe drops.
    providers.value = undefined;
    hostMessage({
      type: "files-picked",
      files: [
        { uri: "u1", name: "a.png" },
        { uri: "u2", name: "b.txt" },
        { uri: "u3", name: "c.exe" },
      ],
    });
    assert.equal(composerFiles.value.draft?.length, 2);
    assert.equal(
      sendError.value?.text,
      "1 file not attached (unsupported type).",
    );
  });
  it("files-picked drops a pdf the session model has no input for", () => {
    providers.value = {
      all: [
        {
          id: "zai",
          models: {
            m1: {
              capabilities: {
                input: { text: true, image: true, pdf: false },
              },
            },
          },
        },
      ],
      default: {},
      connected: ["zai"],
    } as unknown as Providers;
    const sid = "fp1";
    sessions.value = [
      sessRow(sid, { model: { id: "m1", providerID: "zai" } }),
    ];
    navigate({ view: "session", id: sid });
    hostMessage({
      type: "files-picked",
      files: [
        { uri: "u1", name: "a.pdf" },
        { uri: "u2", name: "b.png" },
      ],
    });
    assert.deepEqual(
      composerFiles.value[sid]?.map((f) => f.name),
      ["b.png"],
    );
    assert.equal(
      sendError.value?.text,
      "1 file not attached (not supported by this model).",
    );
    sessions.value = [];
  });
  it("files-picked rides a sniffed-text stamp as text/plain", () => {
    providers.value = undefined;
    const sid = "fp2";
    sessions.value = [sessRow(sid)];
    navigate({ view: "session", id: sid });
    hostMessage({
      type: "files-picked",
      files: [
        { uri: "u1", name: "notes.weird", text: true },
        { uri: "u2", name: "blob.bin" },
        { uri: "u3", name: "plain.txt" },
      ],
    });
    assert.deepEqual(
      composerFiles.value[sid]?.map((f) => f.name),
      ["notes.weird", "plain.txt"],
    );
    assert.equal(
      sendError.value?.text,
      "1 file not attached (unsupported type).",
    );
    sessions.value = [];
  });
  it("navigate maps /session/{id} and bounces unknown ids home", () => {
    sessions.value = [sessRow("nav1")];
    hostMessage({ type: "navigate", path: "/session/nav1" });
    assert.deepEqual(route.value, { view: "session", id: "nav1" });
    hostMessage({ type: "navigate", path: "/session/unknown" });
    assert.deepEqual(route.value, { view: "home" });
  });
  it("toggle-context flips the panel without errors", () => {
    hostMessage({ type: "toggle-context" });
    hostMessage({ type: "toggle-context" });
    assert.equal(sendError.value, undefined);
  });
});

describe("project rename", () => {
  it("patches the name into the projects list", async () => {
    projects.value = [
      { id: "prjA", worktree: "D:/work/alpha" },
      { id: "prjB", worktree: "D:/work/beta", name: "Kept" },
    ];
    onApi((call) => {
      if (call.method === "PATCH" && call.path.startsWith("/project/prjA"))
        return {};
      return undefined;
    });
    assert.equal(await renameProject("D:\\work\\alpha", "Alpha One"), true);
    assert.equal(projects.value[0].name, "Alpha One");
    assert.equal(projectDisplayName("D:/work/alpha"), "Alpha One");
    assert.equal(projectDisplayName("D:\\work\\beta"), "Kept");
    assert.equal(projectDisplayName("D:/work/missing"), "missing");
  });
  it("surfaces a server rejection without touching the list", async () => {
    projects.value = [{ id: "prjA", worktree: "D:/work/alpha" }];
    onApi((call) => {
      if (call.method === "PATCH") return API_FAIL;
      return undefined;
    });
    assert.equal(await renameProject("D:/work/alpha", "X"), false);
    assert.equal(projects.value[0].name, undefined);
    assert.equal(
      sendError.value?.text,
      "The rename was rejected by the server.",
    );
  });
});

describe("project and provider tile colors", () => {
  it("patches the color and carries it into session tiles", async () => {
    projects.value = [
      { id: "prjA", worktree: "C:/work/repo", icon: { color: "gray" } },
    ];
    currentDir.value = "C:\\work\\repo";
    let body: unknown;
    onApi((call) => {
      if (call.method === "PATCH" && call.path.startsWith("/project/prjA")) {
        body = call.body;
        return {};
      }
      return undefined;
    });
    assert.equal(await setProjectColor("C:\\work\\repo", "pink"), true);
    assert.equal(projects.value[0].icon?.color, "pink");
    assert.equal(sessionTile(sessRow("s1"), "s1").color, "#d6336c");
    assert.deepEqual(body, { icon: { color: "pink" } });
  });
  it("surfaces a rejection without changing the color", async () => {
    projects.value = [{ id: "prjA", worktree: "D:/work/alpha" }];
    onApi((call) => {
      if (call.method === "PATCH") return API_FAIL;
      return undefined;
    });
    assert.equal(await setProjectColor("D:/work/alpha", "blue"), false);
    assert.equal(projects.value[0].icon, undefined);
    assert.equal(
      sendError.value?.text,
      "The color was rejected by the server.",
    );
  });
  it("setProviderColor updates the signal and persists", () => {
    setProviderColor("zai-coding-plan", "cyan");
    assert.equal(providerColors.value["zai-coding-plan"], "cyan");
    assert.equal(
      localStorageStub.getItem("opencode-provider-colors"),
      '{"zai-coding-plan":"cyan"}',
    );
  });
});

describe("project purge", () => {
  it("deletes every session and tombstones the folder", async () => {
    sessions.value = [sessRow("pz1"), sessRow("pz2")];
    homeFilter.value = "C:/work/repo";
    onApi((call) => {
      if (call.method === "GET" && call.path.split("?")[0] === "/session")
        return [{ id: "pz1" }, { id: "pz2" }];
      return undefined;
    });
    assert.equal(await purgeProject("C:\\work\\repo"), true);
    assert.equal(tombstones.value[0], "C:/work/repo");
    assert.equal(homeFilter.value, undefined);
    assert.equal(purgeState.value, undefined);
    assert.deepEqual(sessions.value, []);
    assert.ok(
      hostPosted.some(
        (m) =>
          (m as { type?: string; path?: string }).type ===
            "project-tombstoned" &&
          (m as { path?: string }).path === "C:/work/repo",
      ),
    );
  });
  it("reports a partial purge without tombstoning", async () => {
    sessions.value = [sessRow("pz3"), sessRow("pz4")];
    onApi((call) => {
      if (call.method === "GET" && call.path.split("?")[0] === "/session")
        return [{ id: "pz3" }, { id: "pz4" }];
      if (call.method === "DELETE" && call.path.includes("pz4"))
        return API_FAIL;
      return undefined;
    });
    assert.equal(await purgeProject("C:\\work\\repo"), false);
    assert.equal(
      sendError.value?.text,
      "Deleted 1 of 2 sessions — the project was not removed.",
    );
    assert.equal(tombstones.value.includes("C:/work/repo"), false);
  });
});


// 9c1f2e7: a boot inside the server restart window — every list fetch
// failing at once — must read as stalled, not as "no sessions", and must
// keep retrying until a page lands.
describe("session-list retry across the restart window (9c1f2e7)", () => {
  it("marks the list stalled, retries on backoff, and clears once a page lands", async () => {
    const connected = async () => {
      dispatchWindowMessage({
        type: "sse-event",
        event: { id: "evt_r", type: "server.connected", data: {} },
      });
      await flushEvents();
      await settle();
    };
    let failing = true;
    onApi((call) => {
      if (call.path.startsWith("/api/session?") || call.path === "/session")
        return failing ? API_FAIL : undefined;
      return undefined;
    });
    await connected(); // the boot pull — every list fetch fails
    assert.equal(sessionsStalled.value, true);
    assert.equal(fireExact(1000), 1); // first retry still fails
    await settle();
    assert.equal(sessionsStalled.value, true);
    assert.equal(fireExact(2000), 1); // backoff grew
    await settle();
    failing = false; // the server came up
    assert.equal(fireExact(4000), 1);
    await settle();
    assert.equal(sessionsStalled.value, false); // no further retry fires
  });
});

// 9c1f2e7: a transcript pull that cannot answer leaves the map empty —
// the view would render a bare composer. The failure is surfaced and a
// backoff loop re-pulls while the session is on screen.
describe("transcript load retry (9c1f2e7)", () => {
  it("marks the failed load, retries, and clears on success", async () => {
    navigate({ view: "session", id: "rl1" });
    let failing = true;
    onApi(
      messageMock(
        "rl1",
        () => (failing ? API_FAIL : undefined),
        () => (failing ? API_FAIL : undefined),
      ),
    );
    await refreshMessages("rl1");
    assert.equal(failedMsgLoads.value.has("rl1"), true);
    assert.equal(messagesBySession.value.has("rl1"), false);

    failing = false;
    assert.equal(fireExact(1000), 1); // the retry lands
    await settle();
    assert.equal(failedMsgLoads.value.has("rl1"), false);
  });

  it("stops retrying once the session leaves the screen", async () => {
    navigate({ view: "session", id: "rl2" });
    onApi(messageMock("rl2", API_FAIL, API_FAIL));
    await refreshMessages("rl2");
    assert.equal(failedMsgLoads.value.has("rl2"), true);
    // The open tab alone keeps the retry alive — close it, not just route away.
    closeSessionTab("rl2");
    navigate({ view: "home" });
    assert.equal(fireExact(1000), 1);
    await settle();
    assert.equal(failedMsgLoads.value.has("rl2"), false);
    assert.equal(fireExact(2000), 0);
  });
});



// e4b1c93: v2 writes the prompt's user row only at first step start and
// delivers it by fetch, so the optimistic echo can outlive the POST reply.
// The refresh that finally lands the durable row must retire the echo, not
// render the prompt twice.
describe("echo retirement on the durable user row (e4b1c93)", () => {
  it("a refresh drops the echo once its durable user row arrives", async () => {
    setDialect("v2");
    try {
      sessions.value = [sessRow("er1")];
      onApi((call) => {
        const p = call.path.split("?")[0];
        if (call.method === "POST" && p === "/api/session/er1/prompt")
          return {}; // admitted, but no user row in the reply
        if (p === "/api/session/er1/message")
          return {
            data: [
              { id: "a1", type: "assistant", time: { created: Date.now() }, text: "" },
              { id: "u1", type: "user", time: { created: Date.now() }, text: "hello echo" },
            ],
            cursor: {},
          };
        return undefined;
      });
      await sendPrompt("er1", "hello echo");
      await refreshMessages("er1");
      const rows = messagesBySession.value.get("er1") ?? [];
      const users = rows.filter((m) => m.info.role === "user");
      assert.equal(users.length, 1);
      assert.equal(users[0].info.id, "u1");
      assert.equal(rows.some((m) => m.info.id.startsWith("pending:")), false);
    } finally {
      setDialect("v1");
    }
  });
});

// 1836cd3: the provider catalog and the config default both read the
// /api/config docs — one refresh must hit the route once.
describe("v2 refresh fetches /api/config once (1836cd3)", () => {
  it("shares the config docs across providers and config", async () => {
    setDialect("v2");
    try {
      dispatchWindowMessage({
        type: "sse-event",
        event: { id: "evt_c1", type: "server.connected", data: {} },
      });
      await flushEvents();
      await settle();
      assert.equal(callsFor("/api/config").length, 1);
    } finally {
      setDialect("v1");
    }
  });
});
