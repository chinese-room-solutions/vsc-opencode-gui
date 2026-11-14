// A prompt sent onto a running turn waits in the server's inbox until the
// next step boundary: 2.x admits it (the POST replies the row) but writes
// its message row only at delivery. The bubble must hold for the whole
// wait, however long the running step takes, through the delivery, and
// across a reload. The page clock stands in for the minute of waiting.
import { test, expect } from "@playwright/test";
import { startRig } from "./support/rig.mjs";
import { openSession } from "./support/fixture.mjs";

const TEXT = "Steer: rename the helper once the edit lands.";

const rigEnv = () => ({
  OPENCODE_ROUTE: JSON.stringify({ view: "session", id: "ses_seed_1" }),
  OPENCODE_TABS: JSON.stringify(["ses_seed_1"]),
  OPENCODE_DIALECT: "v2",
  OPENCODE_READY_SOUND: "0",
  OPENCODE_PERMISSION_SOUND: "0",
  OPENCODE_QUESTION_SOUND: "0",
  // A turn mid-tool that never ends on its own: the session reads busy.
  FAKE_API_STALLED: "1",
  FAKE_API_INBOX: "1",
});

// Every bubble count seen over `ms` of test time, sampled at 100ms.
async function counts(locator, ms) {
  const seen = new Set();
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    seen.add(await locator.count());
    await new Promise((r) => setTimeout(r, 100));
  }
  return [...seen];
}

// The pull a webview turning visible again runs (resyncFromServer).
const resync = (page) =>
  page.evaluate(() => window.postMessage({ type: "resync" }, "*"));

// Steer, then give the POST reply a beat to land its admitted row in place
// of the echo (the DOM shows the same bubble either way).
async function steer(page, rig) {
  await page.fill(".composer textarea", TEXT);
  await page.getByRole("button", { name: "Send" }).click();
  await expect
    .poll(async () => (await (await fetch(`${rig.api}/__control/prompts`)).json()).calls.length)
    .toBe(1);
  await new Promise((r) => setTimeout(r, 500));
}

test("a steer held past a minute keeps its bubble through delivery", async ({ page }) => {
  const rig = await startRig({ env: rigEnv() });
  try {
    await page.clock.install();
    await openSession(page, rig.url);
    await steer(page, rig);
    const bubble = page.locator(".turn .msg.user", { hasText: TEXT });
    await expect(bubble).toHaveCount(1);
    // A minute and change in the inbox, then a pull (the busy poll's 30s
    // tick comes due in the same jump).
    await page.clock.fastForward(61_000);
    await resync(page);
    expect(await counts(bubble, 1500)).toEqual([1]);
    // The step boundary: the server delivers it and the model starts
    // answering. The next pull serves the delivered row.
    await fetch(`${rig.api}/__control/deliver-inbox`, { method: "POST" });
    expect(await counts(bubble, 1500)).toEqual([1]);
    await page.clock.fastForward(6_000);
    await resync(page);
    expect(await counts(bubble, 1500)).toEqual([1]);
  } finally {
    rig.stop();
  }
});

test("a reload mid-wait brings the held steer back", async ({ page }) => {
  const rig = await startRig({ env: rigEnv() });
  try {
    await openSession(page, rig.url);
    await steer(page, rig);
    await page.reload();
    await page.waitForSelector(".msgs .turn .msg.user", { timeout: 15_000 });
    await expect(page.locator(".turn .msg.user", { hasText: TEXT })).toHaveCount(1);
  } finally {
    rig.stop();
  }
});
