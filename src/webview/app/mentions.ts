// @-mentions, the official app's text dialect. Typing "@" (line start or
// after whitespace) opens a file finder; selection inserts plain "@path"
// text — the textarea keeps plain text (drafts, history sweep and edits all
// stay string-shaped), and parsing happens once, at send, on the final
// immutable text: every mention token becomes a structured part (file/agent)
// whose source range points back into it, and the text itself stays inline
// so the model sees the mention where the user wrote it.
import { isText, type FilePart, type Part, type PromptPart } from "./api";

// The live token before the caret: "@" preceded by start/whitespace, query
// of non-space non-@ chars (the app's PromptInputV2 machine trigger).
export function atTrigger(value: string, caret: number): string | undefined {
  const m = /(?:^|\s)@([^\s@]*)$/.exec(value.slice(0, caret));
  return m ? m[1] : undefined;
}

// HTML/markdown escaping for pill markup injected into user text (which
// still runs through marked): markdown metacharacters backslash-escaped so
// snake_case names survive emphasis, then entities for the raw-HTML span.
const escMd = (s: string) =>
  s
    .replace(/[\\`_*[\]]/g, "\\$&")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// The display form of a user message's own text (ownText's counterpart):
// mention tokens lift into .file-ref spans — the Markdown click delegation
// already opens those via data-path — while the stored text keeps the
// "@path" inline for the model. Each range indexes the text part it was
// parsed from, so substitution runs per part, ends first, and only where
// the slice still matches the token.
export function pillifyOwnText(parts: Part[]): string {
  const isMention = (p: Part): p is FilePart => {
    const f = p as FilePart;
    return f.type === "file" && !!f.url?.startsWith("file://") && !!f.source;
  };
  const pills = parts.filter(isMention).map((p) => {
    const q = /[?&]start=(\d+)(?:&end=(\d+))?/.exec(p.url!);
    return {
      path: p.source!.path,
      ...p.source!.text,
      line: q?.[1],
      endLine: q?.[2],
    };
  });
  return parts
    .filter(isText)
    .filter((p) => !p.synthetic)
    .map((p) => {
      let text = p.text ?? "";
      if (!text) return text;
      const hits = pills
        .filter((d) => text.slice(d.start, d.end) === d.value)
        .sort((a, b) => b.start - a.start);
      for (const d of hits) {
        const attrs =
          ` class="file-ref mention-pill" data-path="${escMd(d.path)}"` +
          (d.line ? ` data-line="${d.line}"` : "") +
          (d.endLine ? ` data-endLine="${d.endLine}"` : "");
        text =
          text.slice(0, d.start) +
          `<span${attrs}>${escMd(d.value)}</span>` +
          text.slice(d.end);
      }
      return text;
    })
    .join("\n");
}

// Windows-aware file:// url, ported from the official app's encodeFilePath:
// backslashes fold to "/", a drive letter gains its leading slash, segments
// percent-encode (the drive colon stays bare so file URL parsers see the
// drive).
function fileUrl(abs: string): string {
  let p = abs.replace(/\\/g, "/");
  if (/^[A-Za-z]:/.test(p)) p = `/${p}`;
  return p
    .split("/")
    .map((seg, i) =>
      i === 1 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg),
    )
    .join("/");
}

// Join a finder result (relative) or a typed path (may be absolute) onto the
// session's directory.
function resolve(base: string, rel: string): string {
  if (/^([A-Za-z]:[\\/]|\\\\|\/\/|\/)/.test(rel)) return rel.replace(/\\/g, "/");
  return `${base.replace(/[\\/]+$/, "")}/${rel.replace(/\\/g, "/")}`;
}

// Mention tokens: "@" after start/whitespace/opening punctuation (the app's
// comment-mention parser — the only text-level regex its submit path runs).
const TOKEN = /(^|[\s([{"'])@(\S+)/g;
// Punctuation that reads as sentence structure, not path.
const TRAILING = /[.,!?;:)}\]"']+$/;

// Lift every mention in `text` into structured parts. `agentNames` are the
// mentionable agents (non-primary); a token exactly naming one is an agent
// mention, anything else a file path (with optional #line / #start-end
// range, the TUI's syntax — the server turns it into a ranged Read).
// File parts dedupe by url; directories (trailing "/") list instead of read.
export function parseMentions(
  text: string,
  base: string,
  agentNames: string[],
): PromptPart[] {
  const parts: PromptPart[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(TOKEN)) {
    const token = m[2].replace(TRAILING, "");
    if (!token) continue;
    const start = m.index + m[1].length;
    const end = start + token.length + 1;
    if (agentNames.includes(token)) {
      parts.push({
        type: "agent",
        name: token,
        source: { value: text.slice(start, end), start, end },
      });
      continue;
    }
    // Bare words are mention-style prose — "@here", "@channel" — not paths;
    // only path-shaped tokens (separator, extension, #range, ~) attach files.
    if (!/[/.#~\\]/.test(token)) continue;
    let path = token;
    let range = "";
    const lr = /^(.*)#(\d+)(?:-(\d+))?$/.exec(token);
    if (lr) {
      path = lr[1];
      range = lr[3] ? `?start=${lr[2]}&end=${lr[3]}` : `?start=${lr[2]}`;
    }
    const abs = resolve(base, path);
    const url = `file://${fileUrl(abs)}${range}`;
    if (seen.has(url)) continue;
    seen.add(url);
    parts.push({
      type: "file",
      mime: /[\\/]$/.test(path) ? "application/x-directory" : "text/plain",
      url,
      source: {
        type: "file",
        path: abs,
        text: { value: text.slice(start, end), start, end },
      },
    });
  }
  return parts;
}
