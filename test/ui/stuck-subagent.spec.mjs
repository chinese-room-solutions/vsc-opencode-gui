// The stuck watcher must not read "No progress" on a turn whose sub-agent
// still works: the chip spins on the CHILD session's status while the
// parent's task part can read as anything but "running" — a pending
// spawn, a backgrounded completion, or a running transition missed on an
// SSE gap. FAKE_API_CHILD_PENDING seeds that shape (parent busy, task
// part pending with its child bound, child active in the status map) and
// OPENCODE_STUCK_TOOL bakes a 3s threshold so the false row would land
// well inside the wait.
import { test, expect } from "./support/fixture.mjs";
import { startRig } from "./support/rig.mjs";

test("no stuck row under a spinning sub-agent chip", async ({ page }) => {
  const rig = await startRig({
    env: {
      OPENCODE_ROUTE: JSON.stringify({ view: "session", id: "ses_seed_1" }),
      OPENCODE_TABS: JSON.stringify(["ses_seed_1"]),
      OPENCODE_DIALECT: "v2",
      OPENCODE_STUCK_TOOL: "3",
      OPENCODE_READY_SOUND: "0",
      OPENCODE_PERMISSION_SOUND: "0",
      OPENCODE_QUESTION_SOUND: "0",
      FAKE_API_CHILD_PENDING: "1",
    },
  });
  try {
    await page.goto(rig.url);
    // The chip spins: its part is pending, but the child session works
    // (the status map's busy) — the same signal the row must not ignore.
    const chip = page.locator(".subagent-chip").nth(0);
    await chip.waitFor({ timeout: 15_000 });
    await expect(chip).toHaveClass(/live/);
    // Past the 3s threshold plus ticks and margin: the turn mark fired
    // here before — a working child holds it off.
    await page.waitForTimeout(6_000);
    await expect(page.locator(".interrupted")).toHaveCount(0);
    await expect(chip).toHaveClass(/live/);
  } finally {
    rig.stop();
  }
});
