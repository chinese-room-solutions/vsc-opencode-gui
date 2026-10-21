import "./setup.test";
import { strict as assert } from "node:assert";
import { parseFileRef, renderMarkdown } from "./markdown";

describe("markdown", () => {
  describe("parseFileRef", () => {
    it("parses path, line, and line ranges", () => {
      assert.deepEqual(parseFileRef("client.go:322"), {
        path: "client.go",
        line: "322",
        endLine: undefined,
      });
      assert.deepEqual(parseFileRef("src/a.go:10-20"), {
        path: "src/a.go",
        line: "10",
        endLine: "20",
      });
      assert.deepEqual(parseFileRef("src/a.go:10:20"), {
        path: "src/a.go",
        line: "10",
        endLine: "20",
      });
    });
    it("requires a separator or a line for a bare filename", () => {
      assert.deepEqual(parseFileRef("docs/notes.md"), {
        path: "docs/notes.md",
        line: undefined,
        endLine: undefined,
      });
      assert.equal(parseFileRef("notes.md"), undefined);
      assert.equal(parseFileRef("hello"), undefined);
      assert.equal(parseFileRef("hello world"), undefined);
    });
    it("accepts @-prefixed and dotted paths", () => {
      assert.deepEqual(parseFileRef("@scope/pkg.file.ts:5"), {
        path: "@scope/pkg.file.ts",
        line: "5",
        endLine: undefined,
      });
    });
    it("trims surrounding whitespace", () => {
      assert.deepEqual(parseFileRef(" a.go:1 "), {
        path: "a.go",
        line: "1",
        endLine: undefined,
      });
    });
  });

  describe("renderMarkdown ordered lists", () => {
    it("keeps typed item numbers instead of renumbering", () => {
      const html = renderMarkdown("5. It's 5\n7. This becomes 6");
      assert.ok(html.includes('<li value="5">'));
      assert.ok(html.includes('<li value="7">'));
    });
    it("numbers sequentially when every marker is identical", () => {
      const html = renderMarkdown("1. a\n1. b");
      assert.ok(!html.includes("value="));
      assert.ok(html.includes("<ol>"));
    });
    it("keeps a nested single item's number via ol start", () => {
      const html = renderMarkdown("5. a\n   7. nested\n6. b");
      assert.ok(html.includes('<li value="5">'));
      assert.ok(html.includes('<ol start="7">'));
      assert.ok(html.includes('<li value="6">'));
    });
    it("pins nested lists whose markers differ", () => {
      const html = renderMarkdown("1. a\n   3. x\n   9. y\n2. b");
      assert.ok(html.includes('<li value="3">'));
      assert.ok(html.includes('<li value="9">'));
    });
    it("leaves unordered lists and task items intact", () => {
      assert.ok(renderMarkdown("- a\n- b").includes("<ul>"));
      const task = renderMarkdown("1. [ ] a\n2. [x] b");
      assert.ok(task.includes('<li value="1">'));
      assert.ok(task.includes("<input"));
      assert.ok(task.includes('type="checkbox"'));
    });
  });
});
