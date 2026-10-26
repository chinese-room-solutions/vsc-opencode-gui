// An inbound peer message must render in the OPEN transcript immediately —
// the 2.1 server publishes the injection as session.inbox.enqueued (no
// session.synthetic event exists), and before that envelope was translated
// the card only appeared after switching sessions (the refetch path). Drives
// the fake-API rig's /__control/peer-note, which emits the envelope captured
// live from a real serve. No reload, no navigation: the card must arrive on
// the SSE frame alone.
import { test, expect } from "@playwright/test";
import { startRig } from "./support/rig.mjs";

test("an inbound peer note renders live in the open transcript", async ({ page }) => {
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
    // Not openSession: its at-bottom settle (≤3px) is flaky at this
    // transcript height and this spec doesn't test scrolling.
    await page.goto(rig.url);
    await page.waitForSelector(".msgs .turn .msg.user", { timeout: 15_000 });
    await expect(page.locator(".msg.user.peer")).toHaveCount(0);
    await fetch(`${rig.api}/__control/peer-note`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Live ping from the peer session." }),
    });
    const card = page.locator(".msg.user.peer");
    await expect(card).toHaveCount(1);
    await expect(card).toContainText("Live ping from the peer session.");
    // Unaddressed provenance: the header names the sender endpoint id.
    await expect(card).toContainText("ses_fakesender0000000000000");
    // Still the same view — no reload or session switch happened.
    await expect(page.locator(".msgs .turn").first()).toBeVisible();
  } finally {
    rig.stop();
  }
});
