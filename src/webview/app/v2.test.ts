import "./setup.test";
import { strict as assert } from "node:assert";
import {
  callsFor,
  flushEvents,
  dispatchWindowMessage,
  fireExact,
  bellRang,
  onApi,
  settle,
} from "./setup.test";
import {
  attachmentsEnabled,
  compactSession,
  createSession,
  deleteSession,
  dialect,
  fetchAgents,
  fetchCommands,
  fetchConfig,
  fetchMessages,
  fetchProjectSessions,
  fetchProviders,
  fetchSession,
  fetchSessionStatus,
  fetchProjects,
  findFiles,
  interruptSession,
  promptSession,
  renameSession,
  revertSession,
  setDialect,
} from "./api";
import { translateV2Event } from "./v2events";
import { judgeDialect, detectDialect } from "../../server/dialect";
import {
  init,
  messagesBySession,
  sessionStatus,
  sessions,
} from "./store";
import type { ChatMessage } from "./store";
import type { Session } from "./api";

const T0 = 1_750_000_000_000;

function sessRow(id: string, over: Partial<Session> = {}): Session {
  return {
    id,
    title: `t-${id}`,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: T0, updated: T0 },
    location: { directory: "C:\\work\\repo" },
    ...over,
  };
}

function row(
  id: string,
  role: "user" | "assistant",
  created: number,
): ChatMessage {
  return { info: { id, role, time: { created } }, parts: [] };
}

let evSeq = 0;
function v2sse(type: string, data: Record<string, unknown>): void {
  dispatchWindowMessage({
    type: "sse-event",
    event: { id: `e${++evSeq}`, type, data },
  });
}

// The fake fetch detectDialect consumes: scripted replies per URL suffix.
function fetchScript(
  replies: Record<string, { status: number; json?: unknown; ct?: string }>,
): {
  calls: string[];
  fetch: (url: string, init?: Record<string, unknown>) => Promise<Response>;
} {
  const calls: string[] = [];
  const fetch = (url: string): Promise<Response> => {
    calls.push(url);
    const hit = Object.entries(replies).find(([suffix]) =>
      url.endsWith(suffix),
    )?.[1];
    return Promise.resolve(
      new Response(hit?.json === undefined ? "" : JSON.stringify(hit.json), {
        status: hit?.status ?? 404,
        headers: {
          "content-type":
            hit?.ct ?? (hit?.json === undefined ? "text/html" : "application/json"),
        },
      }),
    );
  };
  return { calls, fetch };
}

describe("dialect detection (probe logic)", () => {
  it("a healthy /api/health is v1 outright", () => {
    assert.equal(
      judgeDialect({ status: 200, json: { healthy: true } }, { status: 0, json: undefined }),
      "v1",
    );
  });
  it("health 404 + config as a bare array is v2", () => {
    assert.equal(
      judgeDialect({ status: 404, json: undefined }, { status: 200, json: [] }),
      "v2",
    );
  });
  it("health unreachable + config array is still v2", () => {
    assert.equal(
      judgeDialect("error", { status: 200, json: [{ type: "document" }] }),
      "v2",
    );
  });
  it("v1's merged-config object (not an array) reads v1", () => {
    assert.equal(
      judgeDialect({ status: 404, json: undefined }, { status: 200, json: { model: "a/b" } }),
      "v1",
    );
  });
  it("an auth-required config (401) is not v2 — falls back to v1", () => {
    assert.equal(
      judgeDialect({ status: 404, json: undefined }, { status: 401, json: undefined }),
      "v1",
    );
  });
  it("detectDialect probes health first, then config; caches per origin", async () => {
    const origin = `http://cache-${Math.random().toString(36).slice(2)}:1`;
    const { calls, fetch } = fetchScript({
      "/api/health": { status: 404 },
      "/api/config": { status: 200, json: [] },
    });
    assert.equal(await detectDialect(origin, {}, fetch), "v2");
    assert.deepEqual(calls, [`${origin}/api/health`, `${origin}/api/config`]);
    // Cached: the second detection makes no new calls.
    calls.length = 0;
    assert.equal(await detectDialect(origin, {}, fetch), "v2");
    assert.equal(calls.length, 0);
  });
  it("skips the config probe when health already answered v1", async () => {
    const origin = `http://v1-${Math.random().toString(36).slice(2)}:1`;
    const { calls, fetch } = fetchScript({
      "/api/health": { status: 200, json: { healthy: true } },
    });
    assert.equal(await detectDialect(origin, {}, fetch), "v1");
    assert.deepEqual(calls, [`${origin}/api/health`]);
  });
});

describe("v2 route/body/envelope translation", () => {
  beforeEach(() => setDialect("v2"));
  afterEach(() => setDialect("v1"));

  it("createSession posts /api/session with the preset and unwraps {data}", async () => {
    onApi((call) =>
      call.method === "POST" && call.path === "/api/session"
        ? { data: sessRow("ses_1") }
        : undefined,
    );
    const { session, error } = await createSession("titled", {
      agent: "plan",
      model: { providerID: "p", id: "m", variant: "low" },
    });
    assert.equal(error, undefined);
    assert.equal(session?.id, "ses_1");
    assert.equal(session?.location.directory, "C:\\work\\repo");
    const body = callsFor("/api/session")[0].body as Record<string, unknown>;
    assert.deepEqual(body, {
      title: "titled",
      agent: "plan",
      model: { providerID: "p", id: "m", variant: "low" },
    });
  });

  it("promptSession switches agent/model, then posts {text} and returns the user row", async () => {
    onApi((call) => {
      if (call.path === "/api/session/ses_1/agent")
        assert.deepEqual(call.body, { agent: "build" });
      if (call.path === "/api/session/ses_1/model")
        assert.deepEqual(call.body, {
          model: { providerID: "p", id: "m", variant: "low" },
        });
      if (call.path === "/api/session/ses_1/prompt")
        return {
          data: {
            id: "msg_1",
            sessionID: "ses_1",
            time: { created: 5 },
            type: "user",
            payload: { text: "hi" },
            delivery: "steer",
          },
        };
      return undefined;
    });
    const sent = await promptSession(
      "ses_1",
      [{ type: "text", text: "hi" }],
      "build",
      { providerID: "p", id: "m", variant: "low" },
    );
    assert.equal(sent.ok, true);
    assert.deepEqual(sent.user, { id: "msg_1", created: 5, text: "hi" });
    assert.deepEqual(callsFor("/api/session/ses_1/prompt")[0].body, {
      text: "hi",
    });
  });

  it("promptSession folds multiple text parts into one {text}", async () => {
    onApi((call) =>
      call.path === "/api/session/ses_1/prompt" ? {} : undefined,
    );
    await promptSession("ses_1", [
      { type: "text", text: "a" },
      { type: "agent", name: "x" },
      { type: "text", text: "b" },
    ]);
    assert.deepEqual(callsFor("/api/session/ses_1/prompt")[0].body, {
      text: "ab",
    });
  });

  it("fetchSessionStatus maps /api/session/active (idle empty, busy sessionID)", async () => {
    onApi((call) =>
      call.path === "/api/session/active" ? { data: {} } : undefined,
    );
    assert.deepEqual(await fetchSessionStatus(), {});
    onApi((call) =>
      call.path === "/api/session/active"
        ? { data: { sessionID: "ses_x" } }
        : undefined,
    );
    assert.deepEqual(await fetchSessionStatus(), {
      ses_x: { type: "busy" },
    });
  });

  it("fetchProviders assembles provider+model+config into the v1 shape", async () => {
    onApi((call) => {
      if (call.path === "/api/provider")
        return { data: [{ id: "opencode", name: "OpenCode" }] };
      if (call.path === "/api/model")
        return {
          data: [
            {
              id: "m1",
              providerID: "opencode",
              name: "M1",
              capabilities: { tools: true, input: ["text", "image"] },
              variants: [{ id: "low" }, { id: "high" }],
            },
            { id: "m2", providerID: "other" },
          ],
        };
      if (call.path === "/api/config")
        return [{ info: { model: { providerID: "opencode", model: "m1" } } }];
      return undefined;
    });
    const providers = await fetchProviders();
    assert.equal(providers?.all.length, 2);
    const oc = providers?.all.find((p) => p.id === "opencode");
    // Catalog providers are connected outright (v2 filters availability
    // server-side); /api/provider rows and the config default union in.
    assert.deepEqual(providers?.connected, ["opencode", "other"]);
    assert.deepEqual(oc?.models.m1.variants, { low: {}, high: {} });
    assert.deepEqual(oc?.models.m1.capabilities?.input, {
      text: true,
      image: true,
    });
    assert.equal(oc?.models.m2, undefined);
    assert.equal(providers?.all[1].models.m2?.name, "m2");
  });

  it("fetchProviders lights catalog providers when /api/provider is empty", async () => {
    onApi((call) => {
      if (call.path === "/api/provider") return { data: [] };
      if (call.path === "/api/model")
        return { data: [{ id: "m1", providerID: "zai-coding-plan" }] };
      if (call.path === "/api/config")
        return [
          { info: { model: { providerID: "zai-coding-plan", model: "glm-5.3" } } },
        ];
      return undefined;
    });
    assert.deepEqual((await fetchProviders())?.connected, [
      "zai-coding-plan",
    ]);
  });

  it("fetchConfig derives the default model from the config source docs", async () => {
    onApi((call) =>
      call.path === "/api/config"
        ? [
            { info: {} },
            { info: { model: { providerID: "p", model: "m" } } },
          ]
        : undefined,
    );
    assert.deepEqual(await fetchConfig(), { model: "p/m" });
  });

  it("fetchAgents keys rows by id; fetchCommands unwraps {data}", async () => {
    onApi((call) => {
      if (call.path === "/api/agent")
        return {
          data: [
            {
              id: "build",
              name: "Build",
              description: "The default agent.",
              mode: "primary",
              hidden: false,
            },
          ],
        };
      if (call.path === "/api/command")
        return { data: [{ name: "init", description: "guided" }] };
      return undefined;
    });
    const agents = await fetchAgents();
    assert.equal(agents?.[0].name, "build");
    assert.equal(agents?.[0].mode, "primary");
    assert.deepEqual(await fetchCommands(), [
      { name: "init", description: "guided" },
    ]);
  });

  it("findFiles queries /api/fs/find?query= and unwraps {data}", async () => {
    onApi((call) =>
      call.path.startsWith("/api/fs/find")
        ? { data: ["src\\a.ts"] }
        : undefined,
    );
    assert.deepEqual(await findFiles("md"), ["src/a.ts"]);
    assert.match(callsFor("/api/fs/find")[0].path, /^\/api\/fs\/find\?query=md/);
  });

  it("writes go to the v2 routes: interrupt, compact {}, rename, delete", async () => {
    await interruptSession("ses_1");
    assert.equal(callsFor("/api/session/ses_1/interrupt").length, 1);
    await compactSession("ses_1", "p", "m");
    const compact = callsFor("/api/session/ses_1/compact")[0];
    assert.equal(compact.method, "POST");
    assert.deepEqual(compact.body, {});
    await renameSession("ses_1", "renamed", "C:\\w");
    const rename = callsFor("/api/session/ses_1")[0];
    assert.equal(rename.method, "PATCH");
    assert.equal(rename.path, "/api/session/ses_1");
    assert.deepEqual(rename.body, { title: "renamed" });
    await deleteSession("ses_1", "C:\\w");
    assert.equal(callsFor("/api/session/ses_1")[1].method, "DELETE");
  });

  it("fetchSession unwraps {data}; fetchProjects maps canonical → worktree", async () => {
    onApi((call) => {
      if (call.path === "/api/session/ses_1")
        return {
          data: { ...sessRow("ses_1"), location: undefined, directory: "C:\\flat" },
        };
      if (call.path === "/api/project")
        return [{ id: "prj", canonical: "C:\\w\\repo", time: {} }];
      return undefined;
    });
    assert.equal((await fetchSession("ses_1"))?.location.directory, "C:\\flat");
    const projects = await fetchProjects();
    assert.equal(projects?.[0].worktree, "C:\\w\\repo");
  });

  it("revertSession posts {messageID} and answers with the refetched row", async () => {
    onApi((call) => {
      if (call.method === "POST" && call.path === "/api/session/ses_1/revert")
        return {};
      if (call.path === "/api/session/ses_1")
        return { data: sessRow("ses_1", { revert: { messageID: "m1" } }) };
      return undefined;
    });
    const row = await revertSession("ses_1", "m1");
    assert.deepEqual(callsFor("/api/session/ses_1/revert")[0].body, {
      messageID: "m1",
    });
    assert.deepEqual(row?.revert, { messageID: "m1" });
  });

  it("fetchProjectSessions walks the paged list, filtering by directory", async () => {
    onApi((call) => {
      if (call.path.startsWith("/api/session?"))
        return {
          data: [
            sessRow("ses_a"),
            sessRow("ses_b", {
              location: { directory: "c:\\other\\thing" },
            }),
          ],
          cursor: { next: null },
        };
      return undefined;
    });
    const rows = await fetchProjectSessions("C:/other/thing");
    assert.deepEqual(rows, [{ id: "ses_b" }]);
    assert.match(callsFor("/api/session")[0].path, /limit=400/);
  });

  it("attachments are gated off", () => {
    assert.equal(attachmentsEnabled(), false);
    assert.equal(dialect(), "v2");
  });
});

describe("v2 transcript normalization (fetchMessages)", () => {
  beforeEach(() => setDialect("v2"));
  afterEach(() => setDialect("v1"));

  it("maps the captured v2 rows into the app shape, dropping marker rows", async () => {
    // The recorded shape from DIALECT.md: newest first, user text in
    // payload, lifecycle/bookkeeping rows interleaved.
    onApi((call) =>
      call.path.startsWith("/api/session/ses_1/message")
        ? {
            data: [
              {
                id: "msg_idle",
                time: { created: 3 },
                type: "idle",
                outcome: "succeeded",
              },
              {
                id: "msg_a",
                time: { created: 2, streamed: 2, completed: 3 },
                type: "assistant",
                agent: "build",
                model: { id: "glm-5.3", providerID: "zai-coding-plan" },
                content: [
                  {
                    type: "reasoning",
                    text: "thinking",
                    time: { created: 2, completed: 2 },
                  },
                  { type: "text", text: "Hi!" },
                ],
                finish: "stop",
                cost: 0,
                tokens: {
                  input: 4999,
                  output: 13,
                  reasoning: 44,
                  cache: { read: 1984, write: 0 },
                },
              },
              {
                id: "msg_ms",
                time: { created: 1 },
                type: "model-switched",
                model: { id: "m", providerID: "p" },
              },
              {
                id: "msg_as",
                time: { created: 1 },
                type: "agent-switched",
                agent: "build",
              },
              {
                id: "msg_u",
                sessionID: "ses_1",
                time: { created: 1 },
                type: "user",
                payload: { text: "say hi" },
                delivery: "steer",
              },
            ],
            cursor: { next: null },
          }
        : undefined,
    );
    const page = await fetchMessages("ses_1");
    assert.equal(page?.messages.length, 2);
    const [user, assistant] = page?.messages ?? [];
    assert.equal(user.info.role, "user");
    assert.equal(user.parts[0].type, "text");
    assert.equal((user.parts[0] as { text?: string }).text, "say hi");
    assert.equal(assistant.info.role, "assistant");
    assert.equal(assistant.info.providerID, "zai-coding-plan");
    assert.equal(assistant.info.modelID, "glm-5.3");
    assert.equal(assistant.info.agent, "build");
    assert.equal(assistant.info.parentID, "msg_u");
    assert.equal(assistant.info.tokens?.input, 4999);
    const reasoning = assistant.parts.find((p) => p.type === "reasoning");
    assert.equal((reasoning as { text?: string }).text, "thinking");
    assert.deepEqual(
      (reasoning as { time?: { start?: number; end?: number } }).time,
      { start: 2, end: 2 },
    );
    const text = assistant.parts.find((p) => p.type === "text");
    assert.equal((text as { text?: string } | undefined)?.text, "Hi!");
  });
});

describe("v2 SSE → pipeline translation", () => {
  const ev = (type: string, data: Record<string, unknown>) =>
    ({ id: "evt_x", type, data } as const);

  it("maps execution lifecycle onto the v1 busy/idle/error truth", () => {
    assert.deepEqual(translateV2Event(ev("session.execution.started", { sessionID: "s" })), [
      {
        id: "evt_x",
        type: "session.status",
        data: { sessionID: "s", status: { type: "busy" } },
      },
    ]);
    assert.deepEqual(
      translateV2Event(ev("session.execution.succeeded", { sessionID: "s" })),
      [{ id: "evt_x", type: "session.idle", data: { sessionID: "s" } }],
    );
    assert.deepEqual(
      translateV2Event(ev("session.execution.interrupted", { sessionID: "s" })),
      [{ id: "evt_x", type: "session.idle", data: { sessionID: "s" } }],
    );
    assert.deepEqual(
      translateV2Event(
        ev("session.execution.failed", { sessionID: "s", error: { message: "x" } }),
      ),
      [
        {
          id: "evt_x",
          type: "session.error",
          data: { sessionID: "s", error: { message: "x" } },
        },
      ],
    );
  });

  it("addresses streamed parts as `${assistantMessageID}:${ordinal}`", () => {
    assert.deepEqual(
      translateV2Event(
        ev("session.text.delta", {
          sessionID: "s",
          assistantMessageID: "msg_a",
          ordinal: 1,
          delta: "Hi",
        }),
      ),
      [
        {
          id: "evt_x",
          type: "session.next.text.delta",
          data: {
            sessionID: "s",
            assistantMessageID: "msg_a",
            textID: "msg_a:1",
            reasoningID: "msg_a:1",
            delta: "Hi",
          },
        },
      ],
    );
    const ended = translateV2Event(
      ev("session.text.ended", {
        sessionID: "s",
        assistantMessageID: "msg_a",
        ordinal: 1,
        text: "Hi!",
      }),
    );
    assert.equal(ended[0].type, "session.next.text.ended");
    assert.equal((ended[0].data as { text?: string }).text, "Hi!");
    assert.equal((ended[0].data as { textID?: string }).textID, "msg_a:1");
  });

  it("maps tool calls by callID with content/structured results", () => {
    assert.deepEqual(
      translateV2Event(
        ev("session.tool.input.started", {
          sessionID: "s",
          assistantMessageID: "msg_a",
          id: "call_1",
          name: "bash",
        }),
      ),
      [
        {
          id: "evt_x",
          type: "session.next.tool.input.started",
          data: {
            sessionID: "s",
            assistantMessageID: "msg_a",
            callID: "call_1",
            name: "bash",
          },
        },
      ],
    );
    const success = translateV2Event(
      ev("session.tool.success", {
        sessionID: "s",
        assistantMessageID: "msg_a",
        id: "call_1",
        content: [{ type: "text", text: "ok" }],
        resultState: { files: [] },
      }),
    );
    assert.equal(success[0].type, "session.next.tool.success");
    assert.deepEqual((success[0].data as { content?: unknown }).content, [
      { type: "text", text: "ok" },
    ]);
    assert.deepEqual((success[0].data as { structured?: unknown }).structured, {
      files: [],
    });
  });

  it("maps selection events and content sync; passes unknowns through", () => {
    assert.deepEqual(
      translateV2Event(
        ev("session.model.selected", {
          sessionID: "s",
          model: { providerID: "p", id: "m" },
        }),
      ),
      [
        {
          id: "evt_x",
          type: "session.next.model.switched",
          data: { sessionID: "s", model: { providerID: "p", id: "m" } },
        },
      ],
    );
    const synced = translateV2Event(
      ev("session.message.content.updated", {
        sessionID: "s",
        messageID: "msg_a",
        content: [{ type: "text", text: "all" }],
      }),
    );
    assert.equal(synced.length, 1);
    assert.equal(synced[0].type, "message.part.updated");
    assert.equal(
      (synced[0].data as { part?: { id?: string } }).part?.id,
      "msg_a:0",
    );
    // Catalog/bookkeeping frames ride through untouched (the store
    // ignores what it does not know — e.g. session.usage.updated).
    const usage = ev("session.usage.updated", { sessionID: "s", cost: 0 });
    assert.deepEqual(translateV2Event(usage), [usage]);
  });

  it("frames without a sessionID or coordinates translate to nothing", () => {
    assert.deepEqual(translateV2Event(ev("session.step.started", {})), []);
    assert.deepEqual(translateV2Event(ev("session.text.delta", { delta: "x" })), []);
    assert.deepEqual(
      translateV2Event(ev("session.inbox.enqueued", { sessionID: "s" })),
      [ev("session.inbox.enqueued", { sessionID: "s" })],
    );
  });
});

describe("v2 turn through the store (recorded frame sequence)", () => {
  beforeEach(() => setDialect("v2"));
  afterEach(() => setDialect("v1"));

  it("projects the DIALECT.md turn: busy, rows, deltas, usage, idle, ring", async () => {
    init();
    const sid = "v2turn";
    sessions.value = [sessRow(sid)];
    messagesBySession.value = new Map([[sid, [row("u1", "user", T0)]]]);

    v2sse("session.inbox.enqueued", { sessionID: sid, inboxID: "in_1" });
    v2sse("session.execution.started", { sessionID: sid });
    await flushEvents();
    assert.equal(sessionStatus.value[sid]?.type, "busy");

    v2sse("session.renamed", { sessionID: sid, title: "Greeting request" });
    v2sse("session.step.started", {
      sessionID: sid,
      assistantMessageID: "msg_a",
      agent: "build",
      model: { providerID: "zai-coding-plan", id: "glm-5.3" },
      started: T0 + 10,
    });
    await flushEvents();
    assert.equal(sessions.value[0].title, "Greeting request");

    v2sse("session.reasoning.delta", {
      sessionID: sid,
      assistantMessageID: "msg_a",
      ordinal: 0,
      delta: "think ",
    });
    v2sse("session.reasoning.delta", {
      sessionID: sid,
      assistantMessageID: "msg_a",
      ordinal: 0,
      delta: "hard",
    });
    v2sse("session.text.delta", {
      sessionID: sid,
      assistantMessageID: "msg_a",
      ordinal: 1,
      delta: "Hi!",
    });
    await flushEvents();
    assert.equal(sessionStatus.value[sid]?.type, "busy");

    v2sse("session.step.ended", {
      sessionID: sid,
      assistantMessageID: "msg_a",
      finish: "stop",
      cost: 0.001,
      tokens: {
        input: 4999,
        output: 13,
        reasoning: 44,
        cache: { read: 1984, write: 0 },
      },
    });
    v2sse("session.execution.succeeded", { sessionID: sid });
    await flushEvents();
    assert.equal(sessionStatus.value[sid]?.type, "idle");
    // The ready bell: busy → idle through a real turn. The chime's
    // buffer decode resolves on a microtask — settle before reading.
    fireExact(1500);
    await settle(1);
    assert.equal(bellRang(), true);

    const list = messagesBySession.value.get(sid) ?? [];
    const assistant = list.find((m) => m.info.id === "msg_a");
    assert.equal(assistant?.info.role, "assistant");
    assert.equal(assistant?.info.agent, "build");
    assert.equal(assistant?.info.providerID, "zai-coding-plan");
    assert.equal(assistant?.info.modelID, "glm-5.3");
    assert.equal(assistant?.info.tokens?.input, 4999);
    const reasoning = assistant?.parts.find((p) => p.id === "msg_a:0");
    assert.equal(reasoning?.type, "reasoning");
    assert.equal((reasoning as { text?: string }).text, "think hard");
    const text = assistant?.parts.find((p) => p.id === "msg_a:1");
    assert.equal(text?.type, "text");
    assert.equal((text as { text?: string }).text, "Hi!");
    // The step's usage also landed on the session row (running sum).
    assert.equal(sessions.value[0].tokens.input, 4999);
  });
});
