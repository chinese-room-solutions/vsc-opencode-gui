// Stuck detection, self-contained: silence clocks per session over the
// store's signals — a "running" tool part with no change for the threshold,
// and the turn itself (busy, nothing running, no visible progress gone
// chronic). The store owns the event stream; this module diffs the signals
// each tick instead of hooking it, so it stays a drop-in. Pending parts
// never flag (they include tools waiting on a permission/question, and those
// asks gate escalation too), and compaction turns are excluded wholesale —
// aborting the summary turn would wedge the session. Detection only surfaces
// the silence; the user (or the delegating agent, one level up) judges.
// opencodeGui.stuckToolSeconds (baked by AppHost) is the threshold; 0
// disables detection. opencodeGui.stuckAutoAbortSeconds escalates to an
// automatic interrupt-and-nudge; 0 (default) keeps the manual chip.
import { isTool, toolName } from "./api";
import type { Part } from "./api";
import {
  fmtDur,
  messagesBySession,
  pendingPermissions,
  pendingQuestions,
  sendPrompt,
  sessionStatus,
  stopSession,
} from "./store";
import type { ChatMessage } from "./store";
import { signal } from "@preact/signals";

export interface StuckPartMark {
  since: number;
  label: string;
  childId?: string;
}
export interface StuckSessionMark {
  parts: Record<string, StuckPartMark>;
  turn?: { since: number };
  escalated?: boolean;
}
export const stuckState = signal<Record<string, StuckSessionMark>>({});

export function silenceLabel(ms: number): string {
  return fmtDur(Math.max(0, Math.floor(ms / 1000)));
}

// A baked-in meta's number; absent/malformed/negative falls back.
function numMeta(name: string, fallback: number): number {
  const el = document.querySelector(`meta[name="${name}"]`);
  const raw = Number(el?.getAttribute("content"));
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

const stuckToolSeconds = numMeta("opencode-stuck-tool", 300);
const stuckAutoAbortSeconds = numMeta("opencode-stuck-auto-abort", 0);
const stuckMinutes = (since: number, now: number): number =>
  Math.max(1, Math.round((now - since) / 60_000));

// Last activity per tool part (session → part → epoch ms) and per session,
// tracked by diffing what the signals show between ticks: a new list for a
// session is session activity, and a changed fingerprint of a running part
// (status or output growth) is that part's activity.
const toolSeen = new Map<string, Map<string, number>>();
const sessionSeen = new Map<string, number>();
const prevLists = new Map<string, ChatMessage[]>();
const prevPrints = new Map<string, Map<string, string>>();
const prevStatus = new Map<string, unknown>();
// One auto-abort per stuck episode; reset when silence breaks or the
// session leaves busy.
const stuckAutoFired = new Set<string>();
let stuckFingerprint = "";

const printOf = (p: Part): string =>
  isTool(p) && p.state
    ? `${p.state.status}|${p.state.output?.length ?? 0}`
    : "";

function hasPendingAsk(sid: string): boolean {
  return (
    pendingPermissions.value.some((p) => p.sessionID === sid) ||
    pendingQuestions.value.some((q) => q.sessionID === sid)
  );
}

// The newest turn is a compaction fold (Session's compactLive).
function compactionLive(sid: string): boolean {
  const list = messagesBySession.value.get(sid);
  for (let i = (list?.length ?? 0) - 1; i >= 0; i--) {
    if (list![i].info.role === "user")
      return list![i].parts.some((p) => p.type === "compaction");
  }
  return false;
}

function stuckTick(): void {
  const now = Date.now();
  const toolMs = stuckToolSeconds * 1000;
  const autoMs = stuckAutoAbortSeconds * 1000;
  const next: Record<string, StuckSessionMark> = {};
  const sids = new Set([
    ...Object.keys(sessionStatus.value),
    ...toolSeen.keys(),
    ...sessionSeen.keys(),
  ]);
  for (const sid of sids) {
    const status = sessionStatus.value[sid];
    if ((status?.type ?? "idle") !== "busy") {
      toolSeen.delete(sid);
      sessionSeen.delete(sid);
      stuckAutoFired.delete(sid);
      prevLists.delete(sid);
      prevPrints.delete(sid);
      prevStatus.delete(sid);
      continue;
    }
    // Only sessions this window has open: marks render in the transcript,
    // and escalation needs the compaction check that transcript provides.
    const list = messagesBySession.value.get(sid);
    if (list === undefined) continue;
    if (prevStatus.get(sid) !== status) sessionSeen.set(sid, now);
    prevStatus.set(sid, status);
    if (prevLists.get(sid) !== list) {
      sessionSeen.set(sid, now);
      const prints = prevPrints.get(sid) ?? new Map<string, string>();
      for (const m of list) {
        for (const p of m.parts) {
          if (!isTool(p) || !p.state) continue;
          const print = printOf(p);
          if (prints.get(p.id) === print) continue;
          prints.set(p.id, print);
          const seen = toolSeen.get(sid);
          if (
            seen &&
            (p.state.status === "pending" || p.state.status === "running")
          )
            seen.set(p.id, now);
        }
      }
      prevPrints.set(sid, prints);
    }
    prevLists.set(sid, list);
    // An unanswered ask IS the explanation for the silence — hold the
    // clocks so answering it grants a fresh grace.
    if (hasPendingAsk(sid)) {
      sessionSeen.set(sid, now);
      const held = toolSeen.get(sid);
      if (held) for (const pid of held.keys()) held.set(pid, now);
      continue;
    }
    if (compactionLive(sid) || toolMs <= 0) continue;
    if (!sessionSeen.has(sid)) sessionSeen.set(sid, now);
    const seen = toolSeen.get(sid) ?? new Map<string, number>();
    const parts: Record<string, StuckPartMark> = {};
    let anyRunning = false;
    for (const m of list) {
      if (m.info.agent === "compaction") continue;
      for (const p of m.parts) {
        if (!isTool(p) || !p.state) continue;
        const st = p.state.status;
        if (st === "completed" || st === "error") {
          seen.delete(p.id);
          continue;
        }
        // Seeds restored rows (reload/reconnect) from their start stamp.
        if (!seen.has(p.id)) seen.set(p.id, p.state.time?.start || now);
        if (st !== "running") continue;
        anyRunning = true;
        const since = seen.get(p.id)!;
        const childId =
          p.tool === "task" && typeof p.state.metadata?.sessionId === "string"
            ? p.state.metadata.sessionId
            : undefined;
        // A child stalled on its own permission/question ask isn't stuck —
        // the ask is the explanation; hold the clock until it's answered.
        if (childId && hasPendingAsk(childId)) {
          seen.set(p.id, now);
          continue;
        }
        if (now - since >= toolMs)
          parts[p.id] = {
            since,
            // Display name ("Shell"), not the schema id ("bash") — the nudge
            // quotes it, and the id can name a shell the box doesn't run.
            label: toolName(p.tool),
            // A sub-agent task tool's worker is its own session: the fix is
            // aborting the CHILD, which returns the result to the parent's
            // turn — the main thread never stops.
            ...(childId ? { childId } : {}),
          };
      }
    }
    if (seen.size) toolSeen.set(sid, seen);
    else toolSeen.delete(sid);
    const turnSince = sessionSeen.get(sid)!;
    const turn =
      !anyRunning && now - turnSince >= toolMs
        ? { since: turnSince }
        : undefined;
    const escalated = stuckAutoFired.has(sid) || undefined;
    if (Object.keys(parts).length || turn) {
      next[sid] = {
        parts,
        ...(turn ? { turn } : {}),
        ...(escalated ? { escalated } : {}),
      };
    } else {
      // Silence broke — the episode is over; auto-abort may fire again.
      stuckAutoFired.delete(sid);
    }
    if (!autoMs || escalated) continue;
    const partDue = Object.values(parts).find((m) => now - m.since >= autoMs);
    const turnDue = turn !== undefined && now - turn.since >= autoMs;
    if (!partDue && !turnDue) continue;
    stuckAutoFired.add(sid);
    void interruptStuck(
      sid,
      turnDue
        ? { kind: "turn", minutes: stuckMinutes(turn.since, now) }
        : {
            kind: "tool",
            label: partDue!.label,
            minutes: stuckMinutes(partDue!.since, now),
            ...(partDue!.childId ? { childId: partDue!.childId } : {}),
          },
    );
  }
  const fingerprint = Object.entries(next)
    .map(
      ([sid, m]) =>
        `${sid}:${m.escalated ? "e" : ""}:${m.turn?.since ?? ""}:${Object.entries(m.parts)
          .map(([pid, p]) => `${pid}@${p.since}`)
          .join(",")}`,
    )
    .join("|");
  if (fingerprint !== stuckFingerprint) {
    stuckFingerprint = fingerprint;
    stuckState.value = next;
  }
}

window.setInterval(stuckTick, 1000);

// Nudge sent after a stuck turn is interrupted, so the agent — not a held
// queued prompt — decides what to do next.
const stuckToolNudge = (label: string, minutes: number): string =>
  `The "${label}" call had no output for ${minutes} minute${minutes === 1 ? "" : "s"} and was interrupted — it may be stuck. Assess the situation and continue with a different approach.`;
const stuckTurnNudge = (minutes: number): string =>
  `No activity for ${minutes} minute${minutes === 1 ? "" : "s"} while the turn was running, so it was interrupted. Assess and continue if work remains.`;

export type StuckReason =
  | { kind: "tool"; label: string; minutes: number; childId?: string }
  | { kind: "turn"; minutes: number };

// One flow at a time per session (a double-click must not double-abort).
const interruptingStuck = new Set<string>();

// Abort a stuck turn, wait for the abort to land, then send the nudge as a
// fresh prompt. A stuck SUB-AGENT task part instead kills only the child
// session: its result returns to the parent's turn, which keeps running —
// the model sees the aborted task and adapts, no nudge needed.
export async function interruptStuck(
  id: string,
  reason: StuckReason,
): Promise<void> {
  if (interruptingStuck.has(id)) return;
  interruptingStuck.add(id);
  try {
    if (reason.kind === "tool" && reason.childId) {
      if (hasPendingAsk(reason.childId)) return;
      await stopSession(reason.childId);
      return;
    }
    if (hasPendingAsk(id) || compactionLive(id)) return;
    await stopSession(id);
    // stopSession retires the turn once the abort POST succeeded — still
    // busy means the interrupt was refused (already surfaced) and the nudge
    // must not ride into a turn that never stopped.
    if ((sessionStatus.value[id]?.type ?? "idle") !== "idle") return;
    if (hasPendingAsk(id) || compactionLive(id)) return;
    await sendPrompt(
      id,
      reason.kind === "tool"
        ? stuckToolNudge(reason.label, reason.minutes)
        : stuckTurnNudge(reason.minutes),
    );
  } finally {
    interruptingStuck.delete(id);
  }
}
