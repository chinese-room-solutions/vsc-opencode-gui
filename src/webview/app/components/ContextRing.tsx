import { useEffect, useRef, useState } from "preact/hooks";
import {
  isText,
  isTool,
  type MessageTokens,
  type Part,
  type Session,
  type TextPart,
  tokensTotal,
} from "../api";
import {
  contextLimit,
  formatDateTime,
  messagesBySession,
  messagesFor,
  modelLabel,
  popover,
  providers,
  sessions,
  setPopover,
  stepUsage,
} from "../store";
import type { ChatMessage } from "../store";
import { CloseIcon } from "../icons";

// Context/cost ring, top-right of the session head. Fill = the latest
// turn's usage (assistant message tokens, superseded live by
// session.next.step.ended) against the model's context-window limit;
// clicking opens the context panel docked to the panel's right edge.

// Costs render like the opencode web UI: currency format, "$0.00". Pinned
// to en-US — the browser default resolves oddly (US$ / dot grouping) in
// some locales, and the original GUI reads English.
const intl = "en-US";
const costFmt = new Intl.NumberFormat(intl, {
  style: "currency",
  currency: "USD",
});

function fmtNum(n: number): string {
  return n.toLocaleString(intl);
}

// ses_fadf8be30ffe… → "fadf8be3", for the fallback Session cell / filename.
function shortId(id: string): string {
  return id.replace(/^ses_/, "").slice(0, 8);
}

function dash(v: string | undefined): string {
  return v ? v : "—";
}

// Last assistant message carrying usage (list is oldest-first). The
// compaction summary row is skipped: its tokens measure the summary turn,
// not the session's context — the next real turn's input is the truth
// either way (folded small, or unchanged when compaction didn't fold).
function lastUsed(id: string): ChatMessage | undefined {
  const list = messagesFor(id).value ?? [];
  let last: ChatMessage | undefined;
  for (const m of list) {
    if (m.info.role !== "assistant" || !m.info.tokens) continue;
    if (m.info.agent === "compaction") continue;
    // A step-start row announces zeroed tokens before its first
    // step-finish — not a measurement. Skipping it holds the previous
    // turn's value while the new turn warms up.
    if (!tokensTotal(m.info.tokens)) continue;
    last = m;
  }
  return last;
}

// Newest compaction row measured after `after` — i.e. the fold that made
// every measurement the ring holds stale. Its output tokens are the
// summary's size.
function lastCompactionAfter(
  list: ChatMessage[],
  after: ChatMessage,
): ChatMessage | undefined {
  let out: ChatMessage | undefined;
  for (const m of list) {
    if (m.info.agent !== "compaction" || !m.info.tokens?.output) continue;
    if (m.info.time.created <= after.info.time.created) continue;
    out = m;
  }
  return out;
}

// Session base: the context every turn starts from (system prompt + tool
// schemas), calibrated once from the first measured turn — its prompt side
// is the base plus the user rows before it, and those are text, estimated
// at ~4 chars/token. Against the base's thousands of tokens the estimate's
// error is negligible. The prompt side is input + cache (the row's total
// also counts the turn's own output and reasoning — not context).
const baseCache = new Map<string, number>();
function contextBase(id: string, list: ChatMessage[]): number {
  // Bounded by live sessions: a long-lived view browsing many sessions
  // must not accumulate entries for closed ones.
  if (baseCache.size > 16)
    for (const k of [...baseCache.keys()])
      if (!messagesBySession.value.has(k)) baseCache.delete(k);
  const hit = baseCache.get(id);
  if (hit !== undefined) return hit;
  let first: ChatMessage | undefined;
  for (const m of list) {
    const t = m.info.tokens;
    if (m.info.role !== "assistant" || m.info.agent === "compaction") continue;
    if (!t || t.input + t.cache.read + t.cache.write <= 0) continue;
    first = m;
    break;
  }
  if (!first) return 0;
  let chars = 0;
  for (const m of list) {
    if (m.info.role !== "user" || m.info.time.created > first.info.time.created)
      continue;
    for (const p of m.parts) {
      if (isText(p)) chars += p.text?.length ?? 0;
    }
  }
  const ft = first.info.tokens;
  if (!ft) return 0;
  const base = Math.max(
    0,
    ft.input + ft.cache.read + ft.cache.write - Math.round(chars / 4),
  );
  baseCache.set(id, base);
  return base;
}

// The context a fold really dropped: the pre-compact total minus the
// post-compact context (base + summary — the ring's post-compaction
// estimate). Without a calibration the pre-compact total stands in
// (Claude Code's label, which overstates the drop).
export function foldFreedTokens(
  id: string,
  before: ChatMessage[],
  fold: ChatMessage[],
): number | undefined {
  const last = [...before]
    .reverse()
    .find(
      (m) =>
        m.info.role === "assistant" &&
        m.info.agent !== "compaction" &&
        m.info.tokens &&
        tokensTotal(m.info.tokens) > 0,
    );
  if (!last) return undefined;
  const pre = tokensTotal(last.info.tokens);
  const base = contextBase(id, before);
  if (base <= 0) return pre;
  const summary =
    fold.find((m) => m.info.agent === "compaction")?.info.tokens?.output ?? 0;
  return Math.max(0, pre - base - summary);
}

// The ring's tokens, post-compaction aware. A fold after the newest
// measurement leaves nothing measuring the session's context until the
// next turn's API call — estimate it instead of holding the stale
// pre-compact total: the summary replaced the transcript, so context ≈
// base + the summary's tokens. A step-finish newer than the fold (the
// next real turn) wins.
function ringTokens(
  id: string,
  list: ChatMessage[] | undefined,
  last: ChatMessage | undefined,
): { tokens: MessageTokens | undefined; estimated: boolean } {
  const step = stepUsage.value[id];
  const comp = last && list ? lastCompactionAfter(list, last) : undefined;
  if (
    comp &&
    !(step && step.timestamp > comp.info.time.created) &&
    last &&
    list
  ) {
    const base = contextBase(id, list);
    const summary = comp.info.tokens?.output ?? 0;
    if (base > 0) {
      return {
        tokens: {
          input: base,
          output: summary,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        estimated: true,
      };
    }
  }
  return { tokens: tokenSource(id, last), estimated: false };
}

// The freshest context snapshot: a step.ended for the current turn beats
// the message row it produced (same numbers, sooner). Every token field
// the ring, hover, and panel show derives from this one row — like the
// opencode web UI, which also reads the last assistant message.
function tokenSource(id: string, last?: ChatMessage): MessageTokens | undefined {
  const step = stepUsage.value[id];
  return step && step.timestamp >= (last?.info.time.created ?? 0)
    ? step.tokens
    : last?.info.tokens;
}

// Tool inputs are immutable once sent — stringify each input object once
// ever, not once per ring re-render.
const inputCharsCache = new WeakMap<object, number>();
function inputChars(input: object): number {
  const hit = inputCharsCache.get(input);
  if (hit !== undefined) return hit;
  const n = JSON.stringify(input).length;
  inputCharsCache.set(input, n);
  return n;
}

// Per-part character weight: tool calls count their input + output, text
// and reasoning parts their text, @-mention attachments their decoded
// payload. Char counts proxy for tokens — the API has no per-part token
// attribution.
function partChars(p: Part): number {
  if (isTool(p)) {
    const st = p.state;
    return (
      (st?.output?.length ?? 0) +
      (st?.title?.length ?? 0) +
      (st?.input ? inputChars(st.input) : 0)
    );
  }
  if (p.type === "file") {
    // Attachments ride as data URLs: decode the base64 so the weight is
    // the content actually sent, not its 4/3-inflated encoding.
    const url = (p as { url?: string }).url ?? "";
    const b64 = url.split("base64,")[1];
    return b64 !== undefined ? Math.round((b64.length * 3) / 4) : url.length;
  }
  const text = (p as TextPart).text;
  return p.type === "text" || p.type === "reasoning" ? (text?.length ?? 0) : 0;
}

// Context-weight split by role, from the transcript's own parts: user text
// and its attached files, the assistant's text and thinking (reasoning
// rides the context too — for a thinking model it is most of its share),
// tool-call payloads, everything else (step bookkeeping) as "other".
// Keyed by list identity: any part change replaces the list, so a hit is
// always current — renders between list changes (popover open, status
// ticks) reuse the split instead of re-walking the transcript.
type Split = { user: number; assistant: number; tool: number; other: number };
const splitCache = new WeakMap<ChatMessage[], Split>();
function roleSplit(id: string): Split {
  const list = messagesFor(id).value;
  const hit = list ? splitCache.get(list) : undefined;
  if (hit) return hit;
  const out: Split = { user: 0, assistant: 0, tool: 0, other: 0 };
  if (list) {
    for (const m of list) {
      const key = m.info.role === "user" ? "user" : "assistant";
      for (const p of m.parts) {
        if (isTool(p)) out.tool += partChars(p);
        else if (p.type === "text" || p.type === "reasoning" || p.type === "file")
          out[key] += partChars(p);
        else out.other += partChars(p);
      }
    }
    splitCache.set(list, out);
  }
  return out;
}

// First ~80 chars for the raw-messages list: the message's text, or the
// tool a tool-only message ran.
function preview(m: ChatMessage): string {
  for (const p of m.parts) {
    if (isTool(p)) return p.state?.title || p.tool;
    if (p.type === "file") return (p as { filename?: string }).filename ?? "";
    const text = (p as TextPart).text;
    if (p.type === "text" && text) {
      const flat = text.replace(/\s+/g, " ").trim();
      return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
    }
  }
  return "";
}

// Download the transcript as JSON through a Blob URL — browser-side, no
// host round-trip.
function exportSession(
  id: string,
  session: Session | undefined,
  list: ChatMessage[],
): void {
  const slug =
    (session?.title || id)
      .replace(/[^\w.-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || shortId(id);
  const blob = new Blob(
    [JSON.stringify({ session: session ?? { id }, messages: list }, null, 2)],
    { type: "application/json" },
  );
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${slug}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function ContextRing(props: { sessionId: string }) {
  const id = props.sessionId;
  const open = popover.value === "ctx";
  const session = sessions.value.find((s) => s.id === id);
  const list = messagesFor(id).value;
  const last = lastUsed(id);
  const { tokens: t, estimated } = ringTokens(id, list, last);
  const used = tokensTotal(t);
  const limit = contextLimit(last?.info);
  const frac = Math.min(1, limit > 0 ? used / limit : 0);

  // Hover card (Cost / Usage / Tokens), like the opencode web UI. Delayed
  // so a pass over the ring doesn't flash it; pointer-events:none keeps a
  // hover over the card itself from hiding it.
  const [tip, setTip] = useState(false);
  const tipTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(tipTimer.current), []);
  const showTip = () => {
    window.clearTimeout(tipTimer.current);
    tipTimer.current = window.setTimeout(() => setTip(true), 400);
  };
  const hideTip = () => {
    window.clearTimeout(tipTimer.current);
    setTip(false);
  };

  const R = 6;
  const C = 2 * Math.PI * R;

  // O(transcript) and panel-only — the ring button re-renders on every
  // streaming delta, so nothing below runs with the panel closed.
  const split = open ? roleSplit(id) : undefined;
  const splitTotal = split
    ? Math.max(1, split.user + split.assistant + split.tool + split.other)
    : 1;
  // Fixed hue order; "Other" is deliberately the neutral. Chart colors come
  // from the theme so the panel follows it.
  const buckets = split
    ? [
        {
          label: "User",
          n: split.user,
          color: "var(--vscode-charts-blue, #005fb8)",
        },
        {
          label: "Assistant",
          n: split.assistant,
          color: "var(--vscode-charts-orange, #bb6009)",
        },
        {
          label: "Tool Calls",
          n: split.tool,
          color: "var(--vscode-charts-purple, #8250df)",
        },
        { label: "Other", n: split.other, color: "var(--oc-text-2)" },
      ]
    : [];

  const modelSel =
    session?.model ??
    (last?.info.providerID && last?.info.modelID
      ? { providerID: last.info.providerID, id: last.info.modelID }
      : undefined);
  const providerID = modelSel?.providerID;
  const providerName = providerID
    ? (providers.value?.all.find((p) => p.id === providerID)?.name ?? providerID)
    : undefined;

  // Field order and sources mirror the opencode web UI's context panel:
  // token rows come from the last assistant message (t), counts and cost
  // from the session.
  const cells: { k: string; v: string; title?: string }[] = [
    { k: "Session", v: dash(session?.title || shortId(id)), title: id },
    { k: "Messages", v: list ? fmtNum(list.length) : "—" },
    { k: "Provider", v: dash(providerName) },
    { k: "Model", v: dash(modelSel ? modelLabel(modelSel) : undefined) },
    { k: "Context Limit", v: limit > 0 ? fmtNum(limit) : "—" },
    {
      k: "Total Tokens",
      v: t ? fmtNum(used) : "—",
      ...(estimated
        ? { title: "Estimated from the compaction summary — the next turn measures the real context." }
        : {}),
    },
    {
      k: "Usage",
      v: t ? `${Math.round(frac * 100)}%` : "—",
      title: `${fmtNum(used)} / ${fmtNum(limit)} tokens${
        estimated ? " (estimated)" : ""
      }`,
    },
    { k: "Input Tokens", v: t ? fmtNum(t.input) : "—" },
    { k: "Output Tokens", v: t ? fmtNum(t.output) : "—" },
    { k: "Reasoning Tokens", v: t ? fmtNum(t.reasoning) : "—" },
    {
      k: "Cache Tokens (read/write)",
      v: t ? `${fmtNum(t.cache.read)} / ${fmtNum(t.cache.write)}` : "—",
    },
    {
      k: "User Messages",
      v: list
        ? fmtNum(list.filter((m) => m.info.role === "user").length)
        : "—",
    },
    {
      k: "Assistant Messages",
      v: list
        ? fmtNum(list.filter((m) => m.info.role === "assistant").length)
        : "—",
    },
    { k: "Total Cost", v: session ? costFmt.format(session.cost) : "—" },
    {
      k: "Session Created",
      v: session ? formatDateTime(session.time.created) : "—",
    },
    {
      k: "Last Activity",
      v: last ? formatDateTime(last.info.time.created) : "—",
    },
  ];

  return (
    <>
      <div class="ctx">
        <button
          class="ctx-btn"
          aria-label="Context usage — click to view context"
          onMouseEnter={showTip}
          onMouseLeave={hideTip}
          onFocus={showTip}
          onBlur={hideTip}
          onClick={() => {
            hideTip();
            setPopover(open ? undefined : "ctx");
          }}
        >
          <svg width="14" height="14" viewBox="0 0 14 14">
            <circle class="ring-track" cx="7" cy="7" r={R} />
            <circle
              class="ring-fill"
              cx="7"
              cy="7"
              r={R}
              stroke-dasharray={`${C * frac} ${C}`}
            />
          </svg>
        </button>
        {tip && (
          <div class="ctx-tip" role="tooltip">
            <span class="ctx-tip-k">Cost</span>
            <span class="ctx-tip-v">{costFmt.format(session?.cost ?? 0)}</span>
            <span class="ctx-tip-k">Usage</span>
            <span class="ctx-tip-v">{t ? `${Math.round(frac * 100)}%` : "—"}</span>
            <span class="ctx-tip-k">Tokens</span>
            <span
              class="ctx-tip-v"
              title={
                estimated
                  ? "Estimated from the compaction summary — the next turn measures the real context."
                  : undefined
              }
            >
              {t ? fmtNum(used) : "—"}
            </span>
          </div>
        )}
      </div>
      {open && (
        <aside class="ctx-panel">
          <div class="ctx-head">
            <span class="ctx-title">Context</span>
            <button
              type="button"
              class="ctx-close"
              title="Close"
              aria-label="Close context panel"
              onClick={() => setPopover(undefined)}
            >
              <CloseIcon />
            </button>
          </div>
          <div class="ctx-body">
            <div class="ctx-grid">
              {cells.map((c) => (
                <div class="ctx-item" key={c.k} title={c.title}>
                  <span class="ctx-k">{c.k}</span>
                  <span class="ctx-v">{c.v}</span>
                </div>
              ))}
            </div>
            <div
              class="ctx-sec"
              title="Share of loaded-transcript weight (chars as a token proxy). The system prompt and tool schemas are not transcript parts, so the real context holds more than this shows; older pages load on demand."
            >
              Context Breakdown
            </div>
            <div class="ctx-bar">
              {buckets
                .filter((b) => b.n > 0)
                .map((b) => (
                  <div
                    key={b.label}
                    class="ctx-seg"
                    style={{
                      width: `${(b.n / splitTotal) * 100}%`,
                      background: b.color,
                    }}
                  />
                ))}
            </div>
            <div class="ctx-legend">
              {buckets.map((b) => (
                <span class="ctx-key" key={b.label}>
                  <span class="ctx-swatch" style={{ background: b.color }} />
                  {b.label} {((b.n / splitTotal) * 100).toFixed(1)}%
                </span>
              ))}
            </div>
            <div class="ctx-sec">Raw messages</div>
            <div class="ctx-raw">
              {(list ?? []).map((m) => (
                <div class="ctx-msg" key={m.info.id}>
                  <span class="ctx-role">{m.info.role}</span>
                  <span class="ctx-snippet">{preview(m)}</span>
                </div>
              ))}
              {list?.length === 0 && (
                <div class="ctx-msg">
                  <span class="ctx-snippet">No messages yet.</span>
                </div>
              )}
            </div>
          </div>
          <button
            type="button"
            class="ctx-export"
            onClick={() => exportSession(id, session, list ?? [])}
          >
            Export session
          </button>
        </aside>
      )}
    </>
  );
}
