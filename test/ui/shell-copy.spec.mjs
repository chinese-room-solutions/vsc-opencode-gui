// A shell card's command is one click away without expanding: a copy
// button rides the card's top-right corner like a code block's. The
// pill clips the command to one line, so selection isn't a substitute.
// Clipboard readback isn't assertable in the rig (permissions) — the
// check-flip is the receipt, as in the other copy specs.
import { test, expect } from "./support/fixture.mjs";
import { startRig } from "./support/rig.mjs";

test("a shell card copies its command from the header", async ({ page }) => {
  const rig = await startRig({
    env: {
      OPENCODE_ROUTE: JSON.stringify({ view: "session", id: "ses_seed_1" }),
      OPENCODE_TABS: JSON.stringify(["ses_seed_1"]),
      OPENCODE_DIALECT: "v2",
      OPENCODE_READY_SOUND: "0",
      OPENCODE_PERMISSION_SOUND: "0",
      OPENCODE_QUESTION_SOUND: "0",
    },
  });
  try {
    await page.goto(rig.url);
    // The seeded bash card (pt_tbash): "Shell" + the npm run compile pill.
    const card = page
      .locator(".tool")
      .filter({ hasText: "npm run compile" })
      .first();
    const btn = card.locator(".tool-head-copy");
    await btn.waitFor({ timeout: 15_000 });
    // Copies without expanding the body.
    await btn.click();
    await expect(btn).toHaveClass(/done/);
    await expect(card.locator(".tool-body")).toHaveCount(0);
    // The body's own IN/OUT copies are unchanged once expanded.
    await card.locator(".tool-row").click();
    await expect(card.locator(".tool-body .tool-copy")).toHaveCount(2);
    // Non-shell cards keep their header bare (no command to copy).
    await expect(
      page.locator(".tool").filter({ hasText: "src/main.ts" }).first().locator(".tool-head-copy"),
    ).toHaveCount(0);
  } finally {
    rig.stop();
  }
});
