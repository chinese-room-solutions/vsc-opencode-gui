import * as fs from "fs";
import * as path from "path";
import { log } from "./log";

// Chat attachments reach the agent only as inline data-URIs inside the
// prompt — the model sees the content but has no file to reuse (a note or
// doc can't reference it). The host snapshots every data part of a prompt
// to disk before relaying it, giving turns a stable path to work from;
// the attachments skill documents the convention. The composer gates what
// can attach (attachMime: images, pdf, text files).
const EXT_OF_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "text/plain": "txt",
};

// Write one prompt's attachments to
// <workspace>/.opencode/attachments/<sessionId>/<ts>-<name>. Best effort
// by design: a failed side-save must never fail the send, so every error
// is logged and skipped. Data-URIs only (a file:// url is a mention of a
// file already on disk) — the composer's caps (10 MB, attachMime) bound
// the work.
export async function savePromptAttachments(
  workspaceDir: string,
  sessionId: string,
  parts: unknown,
): Promise<void> {
  if (!Array.isArray(parts)) return;
  const dir = path.join(workspaceDir, ".opencode", "attachments", sessionId);
  for (const part of parts) {
    const p = part as { type?: string; mime?: string; url?: string; filename?: string };
    if (p?.type !== "file" || typeof p.url !== "string") {
      continue;
    }
    const m = /^data:[^;]+;base64,(.*)$/s.exec(p.url);
    if (!m) continue;
    try {
      const base = path.basename(p.filename || "file");
      const safe = base.replace(/[\\/:*?"<>|]/g, "_");
      const rawExt = path.extname(safe);
      const ext = rawExt || `.${EXT_OF_MIME[p.mime ?? ""] ?? "bin"}`;
      const stem = rawExt ? safe.slice(0, -rawExt.length) : safe;
      const file = path.join(dir, `${Date.now()}-${stem}${ext}`);
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(file, Buffer.from(m[1], "base64"));
    } catch (err) {
      log.error("attachment snapshot failed:", err);
    }
  }
}
