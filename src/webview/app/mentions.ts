// @-mentions, the official app's text dialect. Typing "@" (line start or
// after whitespace) opens a file finder; selection inserts plain "@path"
// text — the textarea keeps plain text (drafts, history sweep and edits all
// stay string-shaped; the composer renders chips from a mirror layer over
// it), and parsing happens once, at send, on the final immutable text:
// every mention token becomes a structured part (file/agent) whose source
// range points back into it, and the text itself stays inline so the model
// sees the mention where the user wrote it.
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
  // Any sourced file part is a mention — file:// as sent, or a data: url
  // the server inlined (resourcedParts re-attaches its source).
  const isMention = (p: Part): p is FilePart => {
    const f = p as FilePart;
    return f.type === "file" && !!f.source;
  };
  const pills = parts
    .map((p, idx) => ({ p: p as FilePart, idx }))
    .filter(({ p }) => isMention(p))
    .map(({ p, idx }) => {
      const q = /[?&]start=(\d+)(?:&end=(\d+))?/.exec(p.url!);
      return {
        path: p.source!.path,
        ...p.source!.text,
        line: q?.[1],
        endLine: q?.[2],
        // openFile on a directory fails host-side — the pill flags it so the
        // click delegation can hand it to openExternal instead.
        dir: p.mime === "application/x-directory",
        // An inlined image the server stripped the source from: the pill
        // carries its part index so clicks/hovers can reach the bytes for
        // the lightbox and the hover preview (no file:// to open).
        imgIdx: p.url?.startsWith("data:image/") ? idx : undefined,
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
          (d.imgIdx !== undefined ? ` data-img-idx="${d.imgIdx}"` : "") +
          (d.dir ? ` data-dir="1"` : "") +
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
// session's directory. Shared by the parser and the composer's chip
// verification, which compares finder rows against resolved token paths.
export function resolve(base: string, rel: string): string {
  if (/^([A-Za-z]:[\\/]|\\\\|\/\/|\/)/.test(rel)) return rel.replace(/\\/g, "/");
  return `${base.replace(/[\\/]+$/, "")}/${rel.replace(/\\/g, "/")}`;
}

// Mention tokens: "@" after start/whitespace/opening punctuation (the app's
// comment-mention parser — the only text-level regex its submit path runs).
const TOKEN = /(^|[\s([{"'])@(\S+)/g;
// Punctuation that reads as sentence structure, not path.
const TRAILING = /[.,!?;:)}\]"']+$/;

// One mention lifted out of the text. The composer's live chip layer and
// the send-time parser share this scan, so the chip being typed and the
// part it becomes at send can never disagree.
export interface MentionToken {
  // "@token" exactly as it sits in the text (TRAILING punctuation stripped).
  value: string;
  start: number; // index of the "@"
  end: number;
  kind: "file" | "dir" | "agent";
  // Agent tokens name the agent; file/dir tokens carry the range-stripped
  // path as typed, its resolved absolute form, and its file:// url.
  name?: string;
  rel?: string;
  path?: string;
  url?: string;
  range?: string;
  line?: string;
  endLine?: string;
}

// Scan `text` into mention tokens: agent tokens name a mentionable agent,
// path-shaped tokens become file/dir tokens (with optional #line /
// #start-end range, the TUI's syntax — the server turns it into a ranged
// Read). File tokens dedupe by url; directories (trailing "/") list
// instead of read.
export function mentionTokens(
  text: string,
  base: string,
  agentNames: string[],
): MentionToken[] {
  const out: MentionToken[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(TOKEN)) {
    const token = m[2].replace(TRAILING, "");
    if (!token) continue;
    const start = m.index + m[1].length;
    const end = start + token.length + 1;
    if (agentNames.includes(token)) {
      out.push({
        value: text.slice(start, end),
        start,
        end,
        kind: "agent",
        name: token,
      });
      continue;
    }
    // Bare words are mention-style prose — "@here", "@channel" — not paths;
    // only path-shaped tokens (separator, extension, #range, ~) attach files.
    if (!/[/.#~\\]/.test(token)) continue;
    let path = token;
    let range = "";
    let line: string | undefined;
    let endLine: string | undefined;
    const lr = /^(.*)#(\d+)(?:-(\d+))?$/.exec(token);
    if (lr) {
      path = lr[1];
      line = lr[2];
      endLine = lr[3];
      range = lr[3] ? `?start=${lr[2]}&end=${lr[3]}` : `?start=${lr[2]}`;
    }
    const abs = resolve(base, path);
    const url = `file://${fileUrl(abs)}${range}`;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({
      value: text.slice(start, end),
      start,
      end,
      kind: /[\\/]$/.test(path) ? "dir" : "file",
      rel: path,
      path: abs,
      url,
      range,
      line,
      endLine,
    });
  }
  return out;
}

// The server inlines image mentions as data: parts, dropping both the
// source range and the filename that pillifies them — re-derive it at
// render. Pass 1 pairs a part's filename with a token of the same
// basename; pass 2 zips the filename-less parts (server-inlined mentions —
// real pastes keep their filenames) with the still-unmatched tokens in
// order. Parts that already carry a source claim their token first.
export function resourcedParts(
  parts: Part[],
  base: string,
  agentNames: string[],
): Part[] {
  const toks = tokensByTextPart(parts, base, agentNames);
  if (toks.length === 0) return parts;
  const claimed = new Set(
    parts
      .filter(
        (p) =>
          (p as FilePart).type === "file" && (p as FilePart).source,
      )
      .map((p) => (p as FilePart).source!.text.value),
  );
  const free = (t: (typeof toks)[number]) => !claimed.has(t.value);
  const attach = (
    f: FilePart,
    t: (typeof toks)[number],
  ): Part => {
    claimed.add(t.value);
    return {
      ...f,
      source: {
        type: "file" as const,
        path: t.path!,
        text: { value: t.value, start: t.start, end: t.end },
      },
    };
  };
  const basename = (s: string) => s.split(/[\\/]/).pop()!.toLowerCase();
  let changed = false;
  let out = parts.map((p) => {
    const f = p as FilePart;
    if (f.type !== "file" || f.source || !f.filename) return p;
    const t = toks.find(
      (tok) => free(tok) && basename(tok.rel!) === basename(f.filename!),
    );
    if (!t) return p;
    changed = true;
    return attach(f, t);
  });
  // Pass 2: filename-less sourceless parts (the server-inlined mentions)
  // pair with unmatched tokens in order.
  const anon = out.filter(
    (p): p is FilePart =>
      (p as FilePart).type === "file" &&
      !(p as FilePart).source &&
      !(p as FilePart).filename,
  );
  if (anon.length > 0) {
    out = out.map((p) => {
      const f = p as FilePart;
      if (f.type !== "file" || f.source || f.filename) return p;
      const idx = anon.indexOf(f);
      const t = toks.filter(free)[idx];
      if (!t) return p;
      changed = true;
      return attach(f, t);
    });
  }
  return changed ? out : parts;
}

// Mention tokens per text part, carrying the part index — pillifyOwnText
// slices ranges against each part's own text, so re-derived sources must
// be part-local too.
function tokensByTextPart(
  parts: Part[],
  base: string,
  agentNames: string[],
): (MentionToken & { partIndex: number })[] {
  const toks: (MentionToken & { partIndex: number })[] = [];
  parts.forEach((p, i) => {
    if (!isText(p) || p.synthetic || !p.text) return;
    for (const t of mentionTokens(p.text, base, agentNames)) {
      if (t.kind !== "agent") toks.push({ ...t, partIndex: i });
    }
  });
  return toks;
}

// Lift every mention in `text` into structured parts — the token scan with
// the part shapes the prompt endpoint speaks. File parts dedupe by url;
// directories (trailing "/") list instead of read.
export function parseMentions(
  text: string,
  base: string,
  agentNames: string[],
): PromptPart[] {
  return mentionTokens(text, base, agentNames).map((t) =>
    t.kind === "agent"
      ? {
          type: "agent",
          name: t.name!,
          source: { value: t.value, start: t.start, end: t.end },
        }
      : {
          type: "file",
          mime:
            t.kind === "dir" ? "application/x-directory" : "text/plain",
          url: t.url!,
          source: {
            type: "file",
            path: t.path!,
            text: { value: t.value, start: t.start, end: t.end },
          },
        },
  );
}
