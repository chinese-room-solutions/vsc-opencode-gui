// The skill row's pill: whichever of the three name carriers the part
// holds (streamed args, result metadata, settled title) - the live frame
// may carry only the metadata (a provider that never streams tool args).
import assert from "node:assert/strict";
import { childSessionId, summary } from "./ToolCard";
import type { ToolPart, ToolState } from "../api";

const skill = (state: ToolState): ToolPart => ({
  id: "p1",
  messageID: "m1",
  sessionID: "s1",
  type: "tool",
  tool: "skill",
  state,
});

describe("skill row pill", () => {
  it("names the skill from the streamed args", () => {
    assert.equal(summary(skill({ status: "completed", input: { name: "concise" } })), "concise");
  });
  it("names the skill from the result metadata when args never streamed", () => {
    assert.equal(
      summary(
        skill({
          status: "completed",
          metadata: { name: "concise", dir: "C:\\skills\\concise" },
        }),
      ),
      "concise",
    );
  });
  it("prefers the bare name over the verbose settled title", () => {
    assert.equal(
      summary(
        skill({
          status: "completed",
          input: { name: "concise" },
          title: "Loaded skill: concise",
        }),
      ),
      "concise",
    );
  });
  it("falls back to the title alone", () => {
    assert.equal(
      summary(skill({ status: "completed", title: "Loaded skill: concise" })),
      "Loaded skill: concise",
    );
  });
  it("stays empty when the part carries no name at all", () => {
    assert.equal(summary(skill({ status: "running" })), "");
  });
});

const task = (metadata?: Record<string, unknown>): ToolPart => ({
  id: "p1",
  messageID: "m1",
  sessionID: "s1",
  type: "tool",
  tool: "task",
  state: { status: "running", metadata },
});

describe("subagent chip child binding", () => {
  it("binds v1's task-tool sessionId metadata", () => {
    assert.equal(childSessionId(task({ sessionId: "ses_a" }), "d"), "ses_a");
  });
  it("binds v2's subagent-tool sessionID metadata", () => {
    assert.equal(childSessionId(task({ sessionID: "ses_b" }), "d"), "ses_b");
  });
  it("prefers the v1 key when both ride along", () => {
    assert.equal(
      childSessionId(task({ sessionId: "ses_a", sessionID: "ses_b" }), "d"),
      "ses_a",
    );
  });
});
