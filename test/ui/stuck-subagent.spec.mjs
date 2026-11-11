// The stuck watcher must not read "No progress" on a turn whose sub-agent
// still works: the chip spins on the CHILD session's status while the
// parent's task part can read as anything but "running" — a pending
// spawn, a backgrounded completion, or a running transition missed on an
// SSE gap — and on v2 a running part carries no child id at all (it rides
// only the ephemeral progress frame, never the durable row). Each flag
// seeds one shape (parent busy, child active in the status map), and
// OPENCODE_STUCK_TOOL bakes a 3s threshold so the false row would land
// well inside the wait.
import { test, expect } from "./support/fixture.mjs";
import { startRig } from "./support/rig.mjs";

for (const [shape, flag] of [
  ["a pending part bound to its child", "FAKE_API_CHILD_PENDING"],
  ["a running part with no child id", "FAKE_API_CHILD_UNBOUND"],
]) {
  test(`no stuck row under a spinning sub-agent chip: ${shape}`, async ({ page }) => {
    const rig = await startRig({
      env: {
        OPENCODE_ROUTE: JSON.stringify({ view: "session", id: "ses_seed_1" }),
        OPENCODE_TABS: JSON.stringify(["ses_seed_1"]),
        OPENCODE_DIALECT: "v2",
        OPENCODE_STUCK_TOOL: "3",
        OPENCODE_READY_SOUND: "0",
        OPENCODE_PERMISSION_SOUND: "0",
        OPENCODE_QUESTION_SOUND: "0",
        [flag]: "1",
      },
    });
    try {
      await page.goto(rig.url);
      // The chip spins on the child session's busy status — the same
      // signal the row must not ignore.
      const chip = page.locator(".subagent-chip").nth(0);
      await chip.waitFor({ timeout: 15_000 });
      await expect(chip).toHaveClass(/live/);
      // Past the 3s threshold plus ticks and margin: the false row fired
      // here before — a working child holds it off.
      await page.waitForTimeout(6_000);
      await expect(page.locator(".interrupted")).toHaveCount(0);
      await expect(chip).toHaveClass(/live/);
    } finally {
      rig.stop();
    }
  });
}
