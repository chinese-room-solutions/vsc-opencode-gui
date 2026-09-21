// @-mentions, the official app's text dialect. Typing "@" (line start or
// after whitespace) opens a file finder; selection inserts plain "@path"
// text — the textarea keeps plain text (drafts, history sweep and edits all
// stay string-shaped), and parsing happens once, at send, on the final
// immutable text: every mention token becomes a structured part (file/agent)
// whose source range points back into it, and the text itself stays inline
// so the model sees the mention where the user wrote it.
import type { PromptPart } from "./api";

// The live token before the caret: "@" preceded by start/whitespace, query
// of non-space non-@ chars (the app's PromptInputV2 machine trigger).
export function atTrigger(value: string, caret: number): string | undefined {
  const m = /(?:^|\s)@([^\s@]*)$/.exec(value.slice(0, caret));
  return m ? m[1] : undefined;
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
