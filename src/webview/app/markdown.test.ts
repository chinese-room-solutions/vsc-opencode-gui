import "./setup.test";
import { strict as assert } from "node:assert";
import { parseFileRef } from "./markdown";

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
});
