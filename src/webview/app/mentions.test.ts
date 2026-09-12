import "./setup.test";
import { strict as assert } from "node:assert";
import { atTrigger, parseMentions } from "./mentions";

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
  });
});
