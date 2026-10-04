// v2 server-event translation. @opencode/cli 2.x streams its turn dialect
// on /api/event with its own event family (session.step.*, session.text.*,
// session.execution.*, …) and (assistantMessageID, ordinal) coordinates; the
// app's streaming pipeline speaks the 1.18 dialect (session.next.*, rows
// and parts by id). This module rewrites v2 frames into the events the
// store already handles, so store.ts stays untouched. Hooked in store.init
// ahead of the queue; unknown events pass through (the store ignores what
// it doesn't know).
import type { ServerEvent } from "./events";
import { formToQuestion, toMs, v2CompactionTrigger, v2ModelRef } from "./api";

// v2 addresses a part as (assistantMessageID, ordinal); the durable fetch
// names content elements `${row.id}:${index}`. The stream's ordinal counts
// WITHIN a kind (reasoning and text both arrive ordinal 0 on the wire), so
// kind-distinct ids are the only collision-free shape — the refresh merge
// matches streamed parts to durable ones by kind and position instead of id.
const partID = (
  assistantMessageID: string,
  ordinal: unknown,
  kind: "t" | "r",
): string | undefined =>
  typeof ordinal === "number" ? `${assistantMessageID}:${kind}${ordinal}` : undefined;

// A v2 row id from the wire: rows the transcript serves are msg_*-named,
// events evt_*-named — the official client mints row ids from event ids
// by swapping the prefix, and the durable fetch serves the same id (the
// streamed row merges with it instead of duplicating).
export const v2RowID = (rowID: unknown, eventID: string | undefined): string | undefined =>
  typeof rowID === "string" && rowID
    ? rowID
    : eventID
      ? eventID.replace(/^evt_/, "msg_")
      : undefined;

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
  // session.synthetic: the injector's metadata (peer messages tag
  // metadata.peerMessage — the peer card's provenance).
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export function translateV2Event(event: ServerEvent): ServerEvent[] {
  const d = (event.data ?? {}) as V2Data;
  const sid = d.sessionID;
  // v2 frames carry a top-level `created` (ms on 2.0.x, ISO on newer
  // builds); the pump folds it into data.timestamp for the app's stamps —
  // read whichever survived, coerced to ms.
  const at =
    toMs((event as { created?: unknown }).created) ??
    (typeof d.timestamp === "number" ? d.timestamp : undefined);
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
    case "session.step.started": {
      const model = v2ModelRef(d.model);
      return d.assistantMessageID
        ? [
            synth("session.next.step.started", {
              sessionID: sid,
              assistantMessageID: d.assistantMessageID,
              ...(d.agent ? { agent: d.agent } : {}),
              ...(model ? { model } : {}),
              timestamp: toMs(d.started),
            }),
          ]
        : [];
    }
    case "session.step.streamed":
      // Delta coalescing signal only — the parts carry the content.
      return [];
    case "session.step.ended":
      return d.assistantMessageID
        ? [
            // The store stamps the row's completed time from `timestamp` —
            // without it the settled rate divides from a render-time now.
            synth("session.next.step.ended", {
              sessionID: sid,
              assistantMessageID: d.assistantMessageID,
              ...(d.finish ? { finish: d.finish } : {}),
              ...(d.cost !== undefined ? { cost: d.cost } : {}),
              ...(d.tokens !== undefined ? { tokens: d.tokens } : {}),
              timestamp: at,
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
              timestamp: at,
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
      const isText = event.type === "session.text.delta";
      const pid =
        d.assistantMessageID &&
        partID(d.assistantMessageID, d.ordinal, isText ? "t" : "r");
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
      const isText = event.type === "session.text.ended";
      const pid =
        d.assistantMessageID &&
        partID(d.assistantMessageID, d.ordinal, isText ? "t" : "r");
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
                timestamp: at,
              },
            ),
          ]
        : [];
    }
    // The server re-read its config (a file edit — ours included, when a
    // provider gets disabled): the catalog may have changed shape, so
    // re-pull the base exactly like a reconnect would.
    case "config.updated":
      return [synth("server.connected", {})];
    // --- tools → the 1.18 tool-call family (callID-keyed state machine) ---
    case "session.tool.input.started":
      return d.assistantMessageID && d.id
        ? [
            synth("session.next.tool.input.started", {
              sessionID: sid,
              assistantMessageID: d.assistantMessageID,
              callID: d.id,
              ...(d.name ? { name: d.name } : {}),
              // The tool span's start/end stamps ride the synth: without
              // them the streamed tool rows carry no time, the elapsed tips
              // vanish, and the footer's rate never nets tool execution.
              timestamp: at,
            }),
          ]
        : [];
    // Input streams as deltas; the preview reads them live off the raw
    // text (streamingArg), the completed text parses at input.ended, and
    // tool.called re-stamps with the server's parsed object. Progress
    // frames carry no display facts — still dropped.
    case "session.tool.input.delta":
      return d.assistantMessageID && d.id && typeof d.delta === "string"
        ? [
            synth("session.next.tool.input.delta", {
              sessionID: sid,
              assistantMessageID: d.assistantMessageID,
              callID: d.id,
              delta: d.delta,
            }),
          ]
        : [];
    case "session.tool.input.ended":
      return d.assistantMessageID && d.id && typeof d.text === "string"
        ? [
            synth("session.next.tool.input.ended", {
              sessionID: sid,
              assistantMessageID: d.assistantMessageID,
              callID: d.id,
              text: d.text,
            }),
          ]
        : [];
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
              timestamp: at,
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
              // resultState (~ the structured patches/todos). metadata
              // carries the subagent's child session, edit diffs, and
              // background flags — the chips read it.
              ...(Array.isArray(d.content) ? { content: d.content } : {}),
              ...(d.resultState !== null &&
              typeof d.resultState === "object"
                ? { structured: d.resultState }
                : {}),
              ...(d.metadata !== undefined ? { metadata: d.metadata } : {}),
              timestamp: at,
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
              timestamp: at,
            }),
          ]
        : [];
    // --- session metadata the pipeline already has events for ---
    case "session.model.selected": {
      const model = v2ModelRef(d.model);
      return sid && model
        ? [synth("session.next.model.switched", { sessionID: sid, model })]
        : [];
    }
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
    // v2 asks ride two channels: the per-turn `session.permissions` list
    // AND a bare `permission.asked` with the v2 shape (same schema the
    // official client docks). Both map to permission.v2.asked — the dock
    // dedupes by id. Unmapped, the store's v1 `permission.asked` case
    // would dock it with the v1 normalizer and reply on the dropped v1
    // route.
    case "permission.asked":
      return d.id
        ? [
            synth("permission.v2.asked", {
              id: d.id,
              sessionID: sid,
              action: d.action,
              resources: d.resources ?? [],
              save: d.save ?? [],
              source: d.source,
            }),
          ]
        : [];
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
    // v2's reply facts under the bare (v1-named) events with the v2
    // coordinates — the store's v2-suffixed cases consume them.
    case "permission.replied":
      return d.requestID
        ? [
            synth("permission.v2.replied", {
              requestID: d.requestID,
              sessionID: sid,
              reply: d.reply,
            }),
          ]
        : [];
    // --- session rows: v1 sends full rows (session.updated {info}); v2
    // sends facts. The store merges partial info, so each fact maps to a
    // partial-row session.updated. ---
    case "session.created":
      // {sessionID, title, slug, projectID, location...} — facts only; the
      // store's partial merge keeps what it already has and defaults the
      // rest on the upsert path (a row we've never listed).
      return sid
        ? [
            synth("session.updated", {
              info: {
                id: sid,
                ...(d.title !== undefined ? { title: d.title } : {}),
                ...(at !== undefined
                  ? { time: { created: at, updated: at } }
                  : {}),
                location: d.location,
                ...(d.parentID ? { parentID: d.parentID } : {}),
              },
            }),
          ]
        : [];
    // Another client moved the session to a different project — patch the
    // row's location so Home doesn't serve a stale directory until the next
    // full refresh.
    case "session.moved":
      return sid && d.location
        ? [synth("session.updated", { info: { id: sid, location: d.location } })]
        : [];
    // A server-injected note (compaction bookkeeping, notices). The
    // official client renders it like a user bubble; ours lands it as a
    // plain assistant row — role "user" would entangle it with the echo
    // retirement and the ghost-turn abort, which watch user rows. A peer
    // injection keeps its provenance on the part (synthetic +
    // metadata.peerMessage) so the peer card renders live; the durable
    // fetch later serves the row as the v1-shaped user row (same id).
    case "session.synthetic": {
      const rowID = v2RowID(undefined, event.id);
      const peer = d.metadata?.peerMessage;
      return sid && rowID && typeof d.text === "string"
        ? [
            synth("message.updated", {
              sessionID: sid,
              info: {
                id: rowID,
                role: "assistant",
                time: { created: at ?? Date.now() },
              },
            }),
            synth("message.part.updated", {
              sessionID: sid,
              part: {
                id: `${rowID}:text`,
                messageID: rowID,
                sessionID: sid,
                type: "text",
                text: d.text,
                ...(peer ? { synthetic: true, metadata: { peerMessage: peer } } : {}),
              },
            }),
          ]
        : [];
    }
    case "session.usage.updated":
      // {sessionID, cost, tokens} — the running sum, so the partial-row
      // merge SETS it (step.ended adds its delta first; a set from wire
      // truth converges either way). The v1 row refresh in event form.
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
    case "session.revert.staged":
      // {sessionID, revert:{messageID}} — another client's revert marker;
      // the partial-row merge carries it (refreshMessages folds at it).
      return sid
        ? [
            synth("session.updated", {
              info: {
                id: sid,
                revert:
                  (d.revert as { messageID?: string } | undefined)?.messageID !==
                  undefined
                    ? { messageID: (d.revert as { messageID: string }).messageID }
                    : undefined,
              },
            }),
          ]
        : [];
    case "session.revert.cleared":
    case "session.revert.committed":
      // Committing truncates server-side; clearing drops the marker. Both
      // land as a revert-free partial row, and the store pulls the
      // truncated truth.
      return sid
        ? [synth("session.updated", { info: { id: sid, revert: null } })]
        : [];
    // Compaction runs as its own server-side turn keyed by its own row id:
    // inputID when the server names one, else the event id under its
    // durable msg_ name (the transcript fetch serves the same id, so the
    // streamed row merges with the durable one instead of duplicating).
    // v2 has no trigger user row — v1's fold (Claude Code's compact block)
    // keys on one, so started synthesizes it (a lone `compaction` part,
    // `reason:"auto"` as its auto flag) under a derived `:c` id the
    // durable fetch also serves. The summary row follows as an assistant
    // row with agent "compaction"; delta streams its text part (the store
    // case finds the open row, as the official client does);
    // ended/failed hand the finish to the refresh, which retires the
    // /compact echo and swaps in the durable truth (a failed compact
    // leaves no completed row).
    case "session.compaction.started": {
      const rowID = v2RowID(d.inputID, event.id);
      if (!sid || !rowID) return [];
      const trigger = v2CompactionTrigger(
        rowID,
        sid,
        { created: at ?? Date.now() },
        d.reason,
      );
      return [
        // The store gates message events on data.sessionID (the v1 frames
        // carry it at the top level) — both synths stamp it.
        synth("message.updated", { sessionID: sid, info: trigger.info }),
        synth("message.part.updated", { sessionID: sid, part: trigger.part }),
        synth("session.next.step.started", {
          sessionID: sid,
          assistantMessageID: rowID,
          agent: "compaction",
          timestamp: at,
        }),
      ];
    }
    // {sessionID, text} — the wire carries no row id; the store case
    // finds the open compaction row (the official client's findLast).
    case "session.compaction.delta":
      return [event];
    case "session.compaction.ended":
    case "session.compaction.failed":
      return sid ? [synth("session.compaction.done", { sessionID: sid })] : [];
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
    // - session.inbox.*: queue bookkeeping; busy/idle is covered by the
    //   execution.* mapping and the echo lands with the prompt reply.
    // - session.instructions.updated: no pipeline consumer.
    default:
      return [event];
  }
}
