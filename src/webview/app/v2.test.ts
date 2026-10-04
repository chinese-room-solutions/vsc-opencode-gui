import "./setup.test";
import { strict as assert } from "node:assert";
import {
  apiFailWith,
  API_FAIL,
  callsFor,
  flushEvents,
  dispatchWindowMessage,
  fireExact,
  bellRang,
  onApi,
  sessRow,
  setNow,
  settle,
  T0,
} from "./setup.test";
import {
  compactSession,
  createSession,
  deleteSession,
  fetchAgents,
  fetchCommands,
  fetchConfig,
  fetchMessages,
  fetchProjectSessions,
  fetchProviders,
  fetchSession,
  fetchSessionStatus,
  fetchSessionQuestions,
  fetchPendingPermissions,
  fetchProjects,
  fetchSessions,
  findFiles,
  interruptSession,
  isBashTool,
  isTool,
  isTaskTool,
  promptSession,
  replyPermission,
  replyQuestion,
  renameSession,
  revertSession,
  runCommand,
  setDialect,
} from "./api";
import type { FilePart, Session } from "./api";
import { translateV2Event } from "./v2events";
import { judgeDialect, detectDialect, awaitDialect } from "../../server/dialect";
import {
  commands,
  draftModel,
  init,
  messagesBySession,
  providers,
  refreshProvidersIfStale,
  resyncFromServer,
  resetBaseRetryForTest,
  sendPrompt,
  serverDefaultModel,
  sessionStatus,
  sessions,
} from "./store";
import type { ChatMessage } from "./store";

function row(
  id: string,
  role: "user" | "assistant",
  created: number,
): ChatMessage {
  return { info: { id, role, time: { created } }, parts: [] };
}

// v2 form row: one option field; the field title is the capitalized key.
function formRow(
  id: string,
  title: string,
  key: string,
  options: [value: string, label: string][],
  sessionID?: string,
): Record<string, unknown> {
  return {
    id,
    ...(sessionID !== undefined ? { sessionID } : {}),
    title,
    fields: [
      {
        key,
        type: "string",
        title: key[0].toUpperCase() + key.slice(1),
        options: options.map(([value, label]) => ({ value, label })),
      },
    ],
  };
}

let evSeq = 0;
function v2sse(type: string, data: Record<string, unknown>, created?: number): void {
  dispatchWindowMessage({
    type: "sse-event",
    event: { id: `e${++evSeq}`, ...(created !== undefined ? { created } : {}), type, data },
  });
}

// The fake fetch detectDialect consumes: scripted replies per URL suffix.
// A reply of {err: true} rejects (an unreachable server); mutating the
// script between awaits changes what the next probe round sees.
function fetchScript(
  replies: Record<string, { status?: number; json?: unknown; ct?: string; err?: boolean }>,
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
    if (hit?.err) return Promise.reject(new Error("unreachable"));
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
  it("both probes unreachable is unknown, not a guess", () => {
    assert.equal(judgeDialect("error", "error"), "unknown");
  });
  it("health answering SPA HTML (200, no JSON) is not a v1 signal", () => {
    assert.equal(
      judgeDialect({ status: 200, json: undefined }, { status: 200, json: [] }),
      "v2",
    );
  });
  it("config 200 with a non-JSON body (SPA fallback) is unknown", () => {
    assert.equal(
      judgeDialect({ status: 404, json: undefined }, { status: 200, json: undefined }),
      "unknown",
    );
    assert.equal(
      judgeDialect(
        { status: 200, json: undefined },
        { status: 200, json: undefined },
      ),
      "unknown",
    );
  });
  it("an unknown verdict falls back to v1 but is not cached", async () => {
    const origin = `http://unk-${Math.random().toString(36).slice(2)}:1`;
    const replies: Record<string, { status: number; json?: unknown }> = {
      "/api/health": { status: 404 },
      "/api/config": { status: 404 },
    };
    const { calls, fetch } = fetchScript(replies);
    assert.equal(await detectDialect(origin, {}, fetch), "v1");
    // The routes come up between the calls: a re-detection must re-probe
    // (an "unknown" was never written to the cache) and see v2.
    replies["/api/config"] = { status: 200, json: [] };
    assert.equal(await detectDialect(origin, {}, fetch), "v2");
    assert.ok(calls.length >= 4, "the second detection probed again");
  });
  it("awaitDialect polls until a probe round is conclusive", async () => {
    const origin = `http://wait-${Math.random().toString(36).slice(2)}:1`;
    const replies: Record<string, { status?: number; json?: unknown; err?: boolean }> = {
      "/api/health": { status: 404 },
      "/api/config": { err: true },
    };
    const { calls, fetch } = fetchScript(replies);
    const sleeps: number[] = [];
    const verdict = await awaitDialect(origin, {}, fetch, {
      deadlineMs: 5000,
      sleep: async (ms) => {
        sleeps.push(ms);
        // The server finishes initializing during the first wait.
        replies["/api/config"] = { status: 200, json: [] };
      },
    });
    assert.equal(verdict, "v2");
    assert.equal(sleeps.length, 1, "one wait between the two rounds");
    assert.ok(calls.length >= 3, "at least two probe rounds ran");
  });
  it("awaitDialect gives up with the v1 fallback past the deadline", async () => {
    const origin = `http://dl-${Math.random().toString(36).slice(2)}:1`;
    const { fetch } = fetchScript({
      "/api/health": { status: 404 },
      "/api/config": { err: true },
    });
    const verdict = await awaitDialect(origin, {}, fetch, {
      deadlineMs: 0,
      sleep: async () => {},
    });
    assert.equal(verdict, "v1");
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

  it("promptSession folds multiple text parts into one {text} plus agents", async () => {
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
      agents: [{ name: "x" }],
    });
  });

  it("promptSession maps attachments and mentions into files", async () => {
    onApi((call) =>
      call.path === "/api/session/ses_1/prompt" ? {} : undefined,
    );
    await promptSession("ses_1", [
      { type: "text", text: "look" },
      // Pasted image: data-URI attachment with a filename.
      {
        type: "file",
        mime: "image/png",
        url: "data:image/png;base64,AAA",
        filename: "shot.png",
      },
      // Snapshotted text attachment: file:// URL, still a plain attachment.
      {
        type: "file",
        mime: "text/plain",
        url: "file:///w/repo/.opencode/attach/notes.txt",
        filename: "notes.txt",
      },
      // @-mention: file:// URL plus the source range of the "@path" text.
      {
        type: "file",
        mime: "text/plain",
        url: "file:///w/repo/src/store.ts?start=12&end=14",
        source: {
          type: "file",
          path: "/w/repo/src/store.ts",
          text: { value: "@src/store.ts#12-14", start: 5, end: 23 },
        },
      },
    ]);
    assert.deepEqual(callsFor("/api/session/ses_1/prompt")[0].body, {
      text: "look",
      files: [
        { uri: "data:image/png;base64,AAA", name: "shot.png" },
        { uri: "file:///w/repo/.opencode/attach/notes.txt", name: "notes.txt" },
        {
          uri: "file:///w/repo/src/store.ts?start=12&end=14",
          mention: { start: 5, end: 23, text: "@src/store.ts#12-14" },
        },
      ],
    });
  });

  it("fetchSessionStatus maps /api/session/active (idle empty, busy sessionID)", async () => {
    onApi((call) =>
      call.path === "/api/session/active" ? { data: {} } : undefined,
    );
    assert.deepEqual(await fetchSessionStatus(), {});
    onApi((call) =>
      call.path === "/api/session/active"
        ? { data: { ses_x: { id: "ses_x", title: "running" } } }
        : undefined,
    );
    assert.deepEqual(await fetchSessionStatus(), {
      ses_x: { type: "busy" },
    });
  });

  it("fetchProviders scopes the v2 model catalog by the workspace directory", async () => {
    onApi((call) => {
      if (call.path.startsWith("/api/model?location%5Bdirectory%5D="))
        return {
          data: [{ id: "glm-5.3-flash", providerID: "zai", name: "Flash" }],
        };
      if (call.path === "/api/model") return { data: [] };
      if (call.path === "/api/provider") return { data: [] };
      if (call.path === "/api/config") return [];
      return undefined;
    });
    const list = await fetchProviders("C:\\w\\repo");
    assert.deepEqual(Object.keys(list?.all[0]?.models ?? {}), ["glm-5.3-flash"]);
    assert.ok(
      callsFor("/api/model").some((c) =>
        c.path.includes("location%5Bdirectory%5D=C%3A%5Cw%5Crepo"),
      ),
    );
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

  it("fetchCommands merges /api/skill rows as runnable skill entries", async () => {
    onApi((call) => {
      if (call.path === "/api/command")
        return {
          data: [
            { name: "init", description: "guided" },
            { name: "start", description: "project command" },
          ],
        };
      if (call.path === "/api/skill")
        return {
          data: [
            // Rows carry id/name/description (+path/content we ignore).
            {
              id: "probe-skill",
              name: "Probe Skill",
              description: "Probe project skill",
              path: "C:\\ws\\.opencode\\skill\\probe-skill\\SKILL.md",
              content: "body",
            },
            // A command owning the same name wins it — skills dedupe out.
            { id: "start", name: "Start", description: "clashing skill" },
            { name: "no-id-skill" },
          ],
        };
      return undefined;
    });
    assert.deepEqual(await fetchCommands(), [
      { name: "init", description: "guided" },
      { name: "start", description: "project command" },
      {
        name: "probe-skill",
        description: "Probe project skill",
        skill: true,
      },
    ]);
  });

  it("fetchCommands keeps command rows when /api/skill fails", async () => {
    onApi((call) => {
      if (call.path === "/api/command")
        return { data: [{ name: "init", description: "guided" }] };
      if (call.path === "/api/skill") return apiFailWith("HTTP 404");
      return undefined;
    });
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

  it("fetchSessions coerces ISO times, string model refs, and missing titles", async () => {
    onApi((call) =>
      call.path.startsWith("/api/session?")
        ? {
            data: [
              {
                id: "s1",
                time: {
                  created: "2026-09-27T10:00:00.000Z",
                  updated: "2026-09-27T10:01:00.000Z",
                },
                model: "p/m#fast",
                location: { directory: "C:/w" },
              },
            ],
          }
        : undefined,
    );
    const page = await fetchSessions();
    const s = page?.sessions[0];
    assert.equal(s?.time.created, Date.parse("2026-09-27T10:00:00.000Z"));
    assert.equal(s?.time.updated, Date.parse("2026-09-27T10:01:00.000Z"));
    assert.equal(s?.title, "");
    assert.deepEqual(s?.model, { id: "m", providerID: "p", variant: "fast" });
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
    const row = await fetchSession("ses_1");
    assert.notEqual(row, "missing");
    assert.equal((row as Session)?.location.directory, "C:\\flat");
    const projects = await fetchProjects();
    assert.equal(projects?.[0].worktree, "C:\\w\\repo");
  });

  it("fetchSession tells a definitive 404 from an unanswerable fetch (9c1f2e7)", async () => {
    onApi((call) => {
      if (call.path === "/api/session/gone") return apiFailWith("HTTP 404: not found");
      if (call.path === "/api/session/slow") return apiFailWith("HTTP 500: boom");
      if (call.path === "/api/session/dead") return API_FAIL;
      return undefined;
    });
    assert.equal(await fetchSession("gone"), "missing");
    assert.equal(await fetchSession("slow"), undefined);
    assert.equal(await fetchSession("dead"), undefined);
  });

  it("revertSession stages and commits, answering with the refetched row", async () => {
    onApi((call) => {
      if (call.method === "POST" && call.path === "/api/session/ses_1/revert/stage")
        return {};
      if (call.method === "POST" && call.path === "/api/session/ses_1/revert/commit")
        return {};
      if (call.path === "/api/session/ses_1")
        return { data: sessRow("ses_1", { revert: { messageID: "m1" } }) };
      return undefined;
    });
    const row = await revertSession("ses_1", "m1");
    assert.deepEqual(callsFor("/api/session/ses_1/revert/stage")[0].body, {
      messageID: "m1",
    });
    assert.equal(callsFor("/api/session/ses_1/revert/commit").length, 1);
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

  it("runCommand posts {name, text} on v2", async () => {
    onApi((call) =>
      call.method === "POST" && call.path === "/api/session/ses_1/command"
        ? {}
        : undefined,
    );
    assert.equal(
      await runCommand("ses_1", "start", "fix the bug", {
        agent: "build",
        model: { providerID: "p", id: "m" },
      }),
      true,
    );
    assert.deepEqual(callsFor("/api/session/ses_1/command")[0].body, {
      name: "start",
      text: "fix the bug",
    });
  });

  it("runCommand sends skills to the experimental session skill route", async () => {
    onApi((call) =>
      call.method === "POST" &&
      call.path === "/api/experimental/session/ses_1/skill"
        ? {}
        : undefined,
    );
    assert.equal(await runCommand("ses_1", "probe-skill", "", undefined, true), true);
    assert.equal(callsFor("/api/session/ses_1/command").length, 0);
    assert.deepEqual(
      callsFor("/api/experimental/session/ses_1/skill")[0].body,
      { id: "probe-skill" },
    );
  });
});

describe("v2 transcript normalization (fetchMessages)", () => {
  beforeEach(() => setDialect("v2"));
  afterEach(() => setDialect("v1"));

  it("coerces ISO times and string model refs; the first generated part carries the streamed stamp", async () => {
    onApi((call) =>
      call.path.startsWith("/api/session/ses_iso/message")
        ? {
            data: [
              {
                id: "u1",
                type: "user",
                time: { created: "2026-09-27T10:00:00.000Z" },
                payload: { text: "hi" },
              },
              {
                id: "a1",
                type: "assistant",
                time: {
                  created: "2026-09-27T10:00:01.000Z",
                  streamed: "2026-09-27T10:00:04.000Z",
                  completed: "2026-09-27T10:00:06.000Z",
                },
                model: "p1/m1",
                content: [
                  { type: "tool", id: "t0", name: "bash" },
                  { type: "text", id: "x1", text: "answer" },
                ],
              },
            ],
          }
        : undefined,
    );
    const page = await fetchMessages("ses_iso");
    const list = page?.messages ?? [];
    const u = list.find((m) => m.info.id === "u1");
    const a = list.find((m) => m.info.id === "a1");
    assert.equal(u?.info.time.created, Date.parse("2026-09-27T10:00:00.000Z"));
    assert.equal(a?.info.providerID, "p1");
    assert.equal(a?.info.modelID, "m1");
    assert.equal(
      a?.info.time.completed,
      Date.parse("2026-09-27T10:00:06.000Z"),
    );
    const text = a?.parts.find((p) => p.type === "text") as
      | { time?: { start?: number } }
      | undefined;
    // The settled tok/s divides from this first-token stamp (v1 parts
    // carry it natively; v2 only stamps the row).
    assert.equal(text?.time?.start, Date.parse("2026-09-27T10:00:04.000Z"));
  });

  it("anchors a text after thinking at the thinking window's end", async () => {
    // The wire numbers ordinals per kind and content items carry no time
    // but reasoning's — the closest durable anchor for a following text is
    // the reasoning window's completion, not the row's creation.
    onApi((call) =>
      call.path.startsWith("/api/session/ses_anchor/message")
        ? {
            data: [
              {
                id: "msg_an",
                type: "assistant",
                time: { created: 1000, streamed: 9000, completed: 16000 },
                content: [
                  {
                    type: "reasoning",
                    text: "ponder",
                    time: { created: 9500, completed: 14000 },
                  },
                  { type: "text", text: "answer" },
                ],
              },
            ],
          }
        : undefined,
    );
    const page = await fetchMessages("ses_anchor");
    const a = (page?.messages ?? []).find((m) => m.info.id === "msg_an");
    const think = a?.parts.find((p) => p.type === "reasoning") as
      | { time?: { start?: number; end?: number } }
      | undefined;
    const text = a?.parts.find(
      (p) => p.type === "text" && (p as { id?: string }).id === "msg_an:1",
    ) as { time?: { start?: number } } | undefined;
    assert.equal(think?.time?.start, 9500);
    assert.equal(think?.time?.end, 14000);
    assert.equal(text?.time?.start, 14000);
  });

  it("maps shell and synthetic rows; a failed compaction vanishes", async () => {
    onApi((call) =>
      call.path.startsWith("/api/session/ses_mix/message")
        ? {
            data: [
              {
                id: "msg_cf",
                time: { created: 4 },
                type: "compaction",
                status: "failed",
                summary: "",
              },
              {
                id: "msg_sh",
                time: { created: 1, completed: 2 },
                type: "shell",
                shellID: "sh_1",
                command: "npm t",
                output: "ok",
                status: "completed",
              },
              {
                id: "msg_syn",
                time: { created: 3 },
                type: "synthetic",
                text: "Context trimmed",
              },
              {
                id: "msg_peer",
                time: { created: 6 },
                type: "synthetic",
                text: "Ping from a peer",
                metadata: {
                  peerMessage: {
                    version: 2,
                    messageId: "m1",
                    fromEndpointId: "ses_a",
                    toSessionId: "ses_mix",
                  },
                },
              },
              {
                id: "msg_u",
                time: { created: 5 },
                type: "user",
                payload: { text: "hi" },
              },
            ],
          }
        : undefined,
    );
    const page = await fetchMessages("ses_mix");
    const list = page?.messages ?? [];
    assert.ok(!list.some((m) => m.info.id === "msg_cf"));
    const shell = list.find((m) => m.info.id === "msg_sh");
    assert.equal(shell?.info.role, "assistant");
    const tool = shell?.parts[0] as
      | {
          type?: string;
          tool?: string;
          state?: { status?: string; input?: unknown; output?: string };
        }
      | undefined;
    assert.equal(tool?.type, "tool");
    assert.equal(tool?.tool, "bash");
    assert.equal(tool?.state?.status, "completed");
    assert.deepEqual(tool?.state?.input, { command: "npm t" });
    assert.equal(tool?.state?.output, "ok");
    const syn = list.find((m) => m.info.id === "msg_syn");
    assert.equal(syn?.info.role, "assistant");
    const synText = syn?.parts[0] as { type?: string; text?: string } | undefined;
    assert.equal(synText?.type, "text");
    assert.equal(synText?.text, "Context trimmed");
    // A peer-tagged synthetic row keeps v1's shape: user row + synthetic
    // part carrying metadata.peerMessage (the peer card's provenance).
    const peer = list.find((m) => m.info.id === "msg_peer");
    assert.equal(peer?.info.role, "user");
    const peerText = peer?.parts[0] as
      | {
          type?: string;
          text?: string;
          synthetic?: boolean;
          metadata?: { peerMessage?: { fromEndpointId?: string } };
        }
      | undefined;
    assert.equal(peerText?.type, "text");
    assert.equal(peerText?.text, "Ping from a peer");
    assert.equal(peerText?.synthetic, true);
    assert.equal(peerText?.metadata?.peerMessage?.fromEndpointId, "ses_a");
  });
  it("maps a completed compaction row as the foldable v1 pair", async () => {
    onApi((call) =>
      call.path.startsWith("/api/session/ses_c/message")
        ? {
            data: [
              {
                id: "msg_sum",
                time: { created: 5, completed: 6 },
                type: "compaction",
                status: "completed",
                reason: "manual",
                summary: "The user greeted.",
                recent: "user: hi",
              },
              {
                id: "msg_auto",
                time: { created: 7, completed: 8 },
                type: "compaction",
                status: "completed",
                reason: "auto",
                summary: "Later events.",
              },
            ],
          }
        : undefined,
    );
    const page = await fetchMessages("ses_c");
    const list = page?.messages ?? [];
    assert.equal(list.length, 4);
    // manual: trigger row + summary row, v1's fold pair
    assert.equal(list[0].info.role, "user");
    assert.equal(list[0].info.id, "msg_sum:c");
    assert.deepEqual(list[0].parts[0], {
      id: "msg_sum:c:0",
      messageID: "msg_sum:c",
      sessionID: "ses_c",
      type: "compaction",
    });
    assert.equal(list[1].info.role, "assistant");
    assert.equal(list[1].info.agent, "compaction");
    assert.equal(list[1].info.id, "msg_sum");
    assert.equal(
      (list[1].parts[0] as { text?: string }).text,
      "The user greeted.",
    );
    // auto: the trigger part carries the auto flag
    assert.equal(
      (list[2].parts[0] as { auto?: boolean }).auto,
      true,
    );
  });

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

  it("maps a v2 user row's files[] into chips and mention pills", async () => {
    // Session.Message.User.files (Prompt.FileAttachment): inline payloads
    // carry {data, mime}, on-disk files source {type:"uri", uri}, a
    // mention adds its range.
    onApi((call) =>
      call.path.startsWith("/api/session/ses_1/message")
        ? {
            data: [
              {
                id: "msg_u",
                time: { created: 1 },
                type: "user",
                payload: { text: "see @src/store.ts#12-14" },
                files: [
                  { data: "AAA", mime: "image/png", name: "shot.png" },
                  {
                    mime: "text/plain",
                    source: {
                      type: "uri",
                      uri: "file:///C:/w/repo/attach/notes.txt",
                    },
                    name: "notes.txt",
                  },
                  {
                    mime: "text/plain",
                    source: {
                      type: "uri",
                      uri: "file:///C:/w/repo/src/store.ts?start=12&end=14",
                    },
                    mention: { start: 4, end: 23, text: "@src/store.ts#12-14" },
                  },
                ],
              },
            ],
            cursor: { next: null },
          }
        : undefined,
    );
    const page = await fetchMessages("ses_1");
    const user = page?.messages[0];
    assert.equal(user?.info.role, "user");
    assert.equal(user?.parts.length, 4);
    const [img, notes, mention] = (user?.parts.slice(1) ?? []) as FilePart[];
    // inline image → rebuilt data: URI (thumbnail chip + lightbox)
    assert.equal(img.url, "data:image/png;base64,AAA");
    assert.equal(img.filename, "shot.png");
    assert.equal(img.source, undefined);
    assert.equal(img.mime, "image/png");
    // on-disk attachment → file:// chip that opens the file
    assert.equal(notes.url, "file:///C:/w/repo/attach/notes.txt");
    assert.equal(notes.filename, "notes.txt");
    assert.equal(notes.source, undefined);
    // mention → the v1-shaped source pillifyOwnText pills inline
    assert.equal(mention.url, "file:///C:/w/repo/src/store.ts?start=12&end=14");
    assert.deepEqual(mention.source, {
      type: "file",
      path: "C:/w/repo/src/store.ts",
      text: { value: "@src/store.ts#12-14", start: 4, end: 23 },
    });
  });

  it("reads a user row's files nested under payload (the API's wrapper)", async () => {
    onApi((call) =>
      call.path.startsWith("/api/session/ses_1/message")
        ? {
            data: [
              {
                id: "msg_u",
                time: { created: 1 },
                type: "user",
                payload: {
                  text: "hi",
                  files: [{ data: "AA==", mime: "application/pdf" }],
                },
              },
            ],
            cursor: { next: null },
          }
        : undefined,
    );
    const page = await fetchMessages("ses_1");
    const user = page?.messages[0];
    const [file] = (user?.parts.slice(1) ?? []) as FilePart[];
    assert.equal(file.url, "data:application/pdf;base64,AA==");
    assert.equal(file.filename, undefined);
  });

  it("normalizes v2 tool stamps: {created,ran,completed} time, streaming status", async () => {
    onApi((call) =>
      call.path.startsWith("/api/session/ses_1/message")
        ? {
            data: [
              {
                id: "msg_a",
                time: { created: 1, completed: 5 },
                type: "assistant",
                content: [
                  {
                    type: "tool",
                    id: "cal_1",
                    name: "shell",
                    state: {
                      status: "streaming",
                      input: JSON.stringify({ command: "ls" }),
                      time: { created: 2, ran: 3, completed: 4 },
                    },
                  },
                ],
              },
              {
                id: "msg_u",
                time: { created: 0 },
                type: "user",
                payload: { text: "go" },
              },
            ],
            cursor: { next: null },
          }
        : undefined,
    );
    const page = await fetchMessages("ses_1");
    const assistantRow = page?.messages.find((m) => m.info.role === "assistant");
    const tool = assistantRow?.parts[0]!;
    assert.ok(isTool(tool));
    assert.equal(tool.tool, "shell");
    assert.equal(tool.state?.status, "running");
    assert.deepEqual(tool.state?.input, { command: "ls" });
    assert.deepEqual(tool.state?.time, { start: 3, end: 4 });
    assert.ok(isBashTool(tool.tool));
  });

  it("lifts part-level {created,completed} into state.time when the row has none", async () => {
    // v2.0.18 durable rows: the span lives PART-level, state carries no
    // time — without the lift every fetched tool loses its elapsed tip.
    onApi((call) =>
      call.path.startsWith("/api/session/ses_1/message")
        ? {
            data: [
              {
                id: "msg_a",
                time: { created: 1, completed: 9 },
                type: "assistant",
                content: [
                  {
                    type: "tool",
                    id: "cal_2",
                    name: "bash",
                    state: { status: "completed", input: "{}" },
                    time: { created: 2, completed: 7 },
                  },
                ],
              },
            ],
            cursor: { next: null },
          }
        : undefined,
    );
    const page = await fetchMessages("ses_1");
    const tool = page?.messages[0]?.parts[0]!;
    assert.ok(isTool(tool));
    assert.deepEqual(tool.state?.time, { start: 2, end: 7 });
  });

  it("asks: v2 permission replies send {decision}; asks list via /api/permission/request; questions are forms", async () => {
    onApi((call) => {
      if (call.method === "POST" && call.path === "/api/session/ses_1/permission/per_1/reply")
        return {};
      if (call.path === "/api/permission/request")
        return {
          data: [
            { id: "per_1", sessionID: "ses_1", action: "bash", resources: ["ls"], save: [] },
          ],
        };
      if (call.path === "/api/session/ses_1/form")
        return {
          data: [formRow("frm_1", "Proceed?", "go", [["yes", "Yes"]])],
        };
      if (call.method === "POST" && call.path === "/api/session/ses_1/form/frm_1/reply")
        return {};
      return undefined;
    });
    assert.equal(
      await replyPermission("ses_1", "per_1", "once"),
      true,
    );
    assert.deepEqual(callsFor("/api/session/ses_1/permission/per_1/reply")[0].body, {
      decision: "once",
    });
    const pending = await fetchPendingPermissions();
    assert.equal(pending?.[0].id, "per_1");
    assert.equal(pending?.[0].action, "bash");
    const questions = await fetchSessionQuestions("ses_1");
    const row = questions?.rows[0];
    assert.equal(row?.id, "frm_1");
    assert.equal(row?.v1, false);
    assert.deepEqual(row?.formFields, [
      { key: "go", multiple: false, optionValues: { Yes: "yes" } },
    ]);
    assert.equal(row?.questions[0].question, "Proceed?");
    assert.equal(row?.questions[0].options?.[0].label, "Yes");
    // The reply is always keyed by the field key, values not labels.
    assert.equal(
      await replyQuestion("ses_1", "frm_1", [["Yes"]], false, row),
      true,
    );
    assert.deepEqual(
      callsFor("/api/session/ses_1/form/frm_1/reply")[0].body,
      { answer: { go: "yes" } },
    );
    // Multiselect: chosen labels map to values and go as a string[].
    assert.equal(
      await replyQuestion("ses_1", "frm_1", [["Yes", "No"]], false, {
        id: "frm_1",
        sessionID: "ses_1",
        v1: false,
        questions: [],
        formFields: [
          { key: "go", multiple: true, optionValues: { Yes: "yes", No: "no" } },
        ],
      }),
      true,
    );
    assert.deepEqual(
      callsFor("/api/session/ses_1/form/frm_1/reply")[1].body,
      { answer: { go: ["yes", "no"] } },
    );
    assert.equal(isTaskTool("subagent"), true);
    assert.equal(isTaskTool("task"), true);
    assert.equal(isTaskTool("bash"), false);
  });

  it("fetchSessionStatus reads the active record's keys; fetchAgents keeps display labels", async () => {
    onApi((call) => {
      if (call.path === "/api/session/active")
        return { data: { ses_busy: { id: "ses_busy", title: "running" } } };
      if (call.path === "/api/agent")
        return {
          data: [{ id: "build", name: "Build", mode: "primary", hidden: false }],
        };
      return undefined;
    });
    const status = await fetchSessionStatus();
    assert.deepEqual(status, { ses_busy: { type: "busy" } });
    const agents = await fetchAgents();
    assert.equal(agents?.[0].name, "build");
    assert.equal(agents?.[0].label, "Build");
  });
});

describe("v2 lazy command registry re-pull", () => {
  beforeEach(() => setDialect("v2"));
  afterEach(() => setDialect("v1"));

  it("refreshBase re-pulls commands once after the boot sync settles", async () => {
    // The v2 server registers location-scoped commands lazily: the first
    // pull can predate the sync (builtins only), so refreshBase schedules
    // one delayed re-pull per webview load.
    let pulls = 0;
    onApi((call) => {
      if (call.path === "/api/command") {
        pulls++;
        return {
          data:
            pulls === 1
              ? [{ name: "init", description: "guided" }]
              : [
                  { name: "init", description: "guided" },
                  { name: "start", description: "project command" },
                ],
        };
      }
      if (call.path === "/api/skill") return { data: [] };
      // v2 mappers throw on the stub's {} fallback for these two.
      if (call.path === "/api/project") return [];
      if (call.path === "/api/config") return [];
      return undefined;
    });
    // Earlier suites' resyncs can sit inside the 5s rate-limit window —
    // move the clock past it so this resync pulls immediately.
    setNow(Date.now() + 6_000);
    resyncFromServer();
    await settle();
    assert.deepEqual(commands.value, [
      { name: "init", description: "guided" },
    ]);
    assert.equal(fireExact(2500), 1);
    await settle();
    assert.deepEqual(commands.value, [
      { name: "init", description: "guided" },
      { name: "start", description: "project command" },
    ]);
    // One re-pull per load: a later refresh (past the resync rate limit)
    // does not schedule another — commands stay at the pre-sync answer.
    setNow(Date.now() + 6_000);
    pulls = 0; // the next refresh answers the pre-sync shape again
    resyncFromServer();
    await settle();
    assert.deepEqual(commands.value, [
      { name: "init", description: "guided" },
    ]);
    fireExact(2500);
    await settle();
    assert.deepEqual(commands.value, [
      { name: "init", description: "guided" },
    ]);
  });

  // The v2 cold window: /api/model answers 200 with [] for ~1s after
  // spawn. An empty catalog is not "no models" — the retry loop keeps
  // pulling until it lands non-empty, and a session-list success must not
  // cancel it. Lives AFTER the commands test: a full v2 refreshBase
  // consumes the once-per-load re-pull flag it checks (its own runs leave
  // a retry armed — the asserts below fire it).
  it("arms the retry on an empty catalog and clears when it fills", async () => {
    let empty = true;
    onApi((call) => {
      if (call.path.startsWith("/api/model"))
        return {
          data: empty
            ? []
            : [{ id: "glm-5.3", providerID: "zai-coding-plan" }],
        };
      if (call.path === "/api/config") return [];
      if (call.path === "/api/provider") return { data: [] };
      if (call.path === "/api/project") return [];
      if (call.path === "/api/agent") return [];
      if (call.path === "/api/command") return [];
      if (call.path === "/api/skill") return [];
      if (call.path === "/api/session/active") return {};
      return undefined;
    });
    // Neutralize the ladder/throttle state earlier suites left behind —
    // this test asserts exact retry delays.
    resetBaseRetryForTest();
    dispatchWindowMessage({
      type: "sse-event",
      event: { id: "evt_ce", type: "server.connected", data: {} },
    });
    // v2's provider pull chains three fetches — deeper settle than the
    // default three turns, or the asserts read a stale refresh.
    await flushEvents();
    await settle(8);
    // The empty catalog was accepted into the signal, but the retry
    // armed anyway (sessions landed — the default responder serves them).
    assert.equal(providers.value?.all.length ?? 0, 0);
    assert.equal(fireExact(1000), 1);
    await settle(8);
    empty = false;
    assert.equal(fireExact(2000), 1);
    await settle(8);
    assert.equal(providers.value?.all.length ?? 0, 1);
    assert.equal(fireExact(4000), 0); // complete boot cleared the loop
  });

  // The staged fill: built-in models answer at once, configured providers
  // only after discovery completes (network-bound, tens of seconds cold).
  // A PARTIAL catalog missing the wanted provider (the config default
  // here) is as much a non-answer as the empty one — the retry stays
  // armed until that provider's rows land. A wanted provider the server
  // doesn't even list (config drift) must not spin the loop forever.
  it("retries while the wanted provider's rows are missing", async () => {
    let partial = true;
    onApi((call) => {
      if (call.path.startsWith("/api/model"))
        return {
          data: [
            { id: "code-supply", providerID: "opencode" },
            ...(partial
              ? []
              : [{ id: "glm-5.3", providerID: "zai-coding-plan" }]),
          ],
        };
      if (call.path === "/api/config")
        return [
          {
            info: { model: { providerID: "zai-coding-plan", model: "glm-5.3" } },
          },
        ];
      if (call.path === "/api/provider")
        return { data: [{ id: "zai-coding-plan" }] };
      if (call.path === "/api/project") return [];
      if (call.path === "/api/agent") return [];
      if (call.path === "/api/command") return [];
      if (call.path === "/api/skill") return [];
      if (call.path === "/api/session/active") return {};
      return undefined;
    });
    draftModel.value = undefined;
    resetBaseRetryForTest();
    dispatchWindowMessage({
      type: "sse-event",
      event: { id: "evt_cf", type: "server.connected", data: {} },
    });
    await flushEvents();
    await settle(8);
    // The partial catalog was accepted (1 provider) and the config
    // default parsed — but a listed provider has no rows yet, so the
    // ladder stayed armed.
    assert.equal(providers.value?.all.length ?? 0, 1);
    assert.equal(serverDefaultModel.value?.providerID, "zai-coding-plan");
    assert.equal(fireExact(1000), 1);
    await settle(8);
    partial = false;
    assert.equal(fireExact(2000), 1);
    await settle(8);
    assert.equal(providers.value?.all.length ?? 0, 2);
    assert.equal(fireExact(4000), 0); // wanted provider landed — cleared
  });

  it("does not wait for a wanted provider the server doesn't list", async () => {
    onApi((call) => {
      if (call.path.startsWith("/api/model"))
        return { data: [{ id: "code-supply", providerID: "opencode" }] };
      if (call.path === "/api/config")
        return [{ info: { model: { providerID: "ghost", model: "x" } } }];
      if (call.path === "/api/provider") return { data: [] };
      if (call.path === "/api/project") return [];
      if (call.path === "/api/agent") return [];
      if (call.path === "/api/command") return [];
      if (call.path === "/api/skill") return [];
      if (call.path === "/api/session/active") return {};
      return undefined;
    });
    draftModel.value = undefined;
    resetBaseRetryForTest();
    dispatchWindowMessage({
      type: "sse-event",
      event: { id: "evt_cg", type: "server.connected", data: {} },
    });
    await flushEvents();
    await settle(8);
    assert.equal(providers.value?.all.length ?? 0, 1);
    // Config drift (a default naming an unconfigured provider) is now
    // indistinguishable from a late fill — it arms; the attempt bound
    // (proven in its own test) is what stops it, not the old guard.
    assert.equal(fireExact(1000), 1);
  });

  // The staged route itself: /api/provider can answer with only built-ins
  // while discovery runs, making the boot snapshot internally consistent
  // (every listed provider has rows). `connected` — which unions the
  // config default — must still see the gap and arm.
  it("arms when the provider route itself is still staged", async () => {
    let discovered = false;
    onApi((call) => {
      if (call.path.startsWith("/api/model"))
        return {
          data: [
            { id: "tiny", providerID: "opencode" },
            ...(discovered
              ? [{ id: "glm-5.3", providerID: "zai-coding-plan" }]
              : []),
          ],
        };
      if (call.path === "/api/config")
        return [
          {
            info: { model: { providerID: "zai-coding-plan", model: "glm-5.3" } },
          },
        ];
      if (call.path === "/api/provider")
        return { data: discovered ? [{ id: "zai-coding-plan" }] : [] };
      if (call.path === "/api/project") return [];
      if (call.path === "/api/agent") return [];
      if (call.path === "/api/command") return [];
      if (call.path === "/api/skill") return [];
      if (call.path === "/api/session/active") return {};
      return undefined;
    });
    resetBaseRetryForTest();
    dispatchWindowMessage({
      type: "sse-event",
      event: { id: "evt_ck", type: "server.connected", data: {} },
    });
    await flushEvents();
    await settle(8);
    assert.equal(fireExact(1000), 1); // internally consistent ≠ complete
    await settle(8);
    discovered = true;
    assert.equal(fireExact(2000), 1);
    await settle(8);
    assert.equal(
      providers.value?.all.some((p) => p.id === "zai-coding-plan"),
      true,
    );
    assert.equal(fireExact(4000), 0); // every connected provider landed
  });

  // The abandonment hole: the ladder used to clear on the WANTED
  // provider alone, so switching the pick to an already-filled provider
  // mid-fill stranded every other listed provider on "Loading models…"
  // forever. The clear now waits for every listed provider.
  it("keeps filling after the wanted provider switches away", async () => {
    let zaiFilled = false;
    onApi((call) => {
      if (call.path.startsWith("/api/model"))
        return {
          data: [
            { id: "tiny", providerID: "opencode" },
            { id: "claude", providerID: "amazon-bedrock" },
            ...(zaiFilled
              ? [{ id: "glm-5.3", providerID: "zai-coding-plan" }]
              : []),
          ],
        };
      if (call.path === "/api/config") return [];
      if (call.path === "/api/provider")
        return {
          data: [{ id: "amazon-bedrock" }, { id: "zai-coding-plan" }],
        };
      if (call.path === "/api/project") return [];
      if (call.path === "/api/agent") return [];
      if (call.path === "/api/command") return [];
      if (call.path === "/api/skill") return [];
      if (call.path === "/api/session/active") return {};
      return undefined;
    });
    resetBaseRetryForTest();
    dispatchWindowMessage({
      type: "sse-event",
      event: { id: "evt_ch", type: "server.connected", data: {} },
    });
    await flushEvents();
    await settle(8);
    // zai is listed and rowless — armed, even though bedrock (picked
    // below) is fully present.
    assert.equal(fireExact(1000), 1);
    await settle(8);
    draftModel.value = { providerID: "amazon-bedrock", id: "claude" };
    // The flip must NOT have cleared anything mid-flight: the next fire
    // still re-pulls (zai pending)…
    assert.equal(fireExact(2000), 1);
    await settle(8);
    zaiFilled = true;
    assert.equal(fireExact(4000), 1);
    await settle(8);
    assert.equal(
      providers.value?.all.some((p) => p.id === "zai-coding-plan"),
      true,
    );
    assert.equal(fireExact(8000), 0); // every listed provider landed
    draftModel.value = undefined;
  });

  // A listed provider that genuinely offers no models must not spin the
  // loop forever: the fill phase burns MAX_FILL_ATTEMPTS retries, then
  // the ladder clears.
  it("stops filling after the attempt bound", async () => {
    onApi((call) => {
      if (call.path.startsWith("/api/model"))
        return { data: [{ id: "tiny", providerID: "opencode" }] };
      if (call.path === "/api/config") return [];
      if (call.path === "/api/provider")
        return { data: [{ id: "amazon-bedrock" }] };
      if (call.path === "/api/project") return [];
      if (call.path === "/api/agent") return [];
      if (call.path === "/api/command") return [];
      if (call.path === "/api/skill") return [];
      if (call.path === "/api/session/active") return {};
      return undefined;
    });
    resetBaseRetryForTest();
    dispatchWindowMessage({
      type: "sse-event",
      event: { id: "evt_ci", type: "server.connected", data: {} },
    });
    await flushEvents();
    await settle(8);
    const ladder = [1000, 2000, 4000, 8000];
    for (const delay of ladder) {
      assert.equal(fireExact(delay), 1);
      await settle(8);
    }
    for (let i = 0; i < 6; i++) {
      assert.equal(fireExact(10_000), 1); // attempts 5..10 at the cap
      await settle(8);
    }
    assert.equal(fireExact(10_000), 0); // bound reached — ladder cleared
  });

  // Attention-driven heal: even past the ladder's bound, opening a picker
  // re-pulls the catalog while any listed provider is rowless (the fill
  // may have landed server-side after the last pull).
  it("re-pulls the catalog when a picker opens onto loading rows", async () => {
    let zaiFilled = false;
    onApi((call) => {
      if (call.path.startsWith("/api/model"))
        return {
          data: [
            { id: "tiny", providerID: "opencode" },
            ...(zaiFilled
              ? [{ id: "glm-5.3", providerID: "zai-coding-plan" }]
              : []),
          ],
        };
      if (call.path === "/api/config") return [];
      if (call.path === "/api/provider")
        return { data: [{ id: "zai-coding-plan" }] };
      if (call.path === "/api/project") return [];
      if (call.path === "/api/agent") return [];
      if (call.path === "/api/command") return [];
      if (call.path === "/api/skill") return [];
      if (call.path === "/api/session/active") return {};
      return undefined;
    });
    resetBaseRetryForTest();
    dispatchWindowMessage({
      type: "sse-event",
      event: { id: "evt_cj", type: "server.connected", data: {} },
    });
    await flushEvents();
    await settle(8);
    // Burn the ladder to its bound (zai never fills).
    for (const delay of [1000, 2000, 4000, 8000]) {
      fireExact(delay);
      await settle(8);
    }
    for (let i = 0; i < 6; i++) {
      fireExact(10_000);
      await settle(8);
    }
    assert.equal(fireExact(10_000), 0);
    // The user opens the picker; the server by now has zai's rows.
    zaiFilled = true;
    setNow(Date.now() + 3_000); // past the call's cooldown
    refreshProvidersIfStale();
    await settle(8);
    assert.equal(
      providers.value?.all.some((p) => p.id === "zai-coding-plan"),
      true,
    );
    // Complete now — a second open pulls nothing.
    setNow(Date.now() + 3_000);
    const before = callsFor("/api/model").length;
    refreshProvidersIfStale();
    await settle(8);
    assert.equal(callsFor("/api/model").length, before);
  });
});

describe("v2 SSE → pipeline translation", () => {
  const ev = (type: string, data: Record<string, unknown>) =>
    ({ id: "evt_x", type, data } as const);

  it("stamps the tool and text-end synths with the frame's created", () => {
    // The streamed tool rows read data.timestamp for their elapsed stamps
    // and the footer's tool-span netting; a dropped stamp left v2 live
    // tools timeless and their execution time inside the token rate.
    const stamped = (type: string, data: Record<string, unknown>, created: number) =>
      translateV2Event({ id: "evt_x", type, data, created } as never);
    for (const [type, data] of [
      ["session.tool.input.started", { sessionID: "s", assistantMessageID: "m", id: "c1", name: "bash" }],
      ["session.tool.called", { sessionID: "s", assistantMessageID: "m", id: "c1", input: {} }],
      ["session.tool.success", { sessionID: "s", assistantMessageID: "m", id: "c1" }],
      ["session.tool.failed", { sessionID: "s", assistantMessageID: "m", id: "c1", error: "x" }],
      ["session.text.ended", { sessionID: "s", assistantMessageID: "m", ordinal: 1 }],
      ["session.reasoning.ended", { sessionID: "s", assistantMessageID: "m", ordinal: 1 }],
    ] as const) {
      const out = stamped(type, { ...data }, 4242);
      assert.equal(out.length, 1, type);
      assert.equal((out[0].data as { timestamp?: number }).timestamp, 4242, type);
    }
  });

  it("streams compaction: started opens trigger+row, delta passes through, ended refreshes", () => {
    // started: v1's fold pair — the trigger user row (a lone compaction
    // part; reason "auto" as its auto flag) plus the summary row, keyed
    // by inputID when present, else the event id under its durable msg_
    // name.
    const started = translateV2Event(
      ev("session.compaction.started", {
        sessionID: "s",
        reason: "manual",
        recent: "…",
      }),
    );
    assert.equal(started.length, 3);
    assert.equal(started[0].type, "message.updated");
    assert.deepEqual(
      (started[0].data as { sessionID?: string }).sessionID,
      "s",
    );
    const tInfo = (started[0].data as { info?: Record<string, unknown> }).info;
    assert.equal(tInfo?.id, "msg_x:c");
    assert.equal(tInfo?.role, "user");
    assert.equal(typeof tInfo?.time === "object" && "created" in (tInfo.time as object), true);
    assert.equal(started[1].type, "message.part.updated");
    assert.deepEqual(
      (started[1].data as { part?: unknown }).part,
      {
        id: "msg_x:c:0",
        messageID: "msg_x:c",
        sessionID: "s",
        type: "compaction",
      },
    );
    assert.equal(started[2].type, "session.next.step.started");
    assert.deepEqual(
      started[2].data as Record<string, unknown>,
      {
        sessionID: "s",
        assistantMessageID: "msg_x",
        agent: "compaction",
        timestamp: undefined,
      },
    );
    const withInput = translateV2Event(
      ({ id: "evt_y", type: "session.compaction.started", data: { sessionID: "s", inputID: "msg_in", reason: "auto" } } as const),
    );
    const t2 = (withInput[0].data as { info?: Record<string, unknown> }).info;
    assert.equal(t2?.id, "msg_in:c");
    assert.equal(t2?.role, "user");
    assert.deepEqual((withInput[1].data as { part?: unknown }).part, {
      id: "msg_in:c:0",
      messageID: "msg_in:c",
      sessionID: "s",
      type: "compaction",
      auto: true,
    });
    assert.deepEqual(
      (withInput[2].data as Record<string, unknown>),
      { sessionID: "s", assistantMessageID: "msg_in", agent: "compaction", timestamp: undefined },
    );
    // delta: {sessionID, text} — no row id on the wire; the store finds
    // the open row. Passed through untouched.
    const delta = ev("session.compaction.delta", { sessionID: "s", text: "Sum" });
    assert.deepEqual(translateV2Event(delta), [delta]);
    // ended/failed: the refresh carries the finish.
    assert.deepEqual(
      translateV2Event(ev("session.compaction.ended", { sessionID: "s" })),
      [{ id: "evt_x", type: "session.compaction.done", data: { sessionID: "s" } }],
    );
    assert.deepEqual(
      translateV2Event(ev("session.compaction.failed", { sessionID: "s" })),
      [{ id: "evt_x", type: "session.compaction.done", data: { sessionID: "s" } }],
    );
  });

  it("maps synthetic notes and remote moves", () => {
    const s = translateV2Event(
      ev("session.synthetic", { sessionID: "s", text: "Context trimmed" }),
    );
    assert.equal(s.length, 2);
    assert.equal(s[0].type, "message.updated");
    assert.equal(
      (s[0].data as { info?: { id?: string; role?: string } }).info?.id,
      "msg_x",
    );
    assert.equal(
      (s[0].data as { info?: { role?: string } }).info?.role,
      "assistant",
    );
    assert.equal(s[1].type, "message.part.updated");
    assert.deepEqual(
      (s[1].data as { part?: unknown }).part,
      {
        id: "msg_x:text",
        messageID: "msg_x",
        sessionID: "s",
        type: "text",
        text: "Context trimmed",
      },
    );
    // A peer-tagged injection: the row stays assistant (a streamed user row
    // would trip the echo retirement / ghost-turn abort), the part carries
    // the synthetic + metadata.peerMessage tag so the peer card renders.
    const p = translateV2Event(
      ev("session.synthetic", {
        sessionID: "s",
        text: "Ping from a peer",
        metadata: {
          peerMessage: {
            version: 2,
            messageId: "m1",
            fromEndpointId: "ses_a",
            toSessionId: "s",
          },
        },
      }),
    );
    assert.equal(p.length, 2);
    assert.equal(p[0].type, "message.updated");
    assert.equal(
      (p[0].data as { info?: { role?: string } }).info?.role,
      "assistant",
    );
    assert.equal(p[1].type, "message.part.updated");
    assert.deepEqual(
      (p[1].data as { part?: unknown }).part,
      {
        id: "msg_x:text",
        messageID: "msg_x",
        sessionID: "s",
        type: "text",
        text: "Ping from a peer",
        synthetic: true,
        metadata: {
          peerMessage: {
            version: 2,
            messageId: "m1",
            fromEndpointId: "ses_a",
            toSessionId: "s",
          },
        },
      },
    );
    assert.deepEqual(
      translateV2Event(
        ev("session.moved", {
          sessionID: "s",
          location: { directory: "/w/other" },
        }),
      ),
      [
        {
          id: "evt_x",
          type: "session.updated",
          data: { info: { id: "s", location: { directory: "/w/other" } } },
        },
      ],
    );
  });

  it("step.ended stamps the row's completed time from the frame's created", () => {
    const out = translateV2Event({
      id: "evt_e",
      created: 1234,
      type: "session.step.ended",
      data: {
        sessionID: "s",
        assistantMessageID: "m1",
        finish: "stop",
        cost: 0,
        tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    } as never);
    assert.equal(out.length, 1);
    assert.equal(out[0].type, "session.next.step.ended");
    assert.equal((out[0].data as { timestamp?: number }).timestamp, 1234);
  });

  it("normalizes ISO frames and string model refs", () => {
    const st = translateV2Event({
      id: "evt_s",
      created: "2026-09-27T10:00:00.000Z",
      type: "session.step.started",
      data: {
        sessionID: "s",
        assistantMessageID: "m1",
        agent: "build",
        model: "zai-coding-plan/glm-5.3-flash#fast",
        started: "2026-09-27T09:59:59.000Z",
      },
    } as never);
    assert.equal(st[0].type, "session.next.step.started");
    const d = st[0].data as { model?: unknown; timestamp?: number };
    assert.deepEqual(d.model, {
      providerID: "zai-coding-plan",
      id: "glm-5.3-flash",
      variant: "fast",
    });
    assert.equal(d.timestamp, Date.parse("2026-09-27T09:59:59.000Z"));
    const sel = translateV2Event(
      ev("session.model.selected", { sessionID: "s", model: "p/m" }),
    );
    assert.deepEqual((sel[0].data as { model?: unknown }).model, {
      providerID: "p",
      id: "m",
    });
  });

  it("maps execution lifecycle onto the v1 busy/idle/error truth", () => {    assert.deepEqual(translateV2Event(ev("session.execution.started", { sessionID: "s" })), [
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

  it("addresses streamed parts kind-distinct: `${mid}:t|r${ordinal}`", () => {
    // The wire numbers ordinals per kind (reasoning and text both arrive
    // ordinal 0) — one shared id would glue the answer into the thinking
    // part. The refresh merge matches by kind and position instead.
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
            textID: "msg_a:t1",
            reasoningID: "msg_a:t1",
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
    assert.equal((ended[0].data as { textID?: string }).textID, "msg_a:t1");
    const think = translateV2Event(
      ev("session.reasoning.delta", {
        sessionID: "s",
        assistantMessageID: "msg_a",
        ordinal: 0,
        delta: "hm",
      }),
    );
    assert.equal(
      (think[0].data as { reasoningID?: string }).reasoningID,
      "msg_a:r0",
    );
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
            // The synth carries the frame's created so the streamed tool
            // rows get their elapsed stamps.
            timestamp: undefined,
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

  it("translates tool input streaming frames for live previews", () => {
    const [d] = translateV2Event(
      ev("session.tool.input.delta", {
        sessionID: "s",
        assistantMessageID: "msg_a",
        id: "call_1",
        delta: '{"filePath":"src/a',
      }),
    );
    assert.equal(d.type, "session.next.tool.input.delta");
    assert.equal((d.data as { callID?: string }).callID, "call_1");
    assert.equal((d.data as { delta?: string }).delta, '{"filePath":"src/a');
    const [e] = translateV2Event(
      ev("session.tool.input.ended", {
        sessionID: "s",
        assistantMessageID: "msg_a",
        id: "call_1",
        text: '{"filePath":"src/a.ts"}',
      }),
    );
    assert.equal(e.type, "session.next.tool.input.ended");
    assert.equal((e.data as { callID?: string }).callID, "call_1");
    assert.equal((e.data as { text?: string }).text, '{"filePath":"src/a.ts"}');
    // Frames without the ids or the payload are dropped, not mistranslated.
    assert.deepEqual(
      translateV2Event(
        ev("session.tool.input.delta", { sessionID: "s", id: "call_1" }),
      ),
      [],
    );
    assert.deepEqual(
      translateV2Event(
        ev("session.tool.input.ended", {
          sessionID: "s",
          assistantMessageID: "msg_a",
          id: "call_1",
          text: 42,
        }),
      ),
      [],
    );
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
    // ignores what it does not know — e.g. session.instructions.updated).
    const misc = ev("session.instructions.updated", { sessionID: "s" });
    assert.deepEqual(translateV2Event(misc), [misc]);
  });

  it("maps session facts: permissions, forms, creation, usage, retry", () => {
    // session.permissions {sessionID, permissions[]} → one ask per row.
    assert.deepEqual(
      translateV2Event(
        ev("session.permissions", {
          sessionID: "s",
          permissions: [
            {
              id: "per_1",
              action: "bash",
              resources: ["rm -rf /"],
              save: ["bash"],
              source: { type: "tool", messageID: "m", callID: "c" },
            },
          ],
        }),
      ),
      [
        {
          id: "evt_x",
          type: "permission.v2.asked",
          data: {
            id: "per_1",
            sessionID: "s",
            action: "bash",
            resources: ["rm -rf /"],
            save: ["bash"],
            source: { type: "tool", messageID: "m", callID: "c" },
          },
        },
      ],
    );
    // form.created {sessionID, form} → the v1 question shape.
    const asked = translateV2Event(
      ev("form.created", {
        sessionID: "s",
        form: formRow(
          "frm_1",
          "Continue?",
          "choice",
          [
            ["yes", "Yes"],
            ["no", "No"],
          ],
          "s",
        ),
      }),
    );
    assert.equal(asked.length, 1);
    assert.equal(asked[0].type, "question.v2.asked");
    const q = asked[0].data as {
      id?: string;
      formFields?: { key: string; multiple: boolean; optionValues?: Record<string, string> }[];
      questions?: { question?: string; options?: { label: string }[]; custom?: boolean }[];
    };
    assert.equal(q.id, "frm_1");
    assert.deepEqual(q.formFields, [
      { key: "choice", multiple: false, optionValues: { Yes: "yes", No: "no" } },
    ]);
    assert.equal(q.questions?.[0].question, "Continue?");
    assert.deepEqual(q.questions?.[0].options, [{ label: "Yes" }, { label: "No" }]);
    assert.equal(q.questions?.[0].custom, false);
    // settle events
    assert.deepEqual(
      translateV2Event(ev("form.replied", { sessionID: "s", id: "frm_1" })),
      [
        {
          id: "evt_x",
          type: "question.v2.replied",
          data: { requestID: "frm_1", sessionID: "s" },
        },
      ],
    );
    assert.deepEqual(
      translateV2Event(ev("form.cancelled", { sessionID: "s", id: "frm_1" })),
      [
        {
          id: "evt_x",
          type: "question.v2.rejected",
          data: { requestID: "frm_1", sessionID: "s" },
        },
      ],
    );
    // session.created → a facts-only partial row (defaults land on the
    // store's upsert path, so a known row's title/cost survive).
    const created = translateV2Event(
      ev("session.created", { sessionID: "s2", title: "T", parentID: "s1" }),
    );
    assert.equal(created[0].type, "session.updated");
    const info = (created[0].data as { info: Record<string, unknown> }).info;
    assert.equal(info.id, "s2");
    assert.equal(info.title, "T");
    assert.equal(info.parentID, "s1");
    assert.equal("cost" in info, false);
    // usage → partial row merge
    const usage = translateV2Event(
      ev("session.usage.updated", {
        sessionID: "s",
        cost: 1.5,
        tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    );
    assert.equal(usage[0].type, "session.updated");
    assert.equal(
      ((usage[0].data as { info: { cost?: number } }).info).cost,
      1.5,
    );
    // retry.scheduled → v1 retry status
    const retry = translateV2Event(
      ev("session.retry.scheduled", {
        sessionID: "s",
        attempt: 2,
        at: 1234,
        error: { message: "rate limited" },
      }),
    );
    assert.deepEqual(retry[0].data, {
      sessionID: "s",
      status: { type: "retry", attempt: 2, message: "rate limited", next: 1234 },
    });
    // bare permission.asked/replied carry the v2 schema — must dock and
    // undock through the v2 cases, not the v1 names they share.
    const askedPerm = translateV2Event(
      ev("permission.asked", {
        id: "pr_1",
        sessionID: "s",
        action: "bash",
        resources: ["cat foo"],
      }),
    );
    assert.deepEqual(askedPerm, [
      {
        id: "evt_x",
        type: "permission.v2.asked",
        data: {
          id: "pr_1",
          sessionID: "s",
          action: "bash",
          resources: ["cat foo"],
          save: [],
          source: undefined,
        },
      },
    ]);
    assert.deepEqual(
      translateV2Event(
        ev("permission.replied", {
          sessionID: "s",
          requestID: "pr_1",
          reply: "once",
        }),
      )[0].type,
      "permission.v2.replied",
    );
    // tool.success metadata rides along (subagent chip, edit diffs).
    const ok = translateV2Event(
      ev("session.tool.success", {
        sessionID: "s",
        assistantMessageID: "am",
        id: "cal",
        metadata: { sessionId: "child" },
      }),
    );
    assert.deepEqual(
      (ok[0].data as { metadata?: unknown }).metadata,
      { sessionId: "child" },
    );
    // revert markers across clients
    const staged = translateV2Event(
      ev("session.revert.staged", {
        sessionID: "s",
        revert: { messageID: "msg_1" },
      }),
    );
    assert.deepEqual(
      (staged[0].data as { info: unknown }).info,
      { id: "s", revert: { messageID: "msg_1" } },
    );
    for (const t of ["session.revert.cleared", "session.revert.committed"]) {
      const cleared = translateV2Event(ev(t, { sessionID: "s" }));
      assert.deepEqual((cleared[0].data as { info: unknown }).info, {
        id: "s",
        revert: null,
      });
    }
    // compaction's end signals the store to pull the summary row
    assert.deepEqual(
      translateV2Event(ev("session.compaction.ended", { sessionID: "s" })),
      [{ id: "evt_x", type: "session.compaction.done", data: { sessionID: "s" } }],
    );
  });

  it("frames without a sessionID or coordinates translate to nothing", () => {
    assert.deepEqual(translateV2Event(ev("session.step.started", {})), []);
    assert.deepEqual(translateV2Event(ev("session.text.delta", { delta: "x" })), []);
    assert.deepEqual(
      translateV2Event(ev("session.inbox.enqueued", { sessionID: "s" })),
      [ev("session.inbox.enqueued", { sessionID: "s" })],
    );
  });

  it("maps a config re-read to a base refresh", () => {
    // The disable toggle writes the config file; the server watcher
    // emits config.updated — the catalog may have changed shape, so the
    // app re-pulls exactly like a reconnect.
    assert.deepEqual(translateV2Event(ev("config.updated", {})), [
      { id: "evt_x", type: "server.connected", data: {} },
    ]);
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

    v2sse(
      "session.step.ended",
      {
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
      },
      T0 + 3000,
    );
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
    // The frame's created stamps the row's completed time — the settled
    // tok/s and the wall duration divide from it.
    assert.equal(assistant?.info.time.completed, T0 + 3000);
    const reasoning = assistant?.parts.find((p) => p.id === "msg_a:r0");
    assert.equal(reasoning?.type, "reasoning");
    assert.equal((reasoning as { text?: string }).text, "think hard");
    const text = assistant?.parts.find((p) => p.id === "msg_a:t1");
    assert.equal(text?.type, "text");
    assert.equal((text as { text?: string }).text, "Hi!");
    // The step's usage also landed on the session row (running sum).
    assert.equal(sessions.value[0].tokens.input, 4999);
  });

  it("keeps the per-tool elapsed span on streamed v2 tool calls", async () => {
    init();
    const sid = "v2tool";
    sessions.value = [sessRow(sid)];
    messagesBySession.value = new Map([
      [sid, [row("u1", "user", T0), row("msg_t", "assistant", T0)]],
    ]);
    const partOf = (pid: string) =>
      (messagesBySession.value.get(sid) ?? [])
        .flatMap((m) => m.parts)
        .find((p) => p.id === pid) as
      | { state?: { status?: string; time?: { start?: number; end?: number } } }
      | undefined;
    // Full sequence — called refines the start, success stamps the end.
    v2sse(
      "session.tool.input.started",
      { sessionID: sid, assistantMessageID: "msg_t", id: "c1", name: "bash" },
      T0 + 100,
    );
    v2sse(
      "session.tool.called",
      {
        sessionID: sid,
        assistantMessageID: "msg_t",
        id: "c1",
        input: { command: "ls" },
      },
      T0 + 150,
    );
    v2sse(
      "session.tool.success",
      { sessionID: sid, assistantMessageID: "msg_t", id: "c1" },
      T0 + 900,
    );
    await flushEvents();
    assert.equal(partOf("c1")?.state?.status, "completed");
    assert.deepEqual(partOf("c1")?.state?.time, {
      start: T0 + 150,
      end: T0 + 900,
    });
    // Short-circuited tool — no called frame: the input.started stamp IS
    // the span, so the elapsed tip survives settling.
    v2sse(
      "session.tool.input.started",
      { sessionID: sid, assistantMessageID: "msg_t", id: "c2", name: "grep" },
      T0 + 2000,
    );
    v2sse(
      "session.tool.success",
      { sessionID: sid, assistantMessageID: "msg_t", id: "c2" },
      T0 + 2400,
    );
    await flushEvents();
    assert.deepEqual(partOf("c2")?.state?.time, {
      start: T0 + 2000,
      end: T0 + 2400,
    });
  });

  it("lands the admitted user row with attachment and mention parts", async () => {
    init();
    const sid = "v2send";
    sessions.value = [sessRow(sid, { agent: "build" })];
    onApi((call) =>
      call.method === "POST" && call.path === `/api/session/${sid}/prompt`
        ? {
            data: {
              id: "msg_u1",
              sessionID: sid,
              time: { created: T0 + 1 },
              type: "user",
              payload: { text: "see @src/a.ts" },
              delivery: "steer",
            },
          }
        : undefined,
    );
    await sendPrompt(sid, "see @src/a.ts", [
      { uri: "data:image/png;base64,AA", name: "p.png" },
    ]);
    const list = messagesBySession.value.get(sid) ?? [];
    assert.ok(!list.some((m) => m.info.id.startsWith("pending:")));
    const admitted = list.find((m) => m.info.id === "msg_u1");
    assert.equal(admitted?.info.role, "user");
    const files = (admitted?.parts ?? []).filter(
      (p) => p.type === "file",
    ) as FilePart[];
    assert.equal(files.length, 2);
    // the pasted image: data: chip shape
    assert.equal(files[0].url, "data:image/png;base64,AA");
    assert.equal(files[0].filename, "p.png");
    assert.equal(files[0].source, undefined);
    // the @-mention: pill shape (file:// url plus its source range)
    assert.equal(files[1].url, "file:///C:/work/repo/src/a.ts");
    assert.deepEqual(files[1].source?.text, {
      value: "@src/a.ts",
      start: 4,
      end: 13,
    });
    assert.equal(files[1].source?.path, "C:\\work\\repo/src/a.ts");
  });

  it("docks bare permission.asked, merges remote reverts and wire usage", async () => {
    init();
    const sid = "v2asks";
    sessions.value = [sessRow(sid, { title: "Real title", cost: 1 })];

    // The v2-shaped bare event must dock like session.permissions does.
    v2sse("permission.asked", {
      id: "pr_9",
      sessionID: sid,
      action: "bash",
      resources: ["ls"],
    });
    await flushEvents();
    assert.ok(
      (await import("./store")).pendingPermissions.value.some(
        (p) => p.id === "pr_9" && p.v1 !== true,
      ),
    );

    // Remote revert marker merges without blanking the row it lands on.
    v2sse("session.revert.staged", {
      sessionID: sid,
      revert: { messageID: "msg_1" },
    });
    await flushEvents();
    assert.equal(sessions.value[0].revert?.messageID, "msg_1");
    assert.equal(sessions.value[0].title, "Real title");
    v2sse("session.revert.committed", { sessionID: sid });
    await flushEvents();
    assert.equal(sessions.value[0].revert, undefined);
    assert.equal(sessions.value[0].title, "Real title");

    // Wire usage is the running sum — a SET, not another delta add.
    v2sse("session.usage.updated", {
      sessionID: sid,
      cost: 0.5,
      tokens: {
        input: 10,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    });
    await flushEvents();
    assert.equal(sessions.value[0].cost, 0.5);
    assert.equal(sessions.value[0].tokens.input, 10);
  });

  it("streams a v2 compaction summary; done swaps the durable row in", async () => {
    init();
    const sid = "v2cmp";
    sessions.value = [sessRow(sid)];
    messagesBySession.value = new Map([[sid, [row("u1", "user", T0)]]]);

    v2sse("session.compaction.started", { sessionID: sid, reason: "manual" });
    await flushEvents();
    // The fold pair: a trigger user row (lone compaction part) precedes
    // the summary row.
    let listT = messagesBySession.value.get(sid) ?? [];
    const trigger = listT.find((m) => m.info.id.endsWith(":c"));
    assert.equal(trigger?.info.role, "user");
    assert.deepEqual(
      trigger?.parts.map((p) => p.type),
      ["compaction"],
    );
    v2sse("session.compaction.delta", { sessionID: sid, text: "The user " });
    v2sse("session.compaction.delta", { sessionID: sid, text: "greeted." });
    await flushEvents();
    const list0 = messagesBySession.value.get(sid) ?? [];
    const live = list0.find((m) => m.info.agent === "compaction");
    assert.ok(live, "started opened a compaction row");
    assert.equal(live.info.role, "assistant");
    const liveText = live.parts.find((p) => p.type === "text") as
      | { text?: string }
      | undefined;
    assert.equal(liveText?.text, "The user greeted.");

    // The durable fetch serves the completed row under the same id —
    // done's refresh must merge it, not duplicate it.
    onApi((call) =>
      call.path.startsWith(`/api/session/${sid}/message`)
        ? {
            data: [
              {
                id: live.info.id,
                time: { created: T0 + 1, completed: T0 + 2 },
                type: "compaction",
                status: "completed",
                reason: "manual",
                summary: "The user greeted. (durable)",
              },
            ],
          }
        : undefined,
    );
    v2sse("session.compaction.ended", { sessionID: sid });
    await flushEvents();
    const list = messagesBySession.value.get(sid) ?? [];
    const done = list.filter((m) => m.info.agent === "compaction");
    assert.equal(done.length, 1);
    const doneText = done[0].parts.find((p) => p.type === "text") as
      | { text?: string }
      | undefined;
    assert.equal(doneText?.text, "The user greeted. (durable)");
  });

  it("renders v2 native shell runs as tool rows", async () => {
    init();
    const sid = "v2sh";
    sessions.value = [sessRow(sid)];
    messagesBySession.value = new Map([[sid, []]]);

    v2sse("session.shell.started", {
      sessionID: sid,
      shell: { id: "sh_1", command: "npm test", status: "running" },
    });
    await flushEvents();
    let part: {
      type?: string;
      tool?: string;
      state?: { status?: string; input?: unknown; output?: string };
    } | undefined = (messagesBySession.value.get(sid) ?? [])
      .flatMap((m) => m.parts)
      .find((p) => p.id === "sh_1") as typeof part;
    assert.equal(part?.type, "tool");
    assert.equal(part?.tool, "bash");
    assert.equal(part?.state?.status, "running");
    assert.deepEqual(part?.state?.input, { command: "npm test" });

    v2sse("session.shell.ended", {
      sessionID: sid,
      shell: { id: "sh_1", status: "completed", exit: 0 },
      output: "ok\n",
    });
    await flushEvents();
    part = (messagesBySession.value.get(sid) ?? [])
      .flatMap((m) => m.parts)
      .find((p) => p.id === "sh_1") as typeof part;
    assert.equal(part?.state?.status, "completed");
    assert.equal(part?.state?.output, "ok\n");
  });
});
