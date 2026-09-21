import "./setup.test";
import { strict as assert } from "node:assert";
import {
  atTrigger,
  mentionTokens,
  parseMentions,
  pillifyOwnText,
  resourcedParts,
} from "./mentions";

describe("mentions", () => {
  describe("atTrigger", () => {
    it("reads the live token at the caret", () => {
      assert.equal(atTrigger("hello @src", 10), "src");
      assert.equal(atTrigger("@start", 6), "start");
      assert.equal(atTrigger("a @b@c d", 4), "b");
      assert.equal(atTrigger("a @b@c d", 5), undefined);
    });
    it("stays undefined without a fresh @", () => {
      assert.equal(atTrigger("hello", 5), undefined);
      assert.equal(atTrigger("mail@x", 6), undefined);
      assert.equal(atTrigger("", 0), undefined);
    });
  });

  describe("parseMentions", () => {
    type Mention = {
      type: string;
      url?: string;
      mime?: string;
      name?: string;
      source?: {
        path?: string;
        value?: string;
        text?: { value: string; start: number; end: number };
      };
    };
    const parse = (text: string, base: string, agents: string[]) =>
      parseMentions(text, base, agents) as unknown as Mention[];

    it("lifts a file mention into a file part with source range", () => {
      const text = "see @src/a.ts please";
      const [part] = parse(text, "C:\\w\\repo", []);
      assert.equal(part.type, "file");
      assert.equal(part.mime, "text/plain");
      assert.equal(part.url, "file:///C:/w/repo/src/a.ts");
      assert.equal(part.source?.path, "C:\\w\\repo/src/a.ts");
      assert.equal(part.source?.text?.value, "@src/a.ts");
      assert.deepEqual(
        [part.source?.text?.start, part.source?.text?.end],
        [text.indexOf("@src/a.ts"), text.indexOf("@src/a.ts") + 9],
      );
    });
    it("supports #line and #start-end ranges (TUI syntax)", () => {
      const [a, b] = parse("x @a.go#10 y @b.go#20-30", "/r", []);
      assert.equal(a.url, "file:///r/a.go?start=10");
      assert.equal(b.url, "file:///r/b.go?start=20&end=30");
    });
    it("strips sentence punctuation from the token", () => {
      const [part] = parse("see @a.ts.", "/r", []);
      assert.equal(part.url, "file:///r/a.ts");
    });
    it("keeps the drive colon bare and percent-encodes segments", () => {
      const [part] = parse("@a.ts", "C:\\w d", []);
      assert.equal(part.url, "file:///C:/w%20d/a.ts");
    });
    it("treats a token naming an agent as an agent part", () => {
      const [part] = parse("run @reviewer on it", "/r", ["reviewer"]);
      assert.equal(part.type, "agent");
      assert.equal(part.name, "reviewer");
      assert.equal(part.source?.value, "@reviewer");
    });
    it("does not fire on emails or mid-word @", () => {
      assert.deepEqual(parse("mail me a@b.com", "/r", []), []);
      assert.deepEqual(parse("x@y", "/r", []), []);
    });
    it("dedupes file mentions by url", () => {
      assert.equal(parse("@a.ts and @a.ts", "/r", []).length, 1);
    });
    it("marks directory mentions as x-directory", () => {
      const [part] = parse("@src/", "/r", []);
      assert.equal(part.mime, "application/x-directory");
    });
    it("trusts absolute paths as-is", () => {
      const [part] = parse("@C:\\other\\x.ts", "C:\\w", []);
      assert.equal(part.url, "file:///C:/other/x.ts");
    });
    it("mentions after opening punctuation count", () => {
      assert.equal(parse("(@a.ts) [\"@b.ts\"]", "/r", []).length, 2);
    });
    it("leaves bare words as prose (no file part)", () => {
      assert.deepEqual(parse("ping @here and @channel", "/r", []), []);
      assert.deepEqual(parse("ask @reviewer, then stop", "/r", []), []);
      assert.deepEqual(parse("try @src or @v2", "/r", []), []);
    });
    it("still attaches path-shaped tokens", () => {
      assert.equal(parse("see @README.md", "/r", []).length, 1);
      assert.equal(parse("look in @src/", "/r", []).length, 1);
      assert.equal(parse("home @~/x.ts", "/r", []).length, 1);
      assert.equal(parse("run @reviewer on it", "/r", ["reviewer"]).length, 1);
    });
  });

  describe("mentionTokens", () => {
    type Mention = {
      type: string;
      url?: string;
      mime?: string;
      name?: string;
      source?: {
        path?: string;
        value?: string;
        text?: { value: string; start: number; end: number };
      };
    };
    const parse = (text: string, base: string, agents: string[]) =>
      parseMentions(text, base, agents) as unknown as Mention[];

    // Scanner/parser parity: the composer's chips are the send path's parts
    // — file/dir tokens map 1:1 (in order, incl. source ranges and urls).
    it("file/dir tokens map 1:1 to parseMentions' file parts", () => {
      const agents = ["reviewer"];
      const texts = [
        "see @src/a.ts and @docs/ plus @a.go#10-30, then @reviewer @nope @x.ts.",
        "one @a.ts two @a.ts dup, abs @C:\\other\\x.ts home @~/z.ts",
        "@a.ts#7 @a.ts#7-9 @a.ts",
      ];
      for (const text of texts) {
        const toks = mentionTokens(text, "C:\\w\\repo", agents);
        const parts = parse(text, "C:\\w\\repo", agents).filter(
          (p) => p.type === "file",
        );
        const fd = toks.filter((t) => t.kind !== "agent");
        assert.equal(fd.length, parts.length, text);
        fd.forEach((t, i) => {
          const p = parts[i];
          assert.equal(t.value, p.source?.text?.value, text);
          assert.equal(t.start, p.source?.text?.start, text);
          assert.equal(t.end, p.source?.text?.end, text);
          assert.equal(text.slice(t.start, t.end), t.value, text);
          assert.equal(t.path, p.source?.path, text);
          assert.equal(t.url, p.url, text);
          assert.equal(
            t.kind === "dir" ? "application/x-directory" : "text/plain",
            p.mime,
            text,
          );
        });
      }
    });
    it("agent tokens are their own kind, excluded from chips", () => {
      const toks = mentionTokens("run @reviewer now", "/r", ["reviewer"]);
      assert.equal(toks.length, 1);
      assert.equal(toks[0].kind, "agent");
      assert.equal(toks[0].name, "reviewer");
      assert.equal(toks[0].path, undefined);
      assert.equal(toks[0].url, undefined);
    });
    it("splits kinds, ranges and resolved paths per token", () => {
      const [dir, file] = mentionTokens("x @docs/ y @a.go#10-20", "/r", []);
      assert.equal(dir.kind, "dir");
      assert.equal(dir.rel, "docs/");
      assert.equal(dir.path, "/r/docs/");
      assert.equal(file.kind, "file");
      assert.equal(file.rel, "a.go");
      assert.equal(file.path, "/r/a.go");
      assert.equal(file.line, "10");
      assert.equal(file.endLine, "20");
      assert.equal(file.range, "?start=10&end=20");
      assert.equal(file.value, "@a.go#10-20");
    });
  });

  describe("pillifyOwnText", () => {
    const mention = (value: string, start: number, url = "file:///r/a.ts") => ({
      type: "file",
      url,
      source: {
        type: "file",
        path: "/r/a.ts",
        text: { value, start, end: start + value.length },
      },
    });
    it("lifts a mention into a file-ref pill, text around kept", () => {
      const out = pillifyOwnText([
        { type: "text", text: "see @a.ts ok" } as never,
        mention("@a.ts", 4),
      ] as never);
      assert.equal(
        out,
        'see <span class="file-ref mention-pill" data-path="/r/a.ts">@a.ts</span> ok',
      );
    });
    it("carries the line range from the url query", () => {
      const out = pillifyOwnText([
        { type: "text", text: "x @a.go#10-30" } as never,
        mention("@a.go", 2, "file:///r/a.go?start=10&end=30"),
      ] as never);
      assert.match(out, /data-line="10" data-endLine="30"/);
    });
    it("carries the part index for inlined image pills", () => {
      const out = pillifyOwnText([
        { type: "text", text: "see @5.png ok" } as never,
        {
          type: "file",
          url: "data:image/jpeg;base64,AAAA",
          source: {
            type: "file",
            path: "/r/5.png",
            text: { value: "@5.png", start: 4, end: 10 },
          },
        },
      ] as never);
      assert.match(out, /data-img-idx="1"/);
    });
    it("flags directory pills so clicks take the openExternal branch", () => {
      const out = pillifyOwnText([
        { type: "text", text: "in @docs/ ok" } as never,
        {
          type: "file",
          url: "file:///r/docs/",
          mime: "application/x-directory",
          source: {
            type: "file",
            path: "/r/docs/",
            text: { value: "@docs/", start: 3, end: 9 },
          },
        },
      ] as never);
      assert.equal(
        out,
        'in <span class="file-ref mention-pill" data-path="/r/docs/" data-dir="1">@docs/</span> ok',
      );
    });
    it("passes text through untouched without mention parts", () => {
      const out = pillifyOwnText([
        { type: "text", text: "plain @words only" } as never,
      ] as never);
      assert.equal(out, "plain @words only");
    });
    it("markdown-escapes the token so snake_case survives marked", () => {
      const out = pillifyOwnText([
        { type: "text", text: "see @my_file.ts" } as never,
        mention("@my_file.ts", 4, "file:///r/my_file.ts"),
      ] as never);
      assert.match(out, />@my\\_file\.ts<\/span>$/);
    });
    it("skips ranges whose slice no longer matches the token", () => {
      const out = pillifyOwnText([
        { type: "text", text: "edited text" } as never,
        mention("@a.ts", 4),
      ] as never);
      assert.equal(out, "edited text");
    });
  });

  describe("resourcedParts", () => {
    it("re-sources a sourceless data: part whose filename matches a token", () => {
      const out = resourcedParts(
        [
          { type: "text", text: "see @5.png ok" } as never,
          {
            type: "file",
            url: "data:image/png;base64,AAAA",
            mime: "image/png",
            filename: "5.png",
          } as never,
        ],
        "/r",
        [],
      );
      const f = out[1] as unknown as {
        source: { path: string; text: { value: string; start: number } };
      };
      assert.equal(f.source.path, "/r/5.png");
      assert.equal(f.source.text.value, "@5.png");
      assert.equal(f.source.text.start, 4);
      // And the re-derived source pillifies.
      assert.match(
        pillifyOwnText(out as never),
        /class="file-ref mention-pill" data-path="\/r\/5\.png"/,
      );
    });
    it("leaves unmatched filenames and already-sourced parts alone", () => {
      const sourced = {
        type: "file",
        url: "file:///r/a.ts",
        source: {
          type: "file",
          path: "/r/a.ts",
          text: { value: "@a.ts", start: 4, end: 9 },
        },
      };
      const loose = {
        type: "file",
        url: "data:image/png;base64,AAAA",
        mime: "image/png",
        filename: "other.png",
      };
      const parts = [
        { type: "text", text: "see @a.ts ok" } as never,
        sourced,
        loose,
      ] as never;
      assert.equal(resourcedParts(parts, "/r", []), parts);
    });
    it("re-sources a filename-less inlined part by order (the server strips both)", () => {
      const out = resourcedParts(
        [
          { type: "text", text: "see @shot.png ok" } as never,
          {
            type: "file",
            url: "data:image/jpeg;base64,AAAA",
            mime: "image/jpeg",
          } as never,
        ],
        "/r",
        [],
      );
      const f = out[1] as unknown as {
        source: { path: string; text: { value: string } };
      };
      // Even a misleading token extension pairs — the part is the only
      // candidate for the only unmatched token.
      assert.equal(f.source.text.value, "@shot.png");
      assert.equal(f.source.path, "/r/shot.png");
    });
    it("does not hand one token to two parts", () => {
      const out = resourcedParts(
        [
          { type: "text", text: "one @5.png only" } as never,
          {
            type: "file",
            url: "data:image/png;base64,AAAA",
            mime: "image/png",
            filename: "5.png",
          } as never,
          {
            type: "file",
            url: "data:image/png;base64,BBBB",
            mime: "image/png",
            filename: "5.png",
          } as never,
        ],
        "/r",
        [],
      );
      assert.ok((out[1] as never as { source?: unknown }).source);
      assert.ok(!(out[2] as never as { source?: unknown }).source);
    });
  });
});
