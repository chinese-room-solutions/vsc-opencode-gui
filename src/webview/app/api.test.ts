import "./setup.test";
import { strict as assert } from "node:assert";
import {
  API_FAIL,
  flushEvents,
  onApi,
  dispatchWindowMessage,
} from "./setup.test";
import {
  attachMime,
  attachmentParts,
  clampPartText,
  clampToolOutput,
  fetchMessages,
  fetchSessions,
  forgetTruncatedParts,
  isTruncatedPart,
  normalizePermission,
  normalizeSession,
  stringifyError,
  toolName,
  PART_TEXT_CAP,
} from "./api";

describe("api", () => {
  describe("normalizeSession", () => {
    it("maps a root directory onto location", () => {
      const row = normalizeSession({
        id: "s1",
        projectID: "p",
        title: "t",
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        time: { created: 1, updated: 2 },
        directory: "C:\\w\\repo",
      } as never);
      assert.deepEqual(row.location, { directory: "C:\\w\\repo" });
    });
    it("keeps an existing location over a root directory", () => {
      const row = normalizeSession({
        id: "s1",
        location: { directory: "kept" },
        directory: "dropped",
      } as never);
      assert.equal(row.location.directory, "kept");
    });
  });

  describe("normalizePermission", () => {
    it("maps the v1 field names", () => {
      const p = normalizePermission(
        {
          id: "per1",
          sessionID: "s1",
          action: "ignored",
          resources: [],
          save: [],
          permission: "bash",
          patterns: ["rm -rf"],
          always: ["always:x"],
          tool: { messageID: "m1", callID: "c1" },
        },
        true,
      );
      assert.equal(p.action, "bash");
      assert.deepEqual(p.resources, ["rm -rf"]);
      assert.deepEqual(p.save, ["always:x"]);
      assert.deepEqual(p.source, {
        type: "tool",
        messageID: "m1",
        callID: "c1",
      });
      assert.equal(p.v1, true);
    });
    it("passes v2 fields through", () => {
      const p = normalizePermission(
        {
          id: "per2",
          sessionID: "s1",
          action: "edit",
          resources: ["a.ts"],
          save: [],
          source: { type: "tool", messageID: "m1", callID: "c2" },
        },
        false,
      );
      assert.equal(p.action, "edit");
      assert.deepEqual(p.resources, ["a.ts"]);
      assert.equal(p.v1, false);
    });
  });

  describe("toolName", () => {
    it("labels the renamed schema ids", () => {
      assert.equal(toolName("bash"), "Shell");
      assert.equal(toolName("apply_patch"), "Patch");
      assert.equal(toolName("webfetch"), "Fetch");
      assert.equal(toolName("websearch"), "Web Search");
      assert.equal(toolName("todowrite"), "Todo");
      assert.equal(toolName("todoread"), "Todo");
    });
    it("capitalizes everything else", () => {
      assert.equal(toolName("read"), "Read");
      assert.equal(toolName("grep"), "Grep");
      assert.equal(toolName("custom_tool"), "Custom_tool");
    });
  });

  describe("text clamps", () => {
    it("passes short text through untouched", () => {
      assert.equal(clampPartText("p", "hello"), "hello");
      assert.equal(isTruncatedPart("p"), false);
    });
    it("clamps oversized text to head + marker + tail", () => {
      const text = `A${"x".repeat(PART_TEXT_CAP)}B`;
      const out = clampPartText("big", text);
      assert.ok(out.length < text.length);
      assert.ok(out.startsWith("A"));
      assert.ok(out.endsWith("B"));
      assert.ok(out.includes(`${text.length} chars total`));
      assert.equal(isTruncatedPart("big"), true);
    });
    it("tracks and forgets truncated ids", () => {
      clampToolOutput("t1", "y".repeat(PART_TEXT_CAP + 1));
      assert.equal(isTruncatedPart("t1"), true);
      forgetTruncatedParts(["t1"]);
      assert.equal(isTruncatedPart("t1"), false);
    });
  });

  describe("attachMime", () => {
    it("knows image and pdf extensions", () => {
      assert.equal(attachMime("a.png", ""), "image/png");
      assert.equal(attachMime("a.JPG", ""), "image/jpeg");
      assert.equal(attachMime("a.gif", ""), "image/gif");
      assert.equal(attachMime("a.webp", ""), "image/webp");
      assert.equal(attachMime("a.pdf", ""), "application/pdf");
    });
    it("rides source/config/data extensions as text", () => {
      assert.equal(attachMime("a.ts", ""), "text/plain");
      assert.equal(attachMime("package.json", ""), "text/plain");
      assert.equal(attachMime("no-ext", ""), undefined);
      assert.equal(attachMime("app.exe", ""), undefined);
    });
    it("sniffs the blob type when the name has no usable extension", () => {
      assert.equal(attachMime("clipboard", "image/png"), "image/png");
      assert.equal(attachMime("clipboard", "application/json"), "text/plain");
      assert.equal(attachMime("clipboard", "application/octet-stream"), undefined);
    });
  });

  describe("attachmentParts", () => {
    it("takes the mime from a data URI, not the name", () => {
      const [part] = attachmentParts([
        { uri: "data:image/png;base64,AAAA", name: "pasted.png" },
      ]) as { type: string; mime?: string; filename?: string }[];
      assert.equal(part.type, "file");
      assert.equal(part.mime, "image/png");
      assert.equal(part.filename, "pasted.png");
    });
    it("falls back to the extension for file urls", () => {
      const [a, b] = attachmentParts([
        { uri: "file:///x/notes.txt", name: "notes.txt" },
        { uri: "/tmp/img.jpeg", name: "img.jpeg" },
      ]) as { mime?: string }[];
      assert.equal(a.mime, "text/plain");
      assert.equal(b.mime, "image/jpeg");
    });
  });

  describe("stringifyError", () => {
    it("handles strings, messages, nested data, and nothing", () => {
      assert.equal(stringifyError("boom"), "boom");
      assert.equal(stringifyError({ message: "boom" }), "boom");
      assert.equal(
        stringifyError({ data: { message: "deep" } }),
        "deep",
      );
      assert.equal(stringifyError({}), "The tool failed.");
    });
  });

  describe("fetchSessions", () => {
    it("unwraps the {data, cursor} envelope", async () => {
      onApi(() => ({
        data: [{ id: "s1" }, { id: "s2" }],
        cursor: { next: "cur1" },
      }));
      const page = await fetchSessions();
      assert.deepEqual(page!.sessions.map((s) => s.id), ["s1", "s2"]);
      assert.equal(page!.next, "cur1");
    });
    it("fails (undefined) when the relay reports failure", async () => {
      onApi(() => API_FAIL);
      assert.equal(await fetchSessions(), undefined);
    });
  });

  describe("fetchMessages", () => {
    it("maps v2 rows into the live dialect", async () => {
      onApi((call) => {
        if (call.path.includes("/api/session/sx/message")) {
          return {
            data: [
              {
                id: "sys1",
                type: "system",
                time: { created: 1 },
                text: "Today's date is now …",
              },
              {
                id: "u1",
                type: "user",
                time: { created: 10 },
                text: "hello",
              },
              {
                id: "a1",
                type: "assistant",
                time: { created: 20 },
                model: { id: "m1", providerID: "p1" },
                cost: 0.5,
                tokens: {
                  input: 10,
                  output: 5,
                  reasoning: 0,
                  cache: { read: 0, write: 0 },
                },
                content: [
                  { type: "reasoning", id: "r1", time: { created: 20, completed: 21 } },
                  {
                    type: "tool",
                    id: "t1",
                    name: "bash",
                    state: {
                      status: "error",
                      input: '{"command": "ls"}',
                      error: { message: "Tool execution interrupted" },
                      content: [{ type: "text", text: "partial out" }],
                    },
                  },
                  { type: "text", id: "x1", text: "answer" },
                ],
              },
            ],
            cursor: { next: "page2" },
          };
        }
      });
      const page = await fetchMessages("sx", undefined, 3);
      assert.deepEqual(
        page!.messages.map((m) => m.info.id),
        ["u1", "a1"],
      );
      const [user, assistant] = page!.messages;
      assert.equal(user.parts[0].id, "u1:text");
      assert.equal((user.parts[0] as { text?: string }).text, "hello");
      assert.equal(user.info.role, "user");
      // system rows filtered; assistant parentID points at the preceding user row
      assert.equal(assistant.info.parentID, "u1");
      assert.equal(assistant.info.providerID, "p1");
      assert.equal(assistant.info.modelID, "m1");
      assert.equal(assistant.info.reportedChars, "answer".length);
      const [reasoning, tool, text] = assistant.parts as unknown as {
        time?: { start?: number; end?: number };
        tool?: string;
        state?: { output?: string; input?: unknown; error?: string };
        text?: string;
      }[];
      // durable reasoning time {created, completed} normalized to {start, end}
      assert.deepEqual(reasoning.time, { start: 20, end: 21 });
      // tool named via `name` → `tool`; content folded into output when
      // there is no output string; string input parsed to an object; error
      // stringified
      assert.equal(tool.tool, "bash");
      assert.equal(tool.state?.output, "partial out");
      assert.deepEqual(tool.state?.input, { command: "ls" });
      assert.equal(tool.state?.error, "Tool execution interrupted");
      assert.equal(text.text, "answer");
      // a full page keeps the older-page cursor
      assert.equal(page!.next, "page2");
    });
    it("drops the cursor on a short page (transcript complete)", async () => {
      onApi((call) => {
        if (call.path.includes("/api/session/sy/message"))
          return { data: [{ id: "u1", type: "user", time: { created: 1 } }], cursor: { next: "stale" } };
      });
      const page = await fetchMessages("sy");
      assert.equal(page!.messages.length, 1);
      assert.equal(page!.next, undefined);
    });
    it("keeps the cursor when the page came back full", async () => {
      const rows = Array.from({ length: 50 }, (_, i) => ({
        id: `m${i}`,
        type: "user",
        time: { created: i },
      }));
      onApi((call) => {
        if (call.path.includes("/api/session/sz/message"))
          return { data: rows, cursor: { next: "more" } };
      });
      const page = await fetchMessages("sz");
      assert.equal(page!.messages.length, 50);
      assert.equal(page!.next, "more");
    });
    it("answers relay failures with undefined", async () => {
      onApi(() => API_FAIL);
      assert.equal(await fetchMessages("sx"), undefined);
    });
  });

  it("api-result frames that match no request are ignored", async () => {
    dispatchWindowMessage({ type: "api-result", id: 99999, ok: true });
    await flushEvents();
  });
});
