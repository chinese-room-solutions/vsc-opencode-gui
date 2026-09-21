import * as fs from "fs";
import * as path from "path";
import { log } from "./log";

// Chat attachments reach the agent only as inline data-URIs inside the
// prompt — the model sees the content but has no file to reuse (a note or
// doc can't reference it). The host snapshots every data part of a prompt
// to disk before relaying it, giving turns a stable path to work from;
// the attachments skill documents the convention. The composer gates what
// can attach (attachMime: images, pdf, audio/video, text files).
const EXT_OF_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/flac": "flac",
  "audio/aac": "aac",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/x-matroska": "mkv",
};

// Write one data-URI attachment to
// <workspace>/.opencode/attachments/<sessionId>/<ts>-<name> and return its
// absolute path. Best effort: errors are logged and returned as undefined —
// a failed side-save must never fail the attach or the send.
export async function saveAttachment(
  workspaceDir: string,
  sessionId: string,
  dataUri: string,
  filename: string,
  mime: string,
): Promise<string | undefined> {
  const m = /^data:[^;]+;base64,(.*)$/s.exec(dataUri);
  if (!m) return undefined;
  try {
    const dir = path.join(workspaceDir, ".opencode", "attachments", sessionId);
    const base = path.basename(filename || "file");
    const safe = base.replace(/[\\/:*?"<>|]/g, "_");
    const rawExt = path.extname(safe);
    const ext = rawExt || `.${EXT_OF_MIME[mime] ?? "bin"}`;
    const stem = rawExt ? safe.slice(0, -rawExt.length) : safe;
    const file = path.join(dir, `${Date.now()}-${stem}${ext}`);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(file, Buffer.from(m[1], "base64"));
    return file;
  } catch (err) {
    log.error("attachment snapshot failed:", err);
    return undefined;
  }
}

// Write one prompt's data parts (pasted attachments; + picks already carry
// their on-disk path). See saveAttachment for the layout and the best-effort
// contract.
export async function savePromptAttachments(
  workspaceDir: string,
  sessionId: string,
  parts: unknown,
): Promise<void> {
  if (!Array.isArray(parts)) return;
  for (const part of parts) {
    const p = part as { type?: string; mime?: string; url?: string; filename?: string };
    if (p?.type !== "file" || typeof p.url !== "string") {
      continue;
    }
    await saveAttachment(
      workspaceDir,
      sessionId,
      p.url,
      p.filename || "file",
      p.mime ?? "",
    );
  }
}
