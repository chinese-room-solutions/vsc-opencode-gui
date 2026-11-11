// Another session's ask must not close this tab's open popover. The dock
// effect read the global pending lists unfiltered, so any session's
// permission ask slammed the model picker shut mid-choice. Drives the
// fake-API rig's /__control/ask, which emits the v2 permission.asked
// envelope (the shape v2events maps onto the dock) for a session the spec
// picks — another one first, then this tab's, which must still close it.
import { test, expect } from "@playwright/test";
import { startRig } from "./support/rig.mjs";

const ask = (rig, sessionID) =>
  fetch(`${rig.api}/__control/ask`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionID }),
  });

test("another session's ask leaves this tab's popovers open", async ({ page }) => {
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
    await page.click('.comp-chip[title="Model"]');
    const picker = page.locator(".pop-model");
    await expect(picker).toBeVisible();
    // A different session's ask docks nowhere in this view, so the picker
    // must ride the frame out.
    await ask(rig, "ses_other_1");
    await expect(page.locator(".docks")).toHaveCount(0);
    await page.waitForTimeout(500);
    await expect(picker).toBeVisible();
    // This session's ask docks — closing the picker stays the point.
    await ask(rig, "ses_seed_1");
    await expect(page.locator(".docks")).toHaveCount(1);
    await expect(picker).toHaveCount(0);
  } finally {
    rig.stop();
  }
});
