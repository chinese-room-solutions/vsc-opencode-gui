// The roster counts sub-agents, not task parts. FAKE_API_DUP_CHILD seeds
// two live task parts bound to the SAME child session — the wire shape a
// steer re-opening a child leaves (or the title fallback double-binding
// same-labeled spawns) — and the menu must list that child once: one
// badge count, one row, one chip.
import { test, expect } from "./support/fixture.mjs";
import { startRig } from "./support/rig.mjs";

test("the roster lists a twice-bound child session once", async ({ page }) => {
  const rig = await startRig({
    env: {
      OPENCODE_ROUTE: JSON.stringify({ view: "session", id: "ses_seed_1" }),
      OPENCODE_TABS: JSON.stringify(["ses_seed_1"]),
      OPENCODE_DIALECT: "v2",
      OPENCODE_READY_SOUND: "0",
      OPENCODE_PERMISSION_SOUND: "0",
      OPENCODE_QUESTION_SOUND: "0",
      FAKE_API_DUP_CHILD: "1",
    },
  });
  try {
    await page.goto(rig.url);
    const btn = page.locator(".sam-btn");
    await btn.waitFor({ timeout: 15_000 });
    await expect(btn.locator(".sam-count")).toHaveText("1");
    await btn.click();
    await expect(page.locator(".sam-row")).toHaveCount(1);
    await expect(page.locator(".sam-menu .subagent-chip")).toHaveCount(1);
  } finally {
    rig.stop();
  }
});
