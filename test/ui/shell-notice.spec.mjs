// Shell lifecycle notes must render as a card, not leak: the server reports
// a shell run's terminal state as a synthetic whose text wraps the captured
// bytes in a <shell …> tag (metadata.source "shell"), and its restart note
// (metadata.notice "restart") is model-facing instruction text. Before the
// tag was recognized both landed as markdown assistant rows — raw markup in
// the transcript, and a repaint tool's stacked frames (gh run watch
// reprints the whole screen per refresh) parsed into duplicated bullet
// lists. Drives the fake-API rig's /__control/shell-note, which emits the
// wire shapes captured from a real serve. No reload, no navigation.
import { test, expect } from "@playwright/test";
import { startRig } from "./support/rig.mjs";

test("a shell lifecycle note renders as a card with the last frame only", async ({ page }) => {
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
    await expect(page.locator(".shell-notice")).toHaveCount(0);
    await fetch(`${rig.api}/__control/shell-note`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const card = page.locator(".shell-notice");
    await expect(card).toHaveCount(1);
    // The header names the outcome and the command; no raw markup leaks.
    await expect(card.locator(".notice-title")).toContainText(
      "Shell finished · gh run watch 41234939455 --exit-status",
    );
    await expect(card).not.toContainText("<shell");
    // The captured bytes render verbatim (no markdown bullet soup), and the
    // earlier repaint frame drops: only the current frame's step state shows.
    const out = card.locator(".shell-out");
    await expect(out).toHaveCount(1);
    await expect(out).toContainText("✓ Run npm ci");
    await expect(out).not.toContainText("* Run npm ci");
    // Still the same view — the card arrived on the SSE frame alone.
    await expect(page.locator(".msgs .turn").first()).toBeVisible();
  } finally {
    rig.stop();
  }
});

test("the server's restart note renders as one quiet line", async ({ page }) => {
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
    await expect(page.locator(".restart-note")).toHaveCount(0);
    await fetch(`${rig.api}/__control/shell-note`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "restart" }),
    });
    const note = page.locator(".restart-note");
    await expect(note).toHaveCount(1);
    await expect(note.locator(".notice-title")).toContainText("Server restarted");
    // The model-facing instruction text is not transcript content.
    await expect(note).not.toContainText("Continue from where you left off");
  } finally {
    rig.stop();
  }
});
