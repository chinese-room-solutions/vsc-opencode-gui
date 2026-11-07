// The roster counts sub-agents, not task parts: two live parts can vouch
// for the same child session (a steer re-opening it, a spawn race, the
// title fallback landing both on the newest same-labeled child), and the
// menu must show that child once.
import "../setup.test";
import assert from "node:assert/strict";
import { messagesBySession, sessionStatus } from "../store";
import type { ChatMessage } from "../store";
import { activeSubagents } from "./SubagentMenu";
import type { ToolPart, ToolState } from "../api";

const task = (id: string, mid: string, state: ToolState): ToolPart => ({
  id,
  messageID: mid,
  sessionID: "ses_p",
  type: "tool",
  tool: "task",
  state,
});

const msg = (mid: string, parts: ToolPart[]): ChatMessage => ({
  info: { id: mid, role: "assistant", time: { created: 1 } },
  parts,
});

function open(rows: ChatMessage[]): void {
  messagesBySession.value = new Map([...messagesBySession.value, ["ses_p", rows]]);
}

function busy(id: string): void {
  sessionStatus.value = { ...sessionStatus.value, [id]: { type: "busy" } };
}

describe("sub-agent roster", () => {
  it("shows one row for two parts bound to the same child, live part first", () => {
    busy("ses_child_1");
    open([
      msg("m1", [
        task("p1", "m1", {
          status: "completed",
          input: { description: "Check the retry paths" },
          metadata: { sessionId: "ses_child_1" },
          time: { start: 1, end: 2 },
        }),
      ]),
      msg("m2", [
        task("p2", "m2", {
          status: "running",
          input: { description: "Check the retry paths" },
          metadata: { sessionId: "ses_child_1" },
          time: { start: 3 },
        }),
      ]),
    ]);
    const rows = activeSubagents("ses_p", "m2");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].part.id, "p2");
    assert.equal(rows[0].live, true);
  });

  it("keeps parts with no resolvable child distinct", () => {
    open([
      msg("m1", [
        task("p1", "m1", { status: "pending", time: { start: 1 } }),
        task("p2", "m1", { status: "pending", time: { start: 1 } }),
      ]),
    ]);
    const rows = activeSubagents("ses_p", "m1");
    assert.equal(rows.length, 2);
  });

  it("keeps different children separate", () => {
    busy("ses_child_1");
    busy("ses_child_2");
    open([
      msg("m1", [
        task("p1", "m1", {
          status: "completed",
          input: { description: "one" },
          metadata: { sessionId: "ses_child_1" },
          time: { start: 1, end: 2 },
        }),
        task("p2", "m1", {
          status: "completed",
          input: { description: "two" },
          metadata: { sessionId: "ses_child_2" },
          time: { start: 3, end: 4 },
        }),
      ]),
    ]);
    const rows = activeSubagents("ses_p", undefined);
    assert.equal(rows.length, 2);
  });
});
