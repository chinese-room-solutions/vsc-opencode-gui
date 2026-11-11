// The context ring's calibration anchors: the base comes only from a
// provable anchor — the first measured turn after the newest fold, or the
// session's actual start (no older pages outstanding). A window's first
// measured row mid-conversation counts every prior turn as input, so
// anchoring there read the whole history as base and kept the post-compact
// estimate near the old size. A truncated window without a fold
// calibrates nothing and the estimates fall back.
import assert from "node:assert/strict";
import { contextBase, foldFreedTokens } from "./ContextRing";
import { messagesCursor } from "../store";
import type { ChatMessage } from "../store";
import type { Message, MessageTokens } from "../api";

const tok = (over: Partial<MessageTokens> = {}): MessageTokens => ({
  input: 0,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
  ...over,
});

function row(
  id: string,
  role: "user" | "assistant",
  created: number,
  over: Partial<Message> = {},
  text = "",
): ChatMessage {
  const parts = text
    ? [{ id: `p_${id}`, messageID: id, sessionID: "s", type: "text" as const, text }]
    : [];
  return { info: { id, role, time: { created }, ...over }, parts };
}

// hasOlder reads the cursor: absent or undefined = the transcript is
// complete, a string = older pages outstanding.
function truncated(id: string): void {
  messagesCursor.value = new Map([...messagesCursor.value, [id, "cursor"]]);
}

describe("context ring calibration anchors", () => {
  it("a fold anchors the first measured turn after it, summary and user rows subtracted", () => {
    const list = [
      row("u1", "user", 100, {}, "everything before the fold"),
      row("a1", "assistant", 200, { tokens: tok({ input: 50000 }) }),
      row("f1", "assistant", 300, {
        agent: "compaction",
        tokens: tok({ output: 2000 }),
      }),
      row("u2", "user", 400, {}, "x".repeat(400)),
      row("a2", "assistant", 500, {
        tokens: tok({ input: 3000, cache: { read: 200, write: 0 } }),
      }),
    ];
    // anchor prompt side 3200 − summary 2000 − user chars 400/4
    assert.equal(contextBase("cr_fold_1", list), 1100);
  });

  it("a truncated window without a fold calibrates nothing", () => {
    truncated("cr_trunc_1");
    const list = [
      row("u1", "user", 100, {}, "old"),
      row("a1", "assistant", 200, { tokens: tok({ input: 50000 }) }),
    ];
    assert.equal(contextBase("cr_trunc_1", list), 0);
  });

  it("without a base the freed-tokens label reports the pre-compact total", () => {
    truncated("cr_trunc_2");
    const before = [
      row("u1", "user", 100, {}, "old"),
      row("a1", "assistant", 200, { tokens: tok({ input: 8000, output: 500 }) }),
    ];
    const fold = [
      row("f1", "assistant", 300, {
        agent: "compaction",
        tokens: tok({ output: 100 }),
      }),
    ];
    assert.equal(foldFreedTokens("cr_trunc_2", before, fold), 8500);
  });

  it("a full session keeps the first-measured-turn calibration", () => {
    const list = [
      row("u1", "user", 100, {}, "hello".repeat(40)),
      row("a1", "assistant", 200, { tokens: tok({ input: 1000 }) }),
    ];
    // 1000 − 200 chars/4
    assert.equal(contextBase("cr_full_1", list), 950);
  });

  it("an earlier fold makes the freed-tokens estimate use the post-fold base", () => {
    const before = [
      row("u1", "user", 100, {}, "early"),
      row("a1", "assistant", 200, { tokens: tok({ input: 50000 }) }),
      row("f0", "assistant", 250, {
        agent: "compaction",
        tokens: tok({ output: 1000 }),
      }),
      row("a2", "assistant", 300, { tokens: tok({ input: 3000 }) }),
    ];
    const fold = [
      row("f1", "assistant", 400, {
        agent: "compaction",
        tokens: tok({ output: 900 }),
      }),
    ];
    // pre = a2 (the last measured, already post-fold) 3000, base = a2 3000
    // − f0 summary 1000 = 2000, freed = 3000 − 2000 − 900
    assert.equal(foldFreedTokens("cr_fold_2", before, fold), 100);
  });
});
