// A turn that dies without terminal tool events (an interrupt racing the
// tool, a server restart) leaves its bash row durably "running" while the
// status endpoints serve the session idle — the fingerprint recovered from
// a real 2.0.26 store. The UI must read that row as settled: no running
// dot, no elapsed tip, a send composer, and no re-animation (running
// visuals, a 15-minute clock) when the next prompt flips the session busy.
import { test, expect } from "./support/fixture.mjs";
import { startRig } from "./support/rig.mjs";

const ENV = {
  OPENCODE_ROUTE: JSON.stringify({ view: "session", id: "ses_seed_1" }),
  OPENCODE_TABS: JSON.stringify(["ses_seed_1"]),
  OPENCODE_DIALECT: "v2",
  OPENCODE_READY_SOUND: "0",
  OPENCODE_PERMISSION_SOUND: "0",
  OPENCODE_QUESTION_SOUND: "0",
  FAKE_API_GHOST: "1",
};

const cardBy = (page, pill) =>
  page.locator(".tool").filter({
    has: page.locator(".tool-pill", { hasText: pill }),
  });

// Every visible clock must read small: the ghost part's stamps sit 15
// minutes back, so any clock anchored on them shows "15m".
async function expectNoStaleClock(page) {
  const stats = await page.locator(".status-stats").allTextContents();
  for (const s of stats) {
    const m = s.match(/(\d+)m/);
    if (m) expect(Number(m[1]), `clock ${s}`).toBeLessThan(2);
  }
}

test("a dead turn's running row reads settled and never re-animates", async ({ page }) => {
  const rig = await startRig({ env: ENV });
  try {
    await page.goto(rig.url);
    const card = cardBy(page, "npm run watch");
    await expect(card).toHaveCount(1, { timeout: 15_000 });
    await expect(card.locator(".tool-dot")).not.toHaveClass(/running/);
    // No hover elapsed: the row is not running, so the tip stays absent.
    await expect(card.locator(".tool-row")).not.toHaveAttribute("data-tip");
    // Idle truth: the composer offers Send, not Stop.
    await expect(page.locator(".comp-send")).toHaveAttribute("title", "Send");
    await expectNoStaleClock(page);
    await page.screenshot({ path: "test-results/ghost-idle.png" });

    // The next prompt flips the session busy (optimistic): the dead row
    // must not come back to life off its 15-minute-old stamps.
    await page.fill(".composer textarea", "anyone there");
    await page.press(".composer textarea", "Enter");
    await page.waitForTimeout(3_000);
    await expect(card.locator(".tool-dot")).not.toHaveClass(/running/);
    await expect(card.locator(".tool-row")).not.toHaveAttribute("data-tip");
    await expectNoStaleClock(page);
    await page.screenshot({ path: "test-results/ghost-after-send.png" });
  } finally {
    rig.stop();
  }
});
