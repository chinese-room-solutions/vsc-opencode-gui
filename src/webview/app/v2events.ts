// v2 server-event translation. @opencode/cli 2.x streams its turn dialect
// on /api/event with its own event family (session.step.*, session.text.*,
// session.execution.*, …) and (assistantMessageID, ordinal) coordinates; the
// app's streaming pipeline speaks the 1.18 dialect (session.next.*, rows
// and parts by id). This module rewrites v2 frames into the events the
// store already handles, so store.ts stays untouched. Hooked in store.init
// ahead of the queue; unknown events pass through (the store ignores what
// it doesn't know).
import type { ServerEvent } from "./events";
import { formToQuestion } from "./api";

// v2 addresses a part as (assistantMessageID, ordinal); the durable fetch
// names content elements `${row.id}:${index}` — the same shape, so a
// refresh merges streamed parts by id instead of duplicating them.
const partID = (
  assistantMessageID: string,
  ordinal: unknown,
): string | undefined =>
  typeof ordinal === "number" ? `${assistantMessageID}:${ordinal}` : undefined;

interface V2Data {
  sessionID?: string;
  assistantMessageID?: string;
  ordinal?: number;
  id?: string;
  delta?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  agent?: string;
  model?: { providerID?: string; id?: string; variant?: string };
  error?: unknown;
  cost?: number;
  tokens?: unknown;
  finish?: string;
  started?: number;
  title?: string;
  messageID?: string;
  content?: unknown;
  reason?: string;
  // session.permissions
  permissions?: unknown;
  // form.created
  form?: {
    id?: string;
    sessionID?: string;
    title?: string;
    fields?: unknown[];
  };
  // session.retry.scheduled
  attempt?: number;
  at?: number;
  [key: string]: unknown;
}

export function translateV2Event(event: ServerEvent): ServerEvent[] {
  const d = (event.data ?? {}) as V2Data;
  const sid = d.sessionID;
  // v2 frames carry a top-level `created` (ms); the shared ServerEvent
  // type doesn't declare it — read it softly.
  const at = (event as { created?: number }).created;
  // One synthesized pipeline event; `id` keeps the wire id for tracing.
  const synth = (type: string, data: Record<string, unknown>): ServerEvent => ({
    id: event.id,
    type,
    data,
  });
  switch (event.type) {
    // --- turn lifecycle → the v1 busy/idle/error truth events ---
    case "session.execution.started":
      return sid
        ? [synth("session.status", { sessionID: sid, status: { type: "busy" } })]
        : [];
    // Both ends of a turn retire it: succeeded is the normal end (the
    // synthesized session.idle rings the ready bell and retires the echo
    // exactly like the v1 event), interrupted also lands idle — a user
    // stop has already marked the turn client-side.
    case "session.execution.succeeded":
    case "session.execution.interrupted":
      return sid ? [synth("session.idle", { sessionID: sid })] : [];
    case "session.execution.failed":
      // {sessionID, error} — the store's session.error path surfaces the
      // failure and cleans the optimistic state up.
      return sid
        ? [synth("session.error", { sessionID: sid, error: d.error })]
        : [];
    // --- steps → the 1.18 step family (row upserts, usage, busy) ---
    case "session.step.started":
      return d.assistantMessageID
        ? [
            synth("session.next.step.started", {
              sessionID: sid,
              assistantMessageID: d.assistantMessageID,
              ...(d.agent ? { agent: d.agent } : {}),
              ...(d.model ? { model: d.model } : {}),
              timestamp: d.started,
            }),
          ]
        : [];
    case "session.step.streamed":
      // Delta coalescing signal only — the parts carry the content.
      return [];
    case "session.step.ended":
      return d.assistantMessageID
        ? [
            synth("session.next.step.ended", {
              sessionID: sid,
              assistantMessageID: d.assistantMessageID,
              ...(d.finish ? { finish: d.finish } : {}),
              ...(d.cost !== undefined ? { cost: d.cost } : {}),
              ...(d.tokens !== undefined ? { tokens: d.tokens } : {}),
            }),
          ]
        : [];
    case "session.step.failed":
      return d.assistantMessageID
        ? [
            synth("session.next.step.failed", {
              sessionID: sid,
              assistantMessageID: d.assistantMessageID,
              error: d.error,
            }),
          ]
        : [];
    // --- streamed text/reasoning → the 1.18 part-delta family ---
    case "session.text.started":
    case "session.reasoning.started":
      // The part spawns on its first delta; nothing to project yet.
      return [];
    case "session.text.delta":
    case "session.reasoning.delta": {
      const pid =
        d.assistantMessageID && partID(d.assistantMessageID, d.ordinal);
      return pid && typeof d.delta === "string"
        ? [
            synth(
              event.type === "session.text.delta"
                ? "session.next.text.delta"
                : "session.next.reasoning.delta",
              {
                sessionID: sid,
                assistantMessageID: d.assistantMessageID,
                textID: pid,
                reasoningID: pid,
                delta: d.delta,
              },
            ),
          ]
        : [];
    }
    case "session.text.ended":
    case "session.reasoning.ended": {
      const pid =
        d.assistantMessageID && partID(d.assistantMessageID, d.ordinal);
      return pid
        ? [
            synth(
              event.type === "session.text.ended"
                ? "session.next.text.ended"
                : "session.next.reasoning.ended",
              {
                sessionID: sid,
                assistantMessageID: d.assistantMessageID,
                textID: pid,
                reasoningID: pid,
                ...(typeof d.text === "string" ? { text: d.text } : {}),
              },
            ),
          ]
        : [];
    }
    // --- tools → the 1.18 tool-call family (callID-keyed state machine) ---
    case "session.tool.input.started":
      return d.assistantMessageID && d.id
        ? [
            synth("session.next.tool.input.started", {
              sessionID: sid,
              assistantMessageID: d.assistantMessageID,
              callID: d.id,
              ...(d.name ? { name: d.name } : {}),
            }),
          ]
        : [];
    // Input streams as deltas but lands whole in tool.called — drop the
    // incremental frames (also session.tool.progress, below).
    case "session.tool.input.delta":
    case "session.tool.input.ended":
    case "session.tool.progress":
      return [];
    case "session.tool.called":
      return d.assistantMessageID && d.id
        ? [
            synth("session.next.tool.called", {
              sessionID: sid,
              assistantMessageID: d.assistantMessageID,
              callID: d.id,
              ...(d.input ? { input: d.input } : {}),
            }),
          ]
        : [];
    case "session.tool.success":
      return d.assistantMessageID && d.id
        ? [
            synth("session.next.tool.success", {
              sessionID: sid,
              assistantMessageID: d.assistantMessageID,
              callID: d.id,
              // v2 carries the readable result as content items (the
              // store folds them into output) and the machine result in
              // resultState (~ the structured patches/todos).
              ...(Array.isArray(d.content) ? { content: d.content } : {}),
              ...(d.resultState !== null &&
              typeof d.resultState === "object"
                ? { structured: d.resultState }
                : {}),
            }),
          ]
        : [];
    case "session.tool.failed":
      return d.assistantMessageID && d.id
        ? [
            synth("session.next.tool.failed", {
              sessionID: sid,
              assistantMessageID: d.assistantMessageID,
              callID: d.id,
              error: d.error,
            }),
          ]
        : [];
    // --- session metadata the pipeline already has events for ---
    case "session.model.selected":
      return sid && d.model
        ? [synth("session.next.model.switched", { sessionID: sid, model: d.model })]
        : [];
    case "session.agent.selected":
      return sid && d.agent
        ? [synth("session.next.agent.switched", { sessionID: sid, agent: d.agent })]
        : [];
    // Full content sync for one row → the v1 part-upsert events (a row
    // refresh). Elements are named like the durable fetch names them, so
    // the same part-merge rules apply.
    case "session.message.content.updated": {
      if (!sid || !d.messageID || !Array.isArray(d.content)) return [];
      return (d.content as Record<string, unknown>[]).map((c, i) =>
        synth("message.part.updated", {
          sessionID: sid,
          part: {
            ...c,
            ...(c.type === "tool" && c.tool === undefined && typeof c.name === "string"
              ? { tool: c.name }
              : {}),
            id: typeof c.id === "string" ? c.id : `${d.messageID}:${i}`,
            messageID: d.messageID,
            sessionID: sid,
          },
        }),
      );
    }
    // --- asks: permissions and forms dock like the v1 pipeline's ---
    // session.permissions {sessionID, permissions[]} — each row is an ask;
    // the store's permission.v2.asked case normalizes and docks it.
    case "session.permissions": {
      if (!Array.isArray(d.permissions)) return [];
      return (d.permissions as V2Data[])
        .filter((r) => typeof r?.id === "string")
        .map((r) =>
          synth("permission.v2.asked", {
            id: r.id,
            sessionID: r.sessionID ?? sid,
            action: r.action,
            resources: r.resources ?? [],
            save: r.save ?? [],
            source: r.source,
          }),
        );
    }
    // form.created {sessionID, form:{id, title, fields}} — v2's question
    // channel, mapped onto the v1 question shape the dock renders.
    case "form.created": {
      const f = d.form;
      const q =
        f && typeof f === "object"
          ? formToQuestion(
              f as unknown as Record<string, unknown>,
              f.sessionID ?? sid ?? "",
            )
          : undefined;
      return q
        ? [synth("question.v2.asked", q as unknown as Record<string, unknown>)]
        : [];
    }
    case "form.replied":
      return sid && d.id
        ? [synth("question.v2.replied", { requestID: d.id, sessionID: sid })]
        : [];
    case "form.cancelled":
      return sid && d.id
        ? [synth("question.v2.rejected", { requestID: d.id, sessionID: sid })]
        : [];
    // --- session rows: v1 sends full rows (session.updated {info}); v2
    // sends facts. The store merges partial info, so each fact maps to a
    // partial-row session.updated. ---
    case "session.created":
      // {sessionID, title, slug, projectID, location...} — no time/cost;
      // defaults keep the row renderable until the next full refresh.
      return sid
        ? [
            synth("session.updated", {
              info: {
                id: sid,
                title: d.title ?? "",
                time: { created: at ?? Date.now(), updated: at ?? Date.now() },
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                location: d.location,
                ...(d.parentID ? { parentID: d.parentID } : {}),
              },
            }),
          ]
        : [];
    case "session.usage.updated":
      // {sessionID, cost, tokens} — the running sum (v1 parity: the v1 row
      // refresh).
      return sid
        ? [
            synth("session.updated", {
              info: {
                id: sid,
                ...(d.cost !== undefined ? { cost: d.cost } : {}),
                ...(d.tokens !== undefined ? { tokens: d.tokens } : {}),
                time: { updated: at },
              },
            }),
          ]
        : [];
    case "session.retry.scheduled":
      // {sessionID, attempt, at, error} — v1 surfaces retries as a
      // session.status {type:"retry"}.
      return sid
        ? [
            synth("session.status", {
              sessionID: sid,
              status: {
                type: "retry",
                attempt: typeof d.attempt === "number" ? d.attempt : 1,
                message:
                  typeof d.error === "string"
                    ? d.error
                    : ((d.error as { message?: string })?.message ?? "Retrying"),
                next: d.at,
              },
            }),
          ]
        : [];
    // session.renamed {sessionID, title} and session.deleted {sessionID}
    // pass through — small store cases handle them (v1 surfaces the same
    // facts through full-row events v2 never sends).
    // Dropped on purpose:
    // - session.usage.updated: usage lands per step via the step.ended
    //   mapping and per row via the durable fetch; mapping it too would
    //   double-count into the session row.
    // - session.inbox.*: queue bookkeeping; busy/idle is covered by the
    //   execution.* mapping and the echo lands with the prompt reply.
    // - session.instructions.updated: no pipeline consumer.
    default:
      return [event];
  }
}
