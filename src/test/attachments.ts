import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { savePromptAttachments } from "../attachments";

// Runs inside the extension host (see lifecycle.ts for the harness). Covers
// attachments.ts against the real workspace folder: filtering, sanitizing,
// extension derivation, content fidelity, and the best-effort error path.

const PNG_1PX =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_BYTES = Buffer.from(PNG_1PX.replace(/^data:[^;]+;base64,/, ""), "base64");

suite("opencode attachments", function () {
  const ws = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const sessionId = `oc-test-${process.ppid}-${Date.now()}`;
  const dir = path.join(ws, ".opencode", "attachments", sessionId);

  test("ignores non-array parts and non-data parts", async function () {
    await savePromptAttachments(ws, sessionId, "not-an-array");
    await savePromptAttachments(ws, sessionId, [
      { type: "text", text: "hello" },
      { type: "file", mime: "image/png", url: "https://example.com/x.png" },
      { not: "a file part" },
    ]);
    assert.ok(!fs.existsSync(dir), "nothing written");
  });

  test("writes attachments with sanitized names and derived extensions", async function () {
    const pdfB64 = Buffer.from("%PDF-1.4 fake page\n", "binary").toString("base64");
    const pdfData = `data:application/pdf;base64,${pdfB64}`;
    await savePromptAttachments(ws, sessionId, [
      { type: "file", mime: "image/png", url: PNG_1PX, filename: 'shot:1?.png' },
      { type: "file", mime: "image/png", url: PNG_1PX },
      { type: "file", mime: "image/webp", url: PNG_1PX, filename: "pic" },
      { type: "file", mime: "image/tiff", url: PNG_1PX, filename: "scan.tif" },
      { type: "file", mime: "application/pdf", url: pdfData, filename: "report v1.pdf" },
      { type: "file", mime: "text/plain", url: "data:text/plain;base64,aGVsbG8=", filename: "notes" },
    ]);
    const names = fs
      .readdirSync(dir)
      .map((n) => n.replace(/^\d+-/, ""))
      .sort();
    assert.deepStrictEqual(names, [
      "file.png",
      "notes.txt",
      "pic.webp",
      "report v1.pdf",
      "scan.tif",
      "shot_1_.png",
    ]);
    for (const f of fs.readdirSync(dir)) {
      const expected = f.endsWith(".txt")
        ? Buffer.from("hello")
        : f.endsWith(".pdf")
          ? Buffer.from("%PDF-1.4 fake page\n", "binary")
          : PNG_BYTES;
      assert.deepStrictEqual(
        fs.readFileSync(path.join(dir, f)),
        expected,
        `content fidelity: ${f}`,
      );
    }
  });

  test("a failed write never rejects the send", async function () {
    const blockedRoot = path.join(ws, ".opencode-attachments-blocked-test");
    fs.mkdirSync(blockedRoot, { recursive: true });
    try {
      // A FILE where the .opencode directory would go makes mkdir fail —
      // resolving instead of throwing is the whole contract.
      fs.writeFileSync(path.join(blockedRoot, ".opencode"), "in the way");
      await savePromptAttachments(blockedRoot, sessionId, [
        { type: "file", mime: "image/png", url: PNG_1PX, filename: "x.png" },
      ]);
    } finally {
      fs.rmSync(blockedRoot, { recursive: true, force: true });
    }
  });

  suiteTeardown(function () {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(path.join(ws, ".opencode-attachments-blocked-test"), {
      recursive: true,
      force: true,
    });
  });
});
