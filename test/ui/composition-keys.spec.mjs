// IME composition keys must not answer a pending ask: the keydown that
// commits or cancels a composition carries isComposing, and Chromium
// delivers it to the same handlers. A composing Enter on the dock's
// redirect input must not fire the reject reply, and a composing Escape
// must not dismiss — only the committed keys do. Playwright cannot set
// isComposing through the keyboard, so the composing keys arrive as raw
// dispatched events. v2 dialect like dock-keys.
import { test, expect } from "@playwright/test";
import { startRig } from "./support/rig.mjs";

const rigEnv = () => ({
  OPENCODE_ROUTE: JSON.stringify({ view: "session", id: "ses_seed_1" }),
  OPENCODE_TABS: JSON.stringify(["ses_seed_1"]),
  OPENCODE_DIALECT: "v2",
  OPENCODE_READY_SOUND: "0",
  OPENCODE_PERMISSION_SOUND: "0",
  OPENCODE_QUESTION_SOUND: "0",
});

const ask = (rig) =>
  fetch(`${rig.api}/__control/ask`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: "perm_rig1",
      action: "bash",
      resources: ["npm test"],
    }),
  });

const replies = async (rig) =>
  (await (await fetch(`${rig.api}/__control/perm-replies`)).json()).replies;

const composingKey = (page, key) =>
  page.evaluate((k) => {
    document
      .querySelector(".dock-input")
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: k, isComposing: true, bubbles: true }),
      );
  }, key);

test("a composing Enter leaves the permission dock alone; a real Enter answers it", async ({ page }) => {
  const rig = await startRig({ env: rigEnv() });
  try {
    await page.goto(rig.url);
    await page.waitForSelector(".msgs .turn .msg.user", { timeout: 15_000 });
    await ask(rig);
    const dock = page.locator('[data-testid="permission-dock"]');
    await expect(dock).toBeVisible();
    // Redirect text in the input: Enter would fire the reject reply with it.
    await page.fill(".dock-input", "do it another way");
    // The composition-cancelling Enter does nothing: the ask stays pending
    // and no reply left.
    await composingKey(page, "Enter");
    await page.waitForTimeout(300);
    await expect(dock).toBeVisible();
    expect(await replies(rig)).toEqual([]);
    // A composing Escape must not dismiss either (the input's handler drops
    // the ask as a plain reject).
    await composingKey(page, "Escape");
    await page.waitForTimeout(300);
    await expect(dock).toBeVisible();
    expect(await replies(rig)).toEqual([]);
    // The committed Enter answers: reject with the redirect message.
    await page.keyboard.press("Enter");
    await expect(dock).toHaveCount(0);
    await expect.poll(() => replies(rig)).toHaveLength(1);
    expect((await replies(rig))[0].decision).toBe("reject");
    expect((await replies(rig))[0].message).toBe("do it another way");
  } finally {
    rig.stop();
  }
});
