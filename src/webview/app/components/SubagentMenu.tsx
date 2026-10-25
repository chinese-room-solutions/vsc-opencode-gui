import { isTaskTool, isTool, type ToolPart } from "../api";
import { AgentsIcon } from "../icons";
import {
  messagesFor,
  pendingPermissions,
  pendingQuestions,
  popover,
  sessionWorking,
  setPopover,
} from "../store";
import type { ChatMessage } from "../store";
import { childSessionId, inputStr, ToolCard } from "./ToolCard";

// The head's sub-agent roster, left of the context ring. The transcript's
// chips stay where they are, but a long-lived sub-agent ends up under a
// pile of follow-up turns — this button keeps the live set one click away.
// Every row IS the transcript's chip (ToolCard re-rendered), so the two
// cannot drift: click-through, the asking pulse, and stop all behave
// exactly as they do inline.

// The child's pending asks — same derivation as the transcript chip's.
function childAsk(
  id: string | undefined,
): "permission" | "question" | undefined {
  if (id === undefined) return undefined;
  if (pendingPermissions.value.some((p) => p.sessionID === id))
    return "permission";
  if (pendingQuestions.value.some((q) => q.sessionID === id))
    return "question";
  return undefined;
}

type ActiveSubagent = {
  part: ToolPart;
  live: boolean;
  asking: "permission" | "question" | undefined;
};

// The session's live task parts, oldest first, under the same liveness
// rules the transcript's chips use: a part pending/running in the live
// turn, a child session still working (a steer re-activating a settled
// card included), or a child waiting on an ask.
function activeSubagents(
  id: string,
  liveId: string | undefined,
): ActiveSubagent[] {
  const out: ActiveSubagent[] = [];
  for (const m of (messagesFor(id).value ?? []) as ChatMessage[]) {
    for (const part of m.parts) {
      if (!isTool(part)) continue;
      if (!isTaskTool(part.tool)) continue;
      const status = part.state?.status ?? "pending";
      const description =
        inputStr(part, "description") ?? part.state?.title ?? "task";
      const sessionId = childSessionId(part, description);
      const live = m.info.id === liveId;
      const running =
        (live && (status === "pending" || status === "running")) ||
        sessionWorking(sessionId);
      const asking = childAsk(sessionId);
      if (running || asking) out.push({ part, live, asking });
    }
  }
  return out;
}

export function SubagentMenu(props: { sessionId: string; liveId?: string }) {
  const entries = activeSubagents(props.sessionId, props.liveId);
  if (entries.length === 0) return null;
  const open = popover.value === "agents";
  const asking = entries.some((e) => e.asking !== undefined);
  const n = entries.length;
  return (
    <div class={["sam", open && "open"].filter(Boolean).join(" ")}>
      <button
        type="button"
        class="sam-btn"
        title={`${n} sub-agent${n === 1 ? "" : "s"} in progress${
          asking ? " — one is waiting on you" : ""
        }`}
        aria-label={`Sub-agents in progress: ${n}. Click to ${
          open ? "hide" : "list"
        }.`}
        aria-expanded={open}
        onClick={() => setPopover(open ? undefined : "agents")}
      >
        <AgentsIcon />
        <span class="sam-count">{n}</span>
        {asking && <span class="sam-ask" aria-hidden="true" />}
      </button>
      {open && (
        <>
          <div class="backdrop" onClick={() => setPopover(undefined)} />
          <div
            class="menu sam-menu"
            role="menu"
            aria-label="Sub-agents in progress"
          >
            <div class="sam-title">Sub-agents</div>
            {entries.map((e) => (
              <div class="sam-row" key={e.part.id}>
                <ToolCard part={e.part} live={e.live} />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
