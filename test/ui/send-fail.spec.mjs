// A failed prompt POST is a take-back, not a send (src/webview/app/store.ts
// postPrompt's !sent.ok branch): the optimistic "pending:" echo drops off
// the transcript, and the composer gets the whole draft back — previously
// the echo stayed as fake sent content and the text was lost. The banner
// names the relay's reason; the next send clears it at submit and goes
// through, its scripted turn landing the durable user row (v1 retires the
// echo as message.updated seeds the row's text from it). Drives the rig's
// /__control/fail-next-prompt: a one-shot 500 on the next prompt POST,
// normal behavior after. No reload, no navigation.
import { test, expect } from "@playwright/test";
import { startRig } from "./support/rig.mjs";

test("a failed send takes the message back and the retry goes through", async ({ page }) => {
  const rig = await startRig({
    env: {
      OPENCODE_ROUTE: JSON.stringify({ view: "session", id: "ses_seed_1" }),
      OPENCODE_TABS: JSON.stringify(["ses_seed_1"]),
      OPENCODE_READY_SOUND: "0",
      OPENCODE_PERMISSION_SOUND: "0",
      OPENCODE_QUESTION_SOUND: "0",
    },
  });
  try {
    await page.goto(rig.url);
    await page.waitForSelector(".msgs .turn .msg.user", { timeout: 15_000 });
    const TEXT = "the send that fails";
    const baseline = await page.locator(".turn .msg.user").count();

    // Arm the one-shot failure BEFORE sending.
    await fetch(`${rig.api}/__control/fail-next-prompt`, { method: "POST" });
    await page.fill(".composer textarea", TEXT);
    await page.click(".comp-send");

    // The banner carries the reason the relay extracted; the transcript
    // gains nothing (the echo dropped); the text is back in the composer.
    await expect(page.locator(".send-error")).toHaveText(
      "The message could not be sent: HTTP 500: Internal error.",
    );
    await expect(page.locator(".turn .msg.user")).toHaveCount(baseline);
    await expect(page.locator(".msgs")).not.toContainText(TEXT);
    await expect(page.locator(".composer textarea")).toHaveValue(TEXT);

    // The retry (the flag is consumed) clears the banner at submit and
    // empties the composer; the durable user row lands with the text.
    await page.click(".comp-send");
    await expect(page.locator(".send-error")).toHaveCount(0);
    await expect(page.locator(".composer textarea")).toHaveValue("");
    // Settle the scripted turn first: past idle, a user bubble with the
    // text can only be the durable row (the echo retired long before).
    await expect
      .poll(
        async () =>
          (await (await fetch(`${rig.api}/__control/status`)).json()).streaming,
        { timeout: 30_000, intervals: [250] },
      )
      .toBe(false);
    await expect(page.locator(".turn .msg.user")).toHaveCount(baseline + 1);
    await expect(page.locator(".turn .msg.user").last()).toContainText(TEXT);
  } finally {
    rig.stop();
  }
});
