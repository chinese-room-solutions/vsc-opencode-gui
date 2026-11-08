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

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

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
    // The 5-line frame fits the clamp budget: no dissolve, no fold line.
    await expect(out).toHaveClass("shell-out clamped");
    await expect(card.locator(".clamp-toggle")).toHaveCount(0);
    // Still the same view — the card arrived on the SSE frame alone.
    await expect(page.locator(".msgs .turn").first()).toBeVisible();
  } finally {
    rig.stop();
  }
});

test("the shell card stays in flow — only the reader's own pill pins", async ({ page }) => {
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
    await fetch(`${rig.api}/__control/shell-note`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const card = page.locator(".shell-notice");
    await expect(card).toHaveCount(1);
    // The card rides a user-role row (the durable fetch serves notices as
    // user rows) and must stay in flow: pills are flow rows now, the pin
    // is the bar's — a finished card squatting at the panel's top over the
    // whole scroll.
    const pos = (loc) => loc.evaluate((n) => getComputedStyle(n).position);
    expect(await pos(card)).toBe("static");
    // Own pills are flow rows that anchor their hover chip (relative),
    // never the pin themselves.
    expect(await pos(page.locator(".turn .msg.user").first())).toBe("relative");
    // The session opens at the tail, where a pill already holds the pin;
    // scrolled back to the shell card's stretch, the docked pill is the
    // reader's own — the shell card never takes the pin.
    const bar = page.locator(".pin-bar .pin-mirror");
    await expect(bar).toBeVisible();
    await page.locator(".msgs").evaluate((n) => {
      n.scrollTop = n.scrollHeight;
    });
    await expect(bar).toContainText("Question");
    await expect(bar.locator(".shell-notice")).toHaveCount(0);
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

// A capture past the 5-line budget folds like a long user pill: dissolve
// mask on the last line, "Show more" under the box, and the toggle
// unfolds the whole dump into the transcript's flow ("Show less" back).
test("a long capture folds at five lines and Show more unfolds it", async ({ page }) => {
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
    await fetch(`${rig.api}/__control/shell-note`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lines: 40 }),
    });
    const card = page.locator(".shell-notice");
    await expect(card).toHaveCount(1);
    const out = card.locator(".shell-out");
    // The fold: clamped with the dissolve, the box shorter than its text.
    await expect(out).toHaveClass("shell-out clamped cut");
    const clipped = () =>
      out.evaluate((el) => el.scrollHeight > el.clientHeight + 1);
    expect(await clipped()).toBe(true);
    const toggle = card.locator(".clamp-toggle");
    await expect(toggle).toHaveText("Show more");

    // Unfolded: no cap in flow, the tail lines render, the toggle flips.
    await toggle.click();
    await expect(out).toHaveClass("shell-out expanded");
    await expect(toggle).toHaveText("Show less");
    expect(await clipped()).toBe(false);
    await expect(out).toContainText("long-capture line 40");

    // Refolded: back to the budget and the dissolve.
    await toggle.click();
    await expect(out).toHaveClass("shell-out clamped cut");
    await expect(toggle).toHaveText("Show more");
    expect(await clipped()).toBe(true);
  } finally {
    rig.stop();
  }
});

// The copy affordance rides the capture's top-right corner and copies the
// whole current frame — the 5-line clamp trims only the display, never the
// clipboard.
test("the shell card's copy button puts the full frame on the clipboard", async ({ page }) => {
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
    await fetch(`${rig.api}/__control/shell-note`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lines: 40 }),
    });
    const card = page.locator(".shell-notice");
    await expect(card).toHaveCount(1);
    await page.evaluate(() => navigator.clipboard.writeText("__none__"));
    await card.locator(".shell-out-copy").click();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toContain("long-capture line 40");
    expect(clip).not.toContain("__none__");
  } finally {
    rig.stop();
  }
});
