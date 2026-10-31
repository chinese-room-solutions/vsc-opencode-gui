// Token-rate math for the turn footer, extracted from MessageView for
// tests: the interval helpers the settled rate divides by, and the
// once-a-second sampler behind the running one.
import { charsPerToken } from "./store";
import type { ChatMessage } from "./store";
import { isText, isTool } from "./api";
import type { TextPart } from "./api";

// Union length of intervals (epoch ms) — parallel spans count once.
export function spanMs(ivs: [number, number][]): number {
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

// Time two interval families share (union identity). Subtracting the
// whole tool union from a generation span collapsed rows whose tools sat
// outside the text window — only the overlap is not generation.
export function overlapMs(
  a: [number, number][],
  b: [number, number][],
): number {
  return Math.max(0, spanMs(a) + spanMs(b) - spanMs([...a, ...b]));
}

// Tool-execution time within a turn, as one merged span — parallel tools
// count once. Running tools (no end stamp) extend to `now`.
export function toolBusyMs(msgs: ChatMessage[], now: number): number {
  const ivs: [number, number][] = [];
  for (const m of msgs) {
    if (m.info.role !== "assistant") continue;
    for (const p of m.parts) {
      const t = isTool(p) ? p.state?.time : undefined;
      if (!t?.start) continue;
      ivs.push([t.start, Math.max(t.start, t.end ?? now)]);
    }
  }
  return spanMs(ivs);
}

// The moments a turn actually generated, as the sum of per-row spans. An
// anchored row (streamed parts carry start stamps) measures the union of
// its text parts' windows; a row whose parts carry no anchors (a reloaded
// v2 row stamps only its first element, a reloaded v1 row none) falls to
// its own window net of tool time. Either way the waits that streamed
// nothing stay out of the rate's denominator: queue and prefill before
// the first token, tool execution, the gap between a row and the next —
// a subagent's minutes — and thinking that produced no chars. A row with
// neither anchors nor a completed stamp (aborted mid-row) returns
// undefined and the caller keeps the wall-minus-tools fallback.
export function genMs(msgs: ChatMessage[], now: number): number | undefined {
  let total = 0;
  for (const m of msgs) {
    if (m.info.role !== "assistant") continue;
    const texts = m.parts.filter(
      (p): p is TextPart => isText(p) && !!p.text,
    );
    if (texts.length === 0) continue;
    const toolIvs: [number, number][] = [];
    for (const p of m.parts) {
      const t = isTool(p) ? p.state?.time : undefined;
      if (!t?.start) continue;
      toolIvs.push([t.start, Math.max(t.start, t.end ?? now)]);
    }
    if (texts.every((p) => p.time?.start !== undefined)) {
      // A part with no end of its own runs to the next anchor — that span
      // can swallow a tool window in between, so the overlap the tool
      // intervals share with the per-part spans comes out of them.
      const genIvs = texts.map((p, i) => {
        const start = p.time!.start!;
        return [
          start,
          Math.max(
            start,
            p.time!.end ??
              texts[i + 1]?.time?.start ??
              m.info.time.completed ??
              now,
          ),
        ] as [number, number];
      });
      total += Math.max(0, spanMs(genIvs) - overlapMs(genIvs, toolIvs));
      continue;
    }
    const start = texts[0].time?.start ?? m.info.time.streamed ?? m.info.time.created;
    const end = m.info.time.completed;
    if (start === undefined || end === undefined) return undefined;
    total += Math.max(0, end - start - overlapMs([[start, end]], toolIvs));
  }
  return total;
}

// An aborted turn never receives its completed stamp; the settled footer
// divides from the last provable event instead of the wall clock, or its
// duration would keep growing on every later refresh.
export function lastStampMs(msgs: ChatMessage[]): number | undefined {
  let t: number | undefined;
  for (const m of msgs) {
    const stamps = [
      m.info.time.completed,
      ...m.parts.flatMap((p) => {
        const pt = isTool(p) ? p.state?.time : isText(p) ? p.time : undefined;
        return pt ? [pt.start, pt.end] : [];
      }),
    ];
    for (const s of stamps)
      if (s !== undefined && (t === undefined || s > t)) t = s;
  }
  return t;
}

export interface RateSample {
  // Streamed text/reasoning chars so far.
  c: number;
  // Tool-busy ms so far (toolBusyMs) — nets tool seconds out of the
  // silence a batch amortizes over, and nothing else.
  b: number;
  // Wall time of the sample.
  t: number;
}

// Live-rate sample window (TurnFooter owns one per session+turn).
export interface RateWindow {
  anchor: string;
  hist: RateSample[];
  last: number;
  // The last silence between generation: {t,c,b} of the sample before it
  // began. A batch delivered over it divides by the whole stretch.
  idle?: { t: number; c: number; b: number };
}

// One once-per-second sample of the char ramp, scaled by the learned
// chars/token ratio. The rate divides by PRODUCING seconds only — the
// intervals in which chars actually arrived — so a tool invocation
// leaves it untouched: its execution seconds never enter the denominator
// (neither added nor subtracted — a tool streaming in parallel with text
// used to have its busy subtracted while the same seconds streamed,
// inflating the reading), and the silent stretch while the model writes
// a tool call used to sit in the denominator as zero-char seconds,
// sagging the reading before every call. A silence instead holds the
// last nonzero reading: providers offload tokens in batches, so one
// second's delta can carry several seconds of generation, and when chars
// resume the batch amortizes over the whole silence that produced it,
// net of the tool time inside it (an idle anchor is the previous sample
// once chars exist — never the pre-first-token queue).
export function liveSample(win: RateWindow, s: RateSample): number {
  const h = win.hist;
  const prev = h[h.length - 1];
  h.push(s);
  if (h.length > 8) h.shift();
  let rate: number;
  if (win.idle && prev && s.c > prev.c) {
    rate =
      (s.c - win.idle.c) /
      charsPerToken() /
      Math.max(1, (s.t - win.idle.t) / 1000 - Math.max(0, s.b - win.idle.b) / 1000);
    delete win.idle;
    // The batch and the silence that produced it are fully accounted by
    // the amortized reading above — restart the window, or its history
    // would re-read the same batch over ≤7s for the next several ticks.
    h.length = 0;
    h.push(s);
  } else {
    if (prev && s.c === prev.c && s.c > 0 && win.idle === undefined)
      win.idle = prev;
    if (win.idle) rate = 0;
    else {
      const moved = h.reduce(
        (n, x, i) => (i > 0 && x.c > h[i - 1].c ? n + 1 : n),
        0,
      );
      rate =
        moved > 0
          ? (h[h.length - 1].c - h[0].c) / charsPerToken() / moved
          : 0;
    }
  }
  if (rate > 0) win.last = rate;
  return rate > 0 ? rate : win.last;
}
