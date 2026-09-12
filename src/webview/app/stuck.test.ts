import "./setup.test";
import { strict as assert } from "node:assert";
import { runStuckTick, setNow } from "./setup.test";
import { messagesBySession, pendingPermissions, sessionStatus } from "./store";
import type { ChatMessage } from "./store";
import type { Part } from "./api";
import type { StuckSessionMark } from "./stuck";
import { silenceLabel, stuckState } from "./stuck";

const T0 = 5_000_000;

function marksOf(sid: string): StuckSessionMark | undefined {
  return stuckState.value[sid];
}

function busySession(sid: string): void {
  sessionStatus.value = { ...sessionStatus.value, [sid]: { type: "busy" } };
}

function open(sid: string, rows: ChatMessage[]): void {
  messagesBySession.value = new Map([...messagesBySession.value, [sid, rows]]);
}

function runningToolMsg(
  mid: string,
  pid: string,
  start: number,
  over: Partial<Part> = {},
): ChatMessage {
  return {
    info: { id: mid, role: "assistant", time: { created: start } },
    parts: [
      {
        id: pid,
        messageID: mid,
        sessionID: "any",
        type: "tool",
        tool: "bash",
        state: { status: "running", time: { start } },
        ...over,
      } as Part,
    ],
  };
}

describe("stuck", () => {
  describe("silenceLabel", () => {
    it("formats silent seconds like the counters", () => {
      assert.equal(silenceLabel(0), "0s");
      assert.equal(silenceLabel(949), "0s");
      assert.equal(silenceLabel(59_000), "59s");
      assert.equal(silenceLabel(60_000), "1m");
      assert.equal(silenceLabel(95_000), "1m35s");
      assert.equal(silenceLabel(3_600_000), "1h");
      assert.equal(silenceLabel(104_552_000), "1d5h2m32s");
      assert.equal(silenceLabel(-5), "0s");
    });
  });

  describe("mark state machine", () => {
    it("marks a running tool silent past the threshold, once", () => {
      const sid = "sk1";
      busySession(sid);
      open(sid, [runningToolMsg("m1", "p1", T0)]);
      setNow(T0 + 500);
      runStuckTick(); // seeds the silence clock from the part's start stamp
      assert.equal(marksOf(sid), undefined);
      setNow(T0 + 1_100);
      runStuckTick();
      assert.deepEqual(marksOf(sid)?.parts["p1"], {
        since: T0,
        label: "Shell",
      });
      const mark = stuckState.value;
      setNow(T0 + 1_200);
      runStuckTick(); // fingerprint unchanged — no re-write
      assert.strictEqual(stuckState.value, mark);
    });

    it("output growth resets the part's clock", () => {
      const sid = "sk2";
      busySession(sid);
      open(sid, [runningToolMsg("m1", "p1", T0)]);
      setNow(T0 + 500);
      runStuckTick();
      setNow(T0 + 1_000);
      const grown = runningToolMsg("m1", "p1", T0);
      (grown.parts[0] as { state?: { output?: string } }).state!.output =
        "new output";
      open(sid, [grown]);
      runStuckTick(); // activity seen at T0+1000
      assert.equal(marksOf(sid), undefined);
      setNow(T0 + 1_500); // 500ms of silence since the growth
      runStuckTick();
      assert.equal(marksOf(sid), undefined);
      setNow(T0 + 2_100); // past the threshold again
      runStuckTick();
      assert.equal(marksOf(sid)?.parts["p1"].since, T0 + 1_000);
    });

    it("completed tools clear; a quiet turn with nothing running marks", () => {
      const sid = "sk3";
      busySession(sid);
      open(sid, [
        {
          info: { id: "m1", role: "assistant", time: { created: T0 } },
          parts: [
            {
              id: "p1",
              messageID: "m1",
              sessionID: sid,
              type: "tool",
              tool: "bash",
              state: { status: "completed", time: { start: T0 - 10_000, end: T0 } },
            },
          ],
        },
      ]);
      setNow(T0 + 100);
      runStuckTick(); // first sight of the busy status seeds the session clock
      assert.equal(marksOf(sid), undefined);
      setNow(T0 + 1_200);
      runStuckTick();
      assert.deepEqual(marksOf(sid)?.turn, { since: T0 + 100 });
      assert.equal(marksOf(sid)?.parts["p1"], undefined);
    });

    it("pending tool parts never flag as tools", () => {
      const sid = "sk4";
      busySession(sid);
      open(sid, [
        {
          info: { id: "m1", role: "assistant", time: { created: T0 } },
          parts: [
            {
              id: "p1",
              messageID: "m1",
              sessionID: sid,
              type: "tool",
              tool: "bash",
              state: { status: "pending" },
            },
          ],
        },
      ]);
      setNow(T0 + 100);
      runStuckTick();
      setNow(T0 + 1_500);
      runStuckTick();
      assert.equal(marksOf(sid)?.parts["p1"], undefined);
    });

    it("an idle session clears its marks", () => {
      const sid = "sk5";
      busySession(sid);
      open(sid, [runningToolMsg("m1", "p1", T0)]);
      setNow(T0 + 100);
      runStuckTick();
      setNow(T0 + 1_200);
      runStuckTick();
      assert.ok(marksOf(sid));
      sessionStatus.value = { ...sessionStatus.value, [sid]: { type: "idle" } };
      runStuckTick();
      assert.equal(marksOf(sid), undefined);
    });

    it("an unanswered ask holds the clocks; answering grants a fresh grace", () => {
      const sid = "sk6";
      busySession(sid);
      open(sid, [runningToolMsg("m1", "p1", T0)]);
      setNow(T0 + 100);
      runStuckTick(); // scans and seeds the part clock
      assert.equal(marksOf(sid), undefined);
      pendingPermissions.value = [
        { id: "ask1", sessionID: sid, action: "bash", resources: [], save: [] },
      ];
      setNow(T0 + 5_000); // far past the threshold, but the ask holds
      runStuckTick();
      assert.equal(marksOf(sid), undefined);
      setNow(T0 + 8_000);
      runStuckTick();
      assert.equal(marksOf(sid), undefined);
      pendingPermissions.value = [];
      setNow(T0 + 8_100); // fresh grace from the answer
      runStuckTick();
      assert.equal(marksOf(sid), undefined);
      setNow(T0 + 9_500); // silence past the threshold again
      runStuckTick();
      assert.ok(marksOf(sid)?.parts["p1"]);
    });

    it("a task tool marks its child session, held while the child asks", () => {
      const sid = "sk7";
      busySession(sid);
      open(sid, [
        {
          info: { id: "m1", role: "assistant", time: { created: T0 } },
          parts: [
            {
              id: "p1",
              messageID: "m1",
              sessionID: sid,
              type: "tool",
              tool: "task",
              state: {
                status: "running",
                time: { start: T0 },
                metadata: { sessionId: "child1" },
              },
            },
          ],
        },
      ]);
      setNow(T0 + 100);
      runStuckTick();
      pendingPermissions.value = [
        { id: "cask", sessionID: "child1", action: "edit", resources: [], save: [] },
      ];
      setNow(T0 + 2_000);
      runStuckTick();
      assert.equal(marksOf(sid), undefined); // child ask holds
      pendingPermissions.value = [];
      setNow(T0 + 2_100);
      runStuckTick();
      setNow(T0 + 3_300);
      runStuckTick();
      const mark = marksOf(sid)?.parts["p1"];
      assert.equal(mark?.childId, "child1");
      assert.equal(mark?.label, "Task");
    });

    it("a live compaction turn is excluded wholesale", () => {
      const sid = "sk8";
      busySession(sid);
      open(sid, [
        {
          info: { id: "u1", role: "user", time: { created: T0 } },
          parts: [{ id: "cp", messageID: "u1", sessionID: sid, type: "compaction" }],
        },
        runningToolMsg("m1", "p1", T0),
      ]);
      setNow(T0 + 100);
      runStuckTick();
      setNow(T0 + 5_000);
      runStuckTick();
      assert.equal(marksOf(sid), undefined);
    });

    it("sessions this window never opened are skipped", () => {
      busySession("sk9"); // no transcript
      setNow(T0 + 100);
      runStuckTick();
      setNow(T0 + 5_000);
      runStuckTick();
      assert.equal(marksOf("sk9"), undefined);
    });
  });
});
