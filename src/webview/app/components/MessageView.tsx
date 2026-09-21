import { Component } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import type { ChatMessage } from "../store";
import {
  charsPerToken,
  fmtDur,
  insertComposerText,
  modelLabel,
  peerNames,
  resolveFileRef,
  revertSession,
  sessionStatus,
} from "../store";
import { extOf, isText, isTool, tokensTotal, type FilePart, type Part, type TextPart, type ToolPart } from "../api";
import { pillifyOwnText } from "../mentions";
import { enhanceBlockquotes, enhanceCodeBlocks, enhanceInlineCode, renderMarkdown, tagFileRefs } from "../markdown";
import { openFile } from "../host";
import {
  CheckIcon,
  ChevronIcon,
  CopyIcon,
  OcCheckIcon,
  OcCopyIcon,
  OcResetIcon,
} from "../icons";
import { ToolCard } from "./ToolCard";
import { openLightbox } from "./Lightbox";
import { silenceLabel } from "../stuck";

// Compact units for the live counters: 95s → "1m35s", 12340 → "12.3k".
// Sub-1000 values pass through unrounded, so rates keep their decimal.
function fmtTok(n: number): string {
  return n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`;
}

// Rates round to a tenth — the division's raw float prints long.
function fmtRate(n: number): string {
  return fmtTok(Math.round(n * 10) / 10);
}

// Store messages are copy-on-write: an untouched message keeps its object
// identity across updates. Turn components memoized on that identity skip
// re-rendering during a stream — only the message a frame actually touched
// redraws, instead of the whole transcript per frame. preact 10.29 ships
// memo only in compat, so a minimal class does the same job.
function memo<P>(
  render: (props: P) => ComponentChildren,
  same: (a: P, b: P) => boolean,
) {
  return class Memoed extends Component<P> {
    shouldComponentUpdate(nextProps: Readonly<P>) {
      return !same(this.props, nextProps);
    }
    render() {
      return render(this.props);
    }
  };
}

const sameMsgs = (a: ChatMessage[], b: ChatMessage[]): boolean =>
  a === b || (a.length === b.length && a.every((m, i) => m === b[i]));

// The live counter beside a status line: " · 1.6m · 24.6k · 259.3 tok/s",
// ticking each second like the turn footer's trio. The clock is sampled,
// not read per render — store deltas re-render parents many times a
// second, and a per-render Date.now() flipped the second at unaligned
// phases. Zero tokens render time only — before the first token there is
// nothing to count.
export function StatusStats(props: { start?: number; gen: number }) {
  const [now, setNow] = useState<number>();
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const iv = window.setInterval(tick, 1000);
    return () => window.clearInterval(iv);
  }, []);
  const secs =
    props.start && now !== undefined
      ? Math.max(1, Math.round((now - props.start) / 1000))
      : undefined;
  const bits = [
    secs !== undefined ? fmtDur(secs) : "",
    props.gen > 0 ? fmtTok(props.gen) : "",
    props.gen > 0 && secs ? `${fmtRate(props.gen / secs)} tok/s` : "",
  ].filter(Boolean);
  if (bits.length === 0) return null;
  return (
    <span class="status-stats"> · {bits.join(" · ")}</span>
  );
}

// Streaming render limits: re-parsing the FULL accumulated text per delta
// is O(n²) (marked + DOMPurify + hljs) and killed the renderer on long
// turns. While the owning part streams, re-parse at most once per 250 ms
// (trailing edge, so the final text always lands); past 128 KB skip the
// markdown pipeline entirely — one escaped text node until the part
// settles, then the normal full render happens once.
const STREAM_PARSE_MS = 250;
const STREAM_RAW_LIMIT = 131_072;

// Rendered markdown: sanitize first, then tag file-ref code spans/links so
// one delegated click handler can open them host-side.
function Markdown(props: {
  text: string;
  class?: string;
  // False while the message streams: code blocks keep the highlight.js
  // paint (stable across deltas) and get the host tokenize when the flag
  // flips — which re-runs this effect.
  tokenize?: boolean;
  // True while the owning part is receiving deltas.
  streaming?: boolean;
  // Lets a parent measure the rendered box (user-text clamp).
  innerRef?: (el: HTMLDivElement | null) => void;
}) {
  const streaming = props.streaming === true;
  const raw = streaming && props.text.length > STREAM_RAW_LIMIT;
  const [deferred, setDeferred] = useState(props.text);
  const painted = useRef(0);
  useEffect(() => {
    if (!streaming) {
      // Settled: the final text lands immediately (the trailing parse).
      setDeferred(props.text);
      return;
    }
    if (raw) return;
    const wait = Math.max(0, STREAM_PARSE_MS - (Date.now() - painted.current));
    const timer = window.setTimeout(() => {
      painted.current = Date.now();
      setDeferred(props.text);
    }, wait);
    return () => window.clearTimeout(timer);
  }, [props.text, streaming, raw]);
  const html = useMemo(
    () => (raw ? "" : renderMarkdown(deferred)),
    [raw, deferred],
  );
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && !raw) {
      tagFileRefs(el);
      enhanceCodeBlocks(el, props.tokenize ?? true);
      enhanceBlockquotes(el);
      enhanceInlineCode(el);
    }
  }, [html, props.tokenize, raw]);
  const setEl = (el: HTMLDivElement | null) => {
    ref.current = el;
    props.innerRef?.(el);
  };
  if (raw) {
    return (
      <div ref={setEl} class={props.class}>
        <div class="stream-note">Large output — plain text while streaming</div>
        <div class="stream-raw">{props.text}</div>
      </div>
    );
  }
  return (
    <div
      ref={setEl}
      class={props.class}
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        const t = (e.target as HTMLElement).closest<HTMLElement>(".file-ref");
        if (!t?.dataset.path) return;
        e.preventDefault();
        const target = t.dataset.path;
        const { line, endLine } = t.dataset;
        // resolveFileRef is total — it opens the input itself when nothing
        // matches, so there is no rejection path to handle.
        void resolveFileRef(target).then((p) => openFile(p, line, endLine));
      }}
    />
  );
}

// Message-level status dot, derived from data: red on error, blinking while
// this is the turn in flight, muted once it settles.
function dotState(m: ChatMessage, live: boolean): "error" | "running" | "done" {
  if (m.info.error) return "error";
  if (live) return "running";
  return "done";
}

// Hover row under a user pill (OpenCode's own glyph pair): copy the
// prompt, or revert the session to before it — the server drops the prompt,
// its reply, and everything after. A command line ("cmd:" id) keeps copy
// but never reverts: the server stores no row for it to rewind to.
function UserActions(props: { sid: string; id: string; text: string; revert?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = (e: MouseEvent) => {
    e.stopPropagation();
    void navigator.clipboard.writeText(props.text).catch(() => {});
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };
  const revert = (e: MouseEvent) => {
    e.stopPropagation();
    // A running turn can't be rewound under itself.
    if (sessionStatus.value[props.sid]?.type === "busy") return;
    void revertSession(props.sid, props.id).then((ok) => {
      // The point of taking a message back is editing and resending it.
      if (ok) insertComposerText(props.text, true);
    });
  };
  return (
    <div class="msg-actions">
      <button
        type="button"
        class={copied ? "msg-action done" : "msg-action"}
        title={copied ? "Copied" : "Copy message"}
        aria-label={copied ? "Copied" : "Copy message"}
        onClick={copy}
      >
        {copied ? <OcCheckIcon /> : <OcCopyIcon />}
      </button>
      {props.revert !== false && (
        <button
          type="button"
          class="msg-action"
          title="Revert message"
          aria-label="Revert message"
          onClick={revert}
        >
          <OcResetIcon />
        </button>
      )}
    </div>
  );
}

// Clicking a user pill scrolls its turn to the top — the manual version of
// the released-sticky pin, and the way back up from a pill pinned mid-turn.
// Measure the turn, never the pill: a stuck pill's rect already reads as
// at-top (sticky is visual), while the turn's is its true flow position.
// The pill is the turn's first child with no margin, so turn top == pill
// flow top. A mouse drag ending in selected text is not a jump, and the
// clamp toggle keeps its own click.
function jumpToTurn(e: MouseEvent) {
  const sel = window.getSelection();
  if (
    (sel && sel.toString().length > 0) ||
    (e.target as HTMLElement).closest(".clamp-toggle")
  )
    return;
  const row = e.currentTarget as HTMLElement;
  const scroller = row.closest<HTMLElement>(".msgs");
  const turn = row.closest<HTMLElement>(".turn");
  if (!scroller || !turn) return;
  scroller.scrollTop +=
    turn.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
}

// Long user pills clamp to a line budget until they overflow; then a
// centered "Show more" line appears under the message (`foot` — copy/revert
// — rides its right end on pills, floating alone when there is no line).
// Expanding un-pins the pill; the fold line always stays in flow under the
// text. Replies never fold — the budget and the box live in CSS
// (.user-text clamped + expanded).
function ClampedText(props: {
  text: string;
  base: string;
  // Forwarded to Markdown: false while the message streams (stable
  // highlight.js paint, host tokenize on settle).
  tokenize?: boolean;
  foot?: ComponentChildren;
}) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  // Scroll compensation for the toggle. Collapsing shrinks the box by
  // hundreds of px; the browser re-clamps scrollTop the moment the DOM
  // shrinks — before any effect can measure the damage — so the pre-toggle
  // scrollTop and box height are captured here and the corrected value is
  // ASSIGNED after the re-render: content around the fold stays put.
  // Expanding instead jumps the message's start to the top of the view —
  // the reader asked for the whole text, so show it from the beginning.
  const fold = useRef<{ top: number; box: number; pinStart?: boolean }>();
  // Overflow can appear after the first paint: the host's async tokenize
  // swaps DOM inside the clamped box without touching props.text, and the
  // one-shot measure already ran on the shorter pre-token layout.
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    measure();
    const mo = new MutationObserver(measure);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    return () => mo.disconnect();
  }, []);
  useLayoutEffect(() => {
    const el = boxRef.current;
    const f = fold.current;
    fold.current = undefined;
    if (f && el) {
      const scroller = el.closest(".msgs");
      if (scroller) {
        if (f.pinStart) {
          // The expanded pill is un-pinned (CSS :has), so the row's rect is
          // its true flow position — jump it to the scroller's top edge.
          const row = el.closest(".msg") ?? el;
          scroller.scrollTop +=
            row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
        } else {
          scroller.scrollTop = f.top + (el.getBoundingClientRect().height - f.box);
        }
      }
    }
  }, [props.text, expanded]);
  return (
    <div>
      {/* The pill's chrome lives on this wrapper so the clamp's dissolve can
          be an alpha mask on the content element — a mask would otherwise
          fade the pill's own background and border away with the text. */}
      <div class="user-pill">
        <Markdown
          text={props.text}
          innerRef={(el) => (boxRef.current = el)}
          tokenize={props.tokenize}
          class={
            expanded
              ? `${props.base} expanded`
              : `${props.base} clamped${overflows ? " cut" : ""}`
          }
        />
      </div>
      {(overflows || expanded) && (
        <div class="msg-foot" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            class="clamp-toggle"
            onClick={() => {
              const el = boxRef.current;
              const scroller = el?.closest(".msgs");
              if (el && scroller) {
                fold.current = {
                  top: scroller.scrollTop,
                  box: el.getBoundingClientRect().height,
                  pinStart: !expanded,
                };
              }
              setExpanded(!expanded);
            }}
          >
            {expanded ? "Show less" : "Show more"}
          </button>
          {props.foot}
        </div>
      )}
      {!(overflows || expanded) && props.foot}
    </div>
  );
}

// The user's own words: text parts minus the server's synthetic injections
// (the endpoint's image emulation for non-vision models — a "Called the Read
// tool…" line plus the raw file bytes — ride the stored message but were
// never typed). Copy, revert and the prompt-history sweep read this too.
function ownText(parts: Part[]): string {
  return parts
    .filter(isText)
    .filter((p) => !p.synthetic)
    .map((p) => p.text ?? "")
    .join("\n");
}

// Inbound peer messages (opencode-plugin-peers): synthetic text parts
// tagged metadata.peerMessage. They are another session's words, not this
// user's — ownText drops them, so without this they rendered as an empty
// pill. fromEndpointId names the sending session when the plugin carried
// it; fromSessionTitle (newer plugin) is the human session name.
function peerMessage(parts: Part[]): {
  text: string;
  from?: string;
  title?: string;
} {
  let from: string | undefined;
  let title: string | undefined;
  const text = parts
    .filter(isText)
    .filter((p) => {
      const peer = p.metadata?.peerMessage as
        | { fromEndpointId?: unknown; fromSessionTitle?: unknown }
        | true
        | undefined;
      if (!p.synthetic || !peer) return false;
      if (peer !== true) {
        if (typeof peer.fromEndpointId === "string") from = peer.fromEndpointId;
        if (typeof peer.fromSessionTitle === "string" && peer.fromSessionTitle)
          title = peer.fromSessionTitle;
      }
      return true;
    })
    .map((p) => p.text ?? "")
    .filter(Boolean)
    .join("\n\n");
  return { text, from, title };
}

// Attachment chips above a user pill's text (Claude Code's): images a slim
// thumbnail crop — name and pixel size move to the hover title — other files
// their name; an image click opens the lightbox. Data-URI parts only —
// @-mentions pillify inline via pillifyOwnText instead.
function AttachChip(props: { p: FilePart }) {
  const [dims, setDims] = useState<{ w: number; h: number } | undefined>();
  const f = props.p;
  // "+"-dialog parts carry the picked path; the chip shows the bare name.
  const name = f.filename?.split(/[\\/]/).pop() || "file";
  if (!f.url?.startsWith("data:image/"))
    return (
      <span class="file-chip" title={name}>
        <span class="chip-ext">{extOf(name).toUpperCase()}</span>
        <span class="chip-name">{name}</span>
      </span>
    );
  return (
    <span
      class="file-chip chip-img"
      title={dims ? `${name} · ${dims.w}×${dims.h}` : name}
      onClick={(e) => {
        e.stopPropagation(); // the pill's click-to-jump
        openLightbox({ uri: f.url!, name });
      }}
    >
      <img
        src={f.url}
        alt={name}
        onLoad={(e) =>
          setDims({
            w: e.currentTarget.naturalWidth,
            h: e.currentTarget.naturalHeight,
          })
        }
      />
    </span>
  );
}

// The collapsed reasoning row (Claude Code's "Thought for Ns"): expandable
// from the first reasoning token, "Thinking..." with a running timer while
// the window is open, "Thought for Ns" once it closes. The token counts
// live on the turn footer, not here.
function ThinkingBlock(props: {
  p: TextPart;
  live: boolean;
  closed?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [, setTick] = useState(0);
  useEffect(() => {
    // The open window counts seconds in its head; a tick per second keeps
    // the timer moving without touching the body.
    if (!props.live) return;
    const iv = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(iv);
  }, [props.live]);
  const t = props.p.time;
  // The end stamp alone doesn't close the window: the endpoint ends
  // reasoning segments mid-thought and reopens the part, so settling
  // needs a successor part (tool call, answer text) or the turn going
  // quiet — otherwise the label flashes "Thought" between segments.
  const over = !props.live || (t?.end !== undefined && props.closed === true);
  // While unsettled the clock runs on: an end stamp between segments
  // would freeze a timer that is still telling the truth.
  const secs = t?.start
    ? Math.max(
        1,
        Math.round(
          ((over ? t.end ?? Date.now() : Date.now()) - t.start) / 1000,
        ),
      )
    : undefined;
  // "for Ns" needs a closed reasoning — a stop mid-thought leaves the
  // part without an end stamp, and a duration to Date.now() would claim
  // thinking that never happened.
  const label = over
    ? `Thought${t?.end !== undefined && secs ? ` for ${fmtDur(secs)}` : ""}`
    : ["Thinking...", secs ? fmtDur(secs) : ""].filter(Boolean).join(" · ");
  // The thinking action's own state-dot: it pulses while the reasoning
  // streams and settles with the "Thought" label.
  const running = props.live && !over;
  return (
    <div
      class={`thinking-block${open ? " open" : ""}${running ? " dot-running" : ""}`}
    >
      <button
        type="button"
        class="thinking-head"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span class="phase-dot" aria-hidden="true" />
        <span class="thinking-chevron">
          <ChevronIcon />
        </span>
        {label}
      </button>
      {open && (
        <Markdown
          text={props.p.text ?? ""}
          class="markdown thinking-body"
          tokenize={false}
          streaming={props.live}
        />
      )}
    </div>
  );
}

// The compaction turn (Claude Code's presentation): a collapsed fold whose
// header names the trigger and the context it freed, expanding to the
// summary the server wrote. While the summary is still streaming the fold
// is forced open so the tokens appear as they arrive, and the "Compacting..."
// beacon leads the fold until the session idles.
function CompactedTurnImpl(props: {
  msgs: ChatMessage[];
  live?: boolean;
  freedK?: number;
}) {
  const [userOpen, setUserOpen] = useState<boolean | undefined>(undefined);
  const trigger = props.msgs.find((m) => m.info.role === "user");
  const auto = trigger?.parts.some(
    (p) => (p as { auto?: boolean }).auto === true,
  );
  const streaming = props.live === true;
  // A queued fold (a message sent right after /compact) has the trigger row
  // but no summary answer yet: keep "Compacting..." and hide the freed
  // number — the settled math would print the whole pre-compact context.
  const settled = props.msgs.some((m) => m.info.agent === "compaction");
  // Open while the summary streams (the tokens appear as they arrive),
  // folded once it settles — unless the reader folded or held it themselves.
  const open = userOpen ?? streaming;
  const text = (() => {
    const raw = props.msgs
      .filter((m) => m.info.role === "assistant")
      .flatMap((m) =>
        m.parts
          .filter((p): p is TextPart => isText(p) && p.type === "text")
          .map((p) => p.text ?? ""),
      )
      .filter(Boolean)
      .join("\n\n");
    return raw;
  })();
  return (
    <div class="turn">
      {/* The command line itself — the server stores no text for the
          trigger row; the fold below tells the outcome. Auto-compactions
          are the server's own doing, not a sent message. */}
      {!auto && (
        <div class="msg user">
          <div class="user-pill">
            <div class="markdown msg-text user-text">/compact</div>
          </div>
        </div>
      )}
      <details
        class={open ? "compacted open" : "compacted"}
        open={open}
      >
        <summary
          class={streaming ? "compacted-summary dot-running" : "compacted-summary"}
          onClick={(e) => {
            // Foldable from the first token, like the thinking row. The
            // default toggle is cancelled so the DOM open state never
            // diverges from ours (a programmatic flip would fire toggle
            // and latch the fold).
            e.preventDefault();
            setUserOpen(!(userOpen ?? streaming));
          }}
        >
          {/* The thinking row's anatomy: message-grid dot (pulsing while
              the summary streams), chevron, label — Thinking...→Thought. */}
          <span class="dot" aria-hidden="true" />
          <span class="compacted-chevron">
            <ChevronIcon />
          </span>
          <span>
            {streaming || !settled
              ? "Compacting..."
              : `Compacted · ${auto ? "auto" : "manual"}${
                  props.freedK ? ` · ${props.freedK}k tokens freed` : ""
                }`}
          </span>
        </summary>
        {text && (
          <Markdown
            text={text}
            class="markdown compacted-body"
            tokenize={!streaming}
            streaming={streaming}
          />
        )}
      </details>
    </div>
  );
}

// The original app's "Explored" fold: consecutive read-only calls (reads,
// searches, listings) collapse into one counted row that expands to the
// individual cards. Only SETTLED tools fold — a running read keeps its own
// row and its pulsing dot (the turn's pulse) until it completes.
const EXPLORE_TOOLS = new Set(["read", "glob", "grep", "list", "ls"]);

function ExploreGroup(props: { parts: ToolPart[] }) {
  const [open, setOpen] = useState(false);
  const reads = props.parts.filter((p) => p.tool === "read").length;
  const searches = props.parts.length - reads;
  const label = [
    reads ? `${reads} ${reads === 1 ? "read" : "reads"}` : "",
    searches ? `${searches} ${searches === 1 ? "search" : "searches"}` : "",
  ]
    .filter(Boolean)
    .join(", ");
  const failed = props.parts.some(
    (p) =>
      p.state?.status === "error" ||
      (!!p.state?.error && p.state.error !== ""),
  );
  // The fold's own hover timer: the span the whole run took, first start
  // to last end — reads overlap in parallel calls, a sum would not.
  const starts = props.parts
    .map((p) => p.state?.time?.start)
    .filter((t): t is number => typeof t === "number");
  const ends = props.parts
    .map((p) => p.state?.time?.end)
    .filter((t): t is number => typeof t === "number");
  const elapsed =
    starts.length > 0 && ends.length === props.parts.length
      ? silenceLabel(Math.max(...ends) - Math.min(...starts))
      : undefined;
  return (
    <div class="explore">
      <div
        class="tool-row expander explore-head"
        data-tip={elapsed}
        onClick={() => setOpen(!open)}
      >
        <span
          class={`tool-dot ${failed ? "failed" : "completed"}`}
          aria-hidden="true"
        />
        <span class="tool-name">Explored</span>
        <span class="explore-count">{label}</span>
        <span class={open ? "explore-chevron open" : "explore-chevron"}>
          <ChevronIcon />
        </span>
      </div>
      {open && (
        <div class="explore-body">
          {props.parts.map((p) => (
            <ToolCard key={p.id} part={p} />
          ))}
        </div>
      )}
    </div>
  );
}

// One assistant part rendered on its own — the fold applies only to runs.
function PartRow(props: { part: Part; live: boolean; closed?: boolean }) {
  const p = props.part;
  if (isTool(p)) return <ToolCard part={p} live={props.live} />;
  if (!isText(p) || !p.text) return null;
  if (p.type === "reasoning")
    return <ThinkingBlock p={p} live={props.live} closed={props.closed} />;
  return (
    <Markdown
      text={p.text ?? ""}
      class="markdown msg-text assistant-text"
      tokenize={!props.live}
      streaming={props.live}
    />
  );
}

export const CompactedTurn = memo(
  CompactedTurnImpl,
  (a, b) =>
    sameMsgs(a.msgs, b.msgs) && a.live === b.live && a.freedK === b.freedK,
);

function MessageViewImpl(props: { m: ChatMessage; live?: boolean }) {
  const { info, parts } = props.m;
  if (info.role === "user") {
    // The optimistic echo carries a "pending:" id — no server row yet, so
    // nothing to revert; the real row replaces it within a beat. A "cmd:"
    // id is a command line's durable local echo — same no-revert rule.
    const sid = parts[0]?.sessionID;
    const pending = info.id.startsWith("pending:");
    const command = info.id.startsWith("cmd:");
    const files = parts.filter(
      (p): p is FilePart =>
        p.type === "file" &&
        !!(p as { url?: string }).url?.startsWith("data:"),
    );
    const peer = peerMessage(parts);
    if (peer.text) {
      // A peer injection is its own row (the plugin prompts it standalone),
      // so the whole pill becomes the peer card. No UserActions: revert and
      // the prompt-history sweep are the user's own words' semantics. The
      // header names the sender via the live registry (renames land), with
      // the metadata's own fields as the fallback when the peer is gone.
      const known = peer.from ? peerNames.value[peer.from] : undefined;
      const head = known
        ? known.title
          ? `Peer · ${known.name} · "${known.title}"`
          : `Peer · ${known.name}`
        : peer.title || peer.from
          ? `Peer · ${peer.title ?? peer.from}`
          : "Peer message";
      return (
        <div class="msg user peer" onClick={jumpToTurn}>
          <div class="peer-head">{head}</div>
          <ClampedText
            text={peer.text}
            base="markdown msg-text user-text"
          />
        </div>
      );
    }
    return (
      <div class="msg user" onClick={jumpToTurn}>
        {files.length > 0 && (
          <div class="msg-files">
            {files.map((p) => (
              <AttachChip key={p.id} p={p} />
            ))}
          </div>
        )}
        <ClampedText
          text={pillifyOwnText(parts)}
          base="markdown msg-text user-text"
          foot={
            !pending &&
            sid && (
              <UserActions
                sid={sid}
                id={info.id}
                text={ownText(parts)}
                revert={!command}
              />
            )
          }
        />
      </div>
    );
  }
  const live = props.live ?? false;
  // The abort announcement ("Aborted") never renders as a row error: a
  // stopped turn's story is told by its failed tool card and the stop
  // marker — a third red line would only repeat them.
  const error =
    info.error?.data?.message === "Aborted"
      ? undefined
      : info.error?.data?.message;
  const hasText = parts.some((p) => isText(p) && p.type === "text" && p.text);
  const hasReasoning = parts.some(
    (p) => isText(p) && p.type === "reasoning" && p.text,
  );
  // A running tool row pulses in its own row; the message dot keeps
  // beating beside the content — it is the thread that says the turn is
  // still going (a vanish reads as "the agent stopped").
  const toolBusy = parts.some(
    (p) =>
      isTool(p) &&
      (p.state?.status === "running" || p.state?.status === "pending"),
  );
  // The reasoning block covers actual thinking with its "Thinking..."
  // head; the phase line below is the pre-token wait (step started, no
  // tokens yet). It vanishes once content lands: the wait is
  // time-to-first-token — queue, network, prefill in unknown shares —
  // and a settled "processed" line would name a share nobody measured.
  const showPhase = live && !hasText && !hasReasoning && !toolBusy;
  // A message that opens with a tool row shows its state dot in that row;
  // the message-level dot would sit exactly on top of it. Reasoning or
  // text first moves the tool row down — the dot keeps its gutter spot.
  const opensWithTool = parts.length > 0 && isTool(parts[0]);
  // A dead step the endpoint failed without content (a bare {name} error, no
  // parts, no tokens) would render as a lone dot floating over the turn
  // footer — the dot marks content, so it only renders when there is some.
  const showsDot = !opensWithTool && (parts.length > 0 || error || live);
  // Fold runs of settled read-only tools into "Explored" rows; everything
  // else renders part by part. Runs never cross messages — each assistant
  // message folds its own.
  const content: { key: string; el: ToolPart[] | Part }[] = [];
  for (let i = 0; i < parts.length; ) {
    const p = parts[i];
    let run = 0;
    if (isTool(p)) {
      for (;;) {
        if (i + run >= parts.length) break;
        const q = parts[i + run];
        if (!isTool(q) || !EXPLORE_TOOLS.has(q.tool)) break;
        const st = q.state?.status;
        if (st === "pending" || st === "running") break;
        run++;
      }
    }
    if (run >= 2) {
      content.push({ key: p.id, el: parts.slice(i, i + run) as ToolPart[] });
      i += run;
    } else {
      content.push({ key: p.id, el: p });
      i += 1;
    }
  }
  // A reasoning part is proven closed only by a successor part (a tool
  // call, answer text) landing after it — the reasoning block's settle
  // signal, since its end stamp also fires between thinking segments.
  const closed = new Set(
    parts.flatMap((p, i) =>
      isText(p) && p.type === "reasoning" &&
      parts.slice(i + 1).some((q) => isTool(q) || (isText(q) && q.text))
        ? [p.id]
        : [],
    ),
  );
  return (
    <div class={`msg assistant dot-${dotState(props.m, live)}`}>
      {showsDot && !showPhase && !hasReasoning && (
        <span class="dot" aria-hidden="true" />
      )}
      {showPhase && (
        <div class="status-line dot-running">
          <span class="phase-dot" aria-hidden="true" />
          <div class="thinking-line">
            Waiting for the model...
            {/* The clock is the wait's honest measure: this row's tokens
                land at its own step-finish — after the line is gone — and
                StatusStats renders zero counts as time only. */}
            <StatusStats
              start={info.time.created}
              gen={
                info.tokens
                  ? (info.tokens.output ?? 0) + (info.tokens.reasoning ?? 0)
                  : 0
              }
            />
          </div>
        </div>
      )}
      {content.map((c) => {
        const run = Array.isArray(c.el) ? (c.el as ToolPart[]) : undefined;
        if (run) return <ExploreGroup key={c.key} parts={run} />;
        const part = c.el as Part;
        return (
          <PartRow
            key={c.key}
            part={part}
            live={live}
            closed={closed.has(part.id)}
          />
        );
      })}
      {error && <div class="msg-error">{error}</div>}
    </div>
  );
}

// Tool-execution time within a turn, as one merged span (epoch ms) —
// parallel tools count once. Running tools (no end stamp) extend to `now`.
function toolBusyMs(msgs: ChatMessage[], now: number): number {
  const ivs: [number, number][] = [];
  for (const m of msgs) {
    if (m.info.role !== "assistant") continue;
    for (const p of m.parts) {
      const t = isTool(p) ? p.state?.time : undefined;
      if (!t?.start) continue;
      ivs.push([t.start, Math.max(t.start, t.end ?? now)]);
    }
  }
  if (ivs.length === 0) return 0;
  ivs.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let lo = ivs[0][0];
  let hi = ivs[0][1];
  for (let i = 1; i < ivs.length; i++) {
    if (ivs[i][0] > hi) {
      total += hi - lo;
      lo = ivs[i][0];
    }
    if (ivs[i][1] > hi) hi = ivs[i][1];
  }
  return total + hi - lo;
}

export const MessageView = memo(
  MessageViewImpl,
  (a, b) => a.m === b.m && a.live === b.live,
);

// Quiet row under a turn — copy the turn's text, then agent · model · wall
// time · generated tokens · tok/s. The counter runs while the turn
// streams: usage only exists at step boundaries, so until then the
// streamed text is the count (chars ÷ the learned chars/token ratio),
// sampled once a second and snapping to the real total when the turn ends.
function TurnFooterImpl(props: { msgs: ChatMessage[]; live?: boolean }) {
  const text = props.msgs
    .filter((m) => m.info.role === "assistant")
    .flatMap((m) =>
      m.parts
        .filter((p): p is TextPart => isText(p) && p.type === "text")
        .map((p) => p.text ?? ""),
    )
    .filter(Boolean)
    .join("\n\n");
  const info = [...props.msgs].reverse().find((m) => m.info.agent || m.info.modelID)
    ?.info;
  const agent = info?.agent
    ? info.agent.charAt(0).toUpperCase() + info.agent.slice(1)
    : undefined;
  const model = info?.modelID
    ? modelLabel({ providerID: info.providerID ?? "", id: info.modelID })
    : "";
  const start = props.msgs[0]?.info.time.created;
  // Settled = the newest message completed. Scanning the whole group put an
  // earlier finished step's stamp in `end`, which killed the live tick for
  // the rest of a multi-step stream — the rate then moved only when a delta
  // happened to re-render it.
  const end = props.msgs[props.msgs.length - 1]?.info.time.completed;
  const live = props.live && !end;
  // What the turn generated: server-reported output + reasoning, plus the
  // tail still streaming unreported (chars ÷ the learned ratio). The
  // endpoint counts usage only at step boundaries, and a multi-step
  // message carries tokens from its FIRST boundary on — without the
  // reportedChars stamp the tail would die with step 1 and the counter
  // (and its rate) stand still for the rest of the turn. A v1 row's usage
  // lands via message.updated with no stamp; nothing past it can be
  // estimated — skip like a counted row.
  const real = props.msgs.reduce((n, m) => {
    if (m.info.role !== "assistant" || !m.info.tokens) return n;
    const t = m.info.tokens;
    return n + (t.output ?? 0) + (t.reasoning ?? 0);
  }, 0);
  // textChars: every text/reasoning char the turn streamed — the rate's
  // source. Boundary usage reports never touch it (their jumps are mostly
  // tool-call tokens, which are not a pace), so it grows as one smooth ramp
  // calibratable to tokens via the learned ratio.
  let textChars = 0;
  const tail = props.msgs.reduce((n, m) => {
    if (m.info.role !== "assistant") return n;
    const chars = m.parts.reduce(
      (k, p) => k + (isText(p) ? p.text?.length ?? 0 : 0),
      0,
    );
    textChars += chars;
    // Zeroed tokens are an announcement, not a measurement — a truthy
    // object would kill the estimate and hide the count for the whole
    // stream (seen on real turns: count absent until the first usage).
    if (tokensTotal(m.info.tokens) && m.info.reportedChars === undefined)
      return n;
    return n + Math.max(0, chars - (m.info.reportedChars ?? 0));
  }, 0);
  const gen = real + Math.round(tail / charsPerToken());
  // The running turn samples once a second. The rate is the char ramp's
  // mean over the last seven seconds, net of tool time, scaled by the
  // learned ratio at read time: providers offload tokens in batches, so
  // one second's delta can carry several seconds of generation, and a
  // per-move median reads each batch as pace — the idle seconds the
  // batch accumulated over never entered its window. The mean over
  // idle seconds too amortizes batches to delivered throughput; netting
  // out the tool-busy span keeps tool phases (which stream no text)
  // from dragging it, the same subtraction the settled rate applies. A
  // zero reading holds the last nonzero one rather than blanking
  // mid-turn, and the window lives in a ref so each step boundary
  // restart carries it across.
  const [snap, setSnap] = useState<{
    gen: number;
    rate: number;
    now: number;
  }>();
  const state = useRef({ live, gen, chars: textChars, busy: 0 });
  state.current = {
    live,
    gen,
    chars: textChars,
    busy: toolBusyMs(props.msgs, Date.now()),
  };
  const hist = useRef<{ c: number; b: number }[]>([]);
  const lastRate = useRef(0);
  useEffect(() => {
    if (!live) return;
    let shown = lastRate.current;
    const sample = () => {
      const h = hist.current;
      h.push({ c: state.current.chars, b: state.current.busy });
      if (h.length > 8) h.shift();
      const spanS = h.length - 1;
      const rate =
        spanS > 0
          ? Math.max(0, h[h.length - 1].c - h[0].c) /
            charsPerToken() /
            Math.max(1, spanS - (state.current.busy - h[0].b) / 1000)
          : 0;
      if (rate > 0) {
        shown = rate;
        lastRate.current = rate;
      }
      setSnap({ gen: state.current.gen, rate: shown, now: Date.now() });
    };
    sample();
    const iv = window.setInterval(sample, 1000);
    return () => window.clearInterval(iv);
  }, [live]);
  const shownGen = live && snap ? snap.gen : gen;
  const now = live && snap ? snap.now : (end ?? Date.now());
  const secs = start ? Math.max(1, Math.round((now - start) / 1000)) : undefined;
  const firstToken = props.msgs.reduce<number | undefined>((lo, m) => {
    if (m.info.role !== "assistant") return lo;
    return m.parts.reduce((l, p) => {
      const s = isText(p) ? p.time?.start : undefined;
      return s !== undefined && (l === undefined || s < l) ? s : l;
    }, lo);
  }, undefined);
  // tok/s runs from the first token, not the prompt: queue and prefill
  // are not generation, and the parts carry that moment (reasoning/text
  // start stamps; durable reasoning rows get it from the server). Live,
  // the sliding-window rate above; settled, the streamed chars over the
  // same span minus tool intervals — the count totals every token, the
  // rate stays a generation pace. The wall `secs` beside it is the whole
  // turn.
  const from = firstToken ?? start;
  const settledRate =
    !live && textChars > 0 && from
      ? textChars /
        charsPerToken() /
        Math.max(
          1,
          Math.max(0, now - from - toolBusyMs(props.msgs, now)) / 1000,
        )
      : 0;
  const meta = [
    agent,
    model,
    secs !== undefined && (end || live) ? fmtDur(secs) : "",
    shownGen > 0 ? fmtTok(shownGen) : "",
    live
      ? snap && snap.rate > 0
        ? `${fmtRate(snap.rate)} tok/s`
        : ""
      : settledRate > 0
        ? `${fmtRate(settledRate)} tok/s`
        : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const [copied, setCopied] = useState(false);
  if (!text && !meta) return null;

  const copy = () => {
    if (text) void navigator.clipboard.writeText(text).catch(() => {});
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div class="turn-footer">
      {text && (
        <button
          type="button"
          class={copied ? "turn-copy done" : "turn-copy"}
          title="Copy message"
          aria-label="Copy message"
          onClick={copy}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </button>
      )}
      {meta && <span class="turn-meta">{meta}</span>}
    </div>
  );
}

export const TurnFooter = memo(
  TurnFooterImpl,
  (a, b) => sameMsgs(a.msgs, b.msgs) && a.live === b.live,
);
