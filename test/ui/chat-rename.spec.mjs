// The chat's right-click Rename… defers to the host command — the tab
// menu's top input box (AppHost posts opencodeGui.renameSession) — and the
// inline rename field in the chat head is gone. Standalone there is no
// host, so the post is a no-op: the menu must close and no field may
// appear where the old one rendered synchronously.
import { test, expect } from "@playwright/test";
import { startRig } from "./support/rig.mjs";

test("the chat's Rename… opens no inline field", async ({ page }) => {
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
    await page.waitForSelector(".msgs .turn .msg.user", { timeout: 15_000 });
    await page
      .locator(".msgs .turn .msg.user")
      .first()
      .click({ button: "right" });
    const menu = page.locator(".row-menu");
    await expect(menu).toBeVisible();
    await menu.locator('.menu-item:has-text("Rename")').click();
    await expect(menu).toHaveCount(0);
    await expect(page.locator(".chat-head .rename-input")).toHaveCount(0);
  } finally {
    rig.stop();
  }
});
