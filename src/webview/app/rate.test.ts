import "./setup.test";
import { strict as assert } from "node:assert";
import {
  genMs,
  liveSample,
  overlapMs,
  toolBusyMs,
  type RateWindow,
} from "./rate";
import { charsPerToken } from "./store";
import type { ChatMessage } from "./store";
import type { Part } from "./api";

const textPart = (
  id: string,
  time?: { start?: number; end?: number },
): Part => ({
  id,
  messageID: "a1",
  sessionID: "s",
  type: "text",
  text: "answer",
  ...(time ? { time } : {}),
});

const toolPart = (
  id: string,
  time: { start?: number; end?: number },
): Part => ({
  id,
  messageID: "a1",
  sessionID: "s",
  type: "tool",
  tool: "bash",
  state: { status: "completed", time },
});

const msg = (parts: Part[], time: ChatMessage["info"]["time"]): ChatMessage[] => [
  { info: { id: "a1", role: "assistant", time }, parts },
];

describe("rate", () => {
  describe("overlapMs", () => {
    it("is zero for disjoint families", () => {
      assert.equal(overlapMs([[0, 1000]], [[2000, 3000]]), 0);
      assert.equal(
        overlapMs(
          [[0, 1000], [2000, 3000]],
          [[4000, 5000]],
        ),
        0,
      );
    });
    it("measures a partial overlap", () => {
      assert.equal(overlapMs([[0, 2000]], [[1000, 3000]]), 1000);
    });
    it("is the whole span for identical families (union identity)", () => {
      assert.equal(overlapMs([[0, 2000], [3000, 4000]], [[0, 2000], [3000, 4000]]), 3000);
    });
  });

  describe("genMs", () => {
    it("keeps a disjoint trailing tool out of the denominator (the collapse case)", () => {
      // [text 0-5s][tool 5-30s]: the old whole-union subtraction zeroed
      // the row and the caller's 1s floor read hundreds of tok/s.
      const msgs = msg(
        [
          textPart("t0", { start: 0, end: 5000 }),
          toolPart("c1", { start: 5000, end: 30000 }),
        ],
        { created: 0, completed: 30000 },
      );
      assert.equal(genMs(msgs, 31000), 5000);
    });
    it("subtracts a tool swallowed by an open text window", () => {
      // The text runs to the row's completion, so the tool sits inside it.
      const msgs = msg(
        [
          textPart("t0", { start: 0 }),
          toolPart("c1", { start: 10000, end: 20000 }),
        ],
        { created: 0, completed: 30000 },
      );
      assert.equal(genMs(msgs, 31000), 20000);
    });
    it("nets only the overlapping share in the fallback window", () => {
      const msgs = msg(
        [
          textPart("t0"),
          // Overlaps [streamed, completed] = [1000, 30000] by 10s only.
          toolPart("c1", { start: 20000, end: 40000 }),
        ],
        { created: 0, streamed: 1000, completed: 30000 },
      );
      assert.equal(genMs(msgs, 41000), 19000);
    });
  });

  describe("toolBusyMs", () => {
    it("extends a running tool to now", () => {
      const msgs = msg([toolPart("c1", { start: 1000 })], { created: 0 });
      assert.equal(toolBusyMs(msgs, 5000), 4000);
    });
  });

  describe("liveSample", () => {
    const win = (): RateWindow => ({ anchor: "a", hist: [], last: 0 });

    it("reads a steady ramp as its mean (unchanged)", () => {
      const w = win();
      let rate = 0;
      for (let i = 0; i <= 9; i++)
        rate = liveSample(w, { c: i * 100, b: 0, t: i * 1000 });
      // Full 8-sample window: 700 chars over 7s.
      assert.ok(Math.abs(rate - 100 / charsPerToken()) < 1e-9);
    });
    it("amortizes a delivered burst over the silence that produced it", () => {
      const w = win();
      liveSample(w, { c: 500, b: 0, t: 0 });
      for (let s = 1; s <= 29; s++)
        liveSample(w, { c: 500, b: 0, t: s * 1000 });
      const rate = liveSample(w, { c: 3500, b: 0, t: 30000 });
      // 3000 chars delivered after a 30s silent think: ~100 chars/s
      // amortized — not 3000 over the 7s window.
      assert.ok(Math.abs(rate - 100 / charsPerToken()) < 1e-9);
      assert.ok(rate < 3000 / charsPerToken() / 7 - 1);
    });
    it("reads post-burst streaming at its own pace, not the batch over 7s", () => {
      const w = win();
      liveSample(w, { c: 500, b: 0, t: 0 });
      for (let s = 1; s <= 29; s++)
        liveSample(w, { c: 500, b: 0, t: s * 1000 });
      liveSample(w, { c: 3500, b: 0, t: 30000 });
      // The window restarted at the burst: the next reading is the
      // fresh 100 chars/s ramp, not 3100 chars re-read over 7s.
      const after = liveSample(w, { c: 3600, b: 0, t: 31000 });
      assert.ok(Math.abs(after - 100 / charsPerToken()) < 1e-9);
    });
    it("holds the pace through a tool run, then bills the batch to the silence net of tool time", () => {
      const w = win();
      // 100 chars/s for 3s, then a 30s tool: chars flat, busy climbing.
      for (let i = 0; i <= 2; i++)
        liveSample(w, { c: (i + 1) * 100, b: 0, t: i * 1000 });
      for (let s = 3; s <= 32; s++) {
        const held = liveSample(w, {
          c: 300,
          b: Math.min(30_000, Math.max(0, s * 1000 - 2000)),
          t: s * 1000,
        });
        assert.ok(Math.abs(held - 100 / charsPerToken()) < 1e-9);
      }
      assert.ok(w.idle !== undefined);
      // 3000 chars resume after a silence that was entirely tool time:
      // none of it produced them, so the denominator floors at 1s.
      const rate = liveSample(w, { c: 3300, b: 30_000, t: 33_000 });
      assert.ok(Math.abs(rate - 3000 / charsPerToken()) < 1e-9);
    });
    it("leaves the pace untouched when a tool streams in parallel with text", () => {
      // The old formula subtracted the busy seconds the same streaming
      // used, reading 700 chars over 1s instead of 7s.
      const w = win();
      let rate = 0;
      for (let i = 0; i <= 9; i++)
        rate = liveSample(w, { c: i * 100, b: i * 1000, t: i * 1000 });
      assert.ok(Math.abs(rate - 100 / charsPerToken()) < 1e-9);
    });
    it("holds instead of sagging through a tool-call emission gap", () => {
      // The model writes the call: no text chars, no tool busy yet.
      // Those seconds are not production — the old window mean divided
      // the surviving chars by them and drooped toward zero.
      const w = win();
      for (let i = 0; i <= 8; i++)
        liveSample(w, { c: i * 100, b: 0, t: i * 1000 });
      let held = 0;
      for (let s = 9; s <= 11; s++)
        held = liveSample(w, { c: 800, b: 0, t: s * 1000 });
      assert.ok(Math.abs(held - 100 / charsPerToken()) < 1e-9);
    });
    it("never anchors on pre-first-token silence", () => {
      const w = win();
      liveSample(w, { c: 0, b: 0, t: 0 });
      liveSample(w, { c: 0, b: 0, t: 1000 });
      liveSample(w, { c: 50, b: 0, t: 2000 });
      assert.equal(w.idle, undefined);
    });
  });
});
