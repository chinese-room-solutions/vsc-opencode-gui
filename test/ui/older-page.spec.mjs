// The v2 transcript pages from the server — 50 newest rows per fetch,
// the rest behind "Load older messages" and its cursor walk. A refresh
// (the 30s busy poll, a reconnect's resync, a remount) re-fetches the
// newest page: rows the reader already expanded into view must survive
// it, or hours of history collapse back to the newest page mid-read.
// FAKE_API_LONG seeds 60 turns; /__control/ssedrop forces the
// drop→connect cycle whose resync re-pulls messages.
import { test, expect } from "./support/fixture.mjs";
import { startRig } from "./support/rig.mjs";

const ENV = {
  OPENCODE_ROUTE: JSON.stringify({ view: "session", id: "ses_seed_1" }),
  OPENCODE_TABS: JSON.stringify(["ses_seed_1"]),
  OPENCODE_DIALECT: "v2",
  OPENCODE_READY_SOUND: "0",
  OPENCODE_PERMISSION_SOUND: "0",
  OPENCODE_QUESTION_SOUND: "0",
  FAKE_API_LONG: "1",
};

test("an expanded transcript survives a reconnect refresh", async ({ page }) => {
  const rig = await startRig({ env: ENV });
  try {
    await page.goto(rig.url);
    // Windowed open: the newest page serves, the oldest turn hides behind
    // the button.
    await expect(page.locator(".load-older")).toHaveCount(1);
    await expect(page.getByText("Question 1:")).toHaveCount(0);

    // Walk older rows: click until the transcript's first turn is on
    // screen (120+ rows need two 100-row pages).
    for (let i = 0; i < 5; i++) {
      await page.locator(".load-older").click();
      if ((await page.getByText("Question 1:").count()) > 0) break;
    }
    await expect(page.getByText("Question 1:")).toBeVisible();
    await expect(page.getByText("Question 60:")).toBeVisible();

    // Drop the SSE stream; the reconnect resync re-pulls server truth.
    await fetch(`${rig.api}/__control/ssedrop`);
    await page.waitForTimeout(3_000);

    // The expansion must survive the re-pull.
    await expect(page.getByText("Question 1:")).toBeVisible();
    await expect(page.getByText("Question 60:")).toBeVisible();
  } finally {
    rig.stop();
  }
});
