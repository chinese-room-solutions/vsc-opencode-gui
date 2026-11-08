// The prompt pin: one bar at the scroller's top docks the reader's last
// own pill that scrolled past, through peer- and notice-led turns, until
// the next own pill crosses the edge. Pills are plain flow rows — the old
// per-pill sticky was bounded by its turn's box and emptied the slot for
// any turn led by a notice card. These specs hold the bar's contract:
// dock and hand-off, release on the way back up, notice cards never
// docking, the expanded pill docking as its clamped twin, the click-jump
// back, and no reserved gap at the origin.
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

test("the bar docks the last own pill and hands off down the turns", async ({ page }) => {
  const rig = await startRig({ env: rigEnv() });
  try {
    await page.goto(rig.url);
    await page.waitForSelector(".msgs .turn .msg.user", { timeout: 15_000 });
    const msgs = page.locator(".msgs");
    const bar = page.locator(".pin-bar .pin-mirror");
    // Mid-transcript: some pill owns the pin.
    await msgs.evaluate((n) => {
      n.scrollTop = n.scrollHeight / 2;
    });
    await expect(bar).toBeVisible();
    await expect(bar).toContainText("Question ");
    const mid = await bar.textContent();
    // The tail: the last own pill that scrolled past takes over — the
    // hand-off. (Turn 12's own pill is still in view at this tail: its
    // short turn has not crossed the edge, so 11 holds the pin.)
    await msgs.evaluate((n) => {
      n.scrollTop = n.scrollHeight;
    });
    await expect(bar).toContainText("Question 11:");
    expect(await bar.textContent()).not.toBe(mid);
    // The twin sits pinned at the scroller's top edge.
    const tops = await bar.evaluate((n) => {
      const sc = n.closest(".msgs");
      return {
        bar: n.getBoundingClientRect().top,
        sc: sc.getBoundingClientRect().top,
      };
    });
    expect(Math.abs(tops.bar - tops.sc)).toBeLessThanOrEqual(1);
  } finally {
    rig.stop();
  }
});

test("scrolling back releases the dock; the origin holds no gap", async ({ page }) => {
  const rig = await startRig({ env: rigEnv() });
  try {
    await page.goto(rig.url);
    await page.waitForSelector(".msgs .turn .msg.user", { timeout: 15_000 });
    const msgs = page.locator(".msgs");
    await msgs.evaluate((n) => {
      n.scrollTop = n.scrollHeight;
    });
    await expect(page.locator(".pin-bar .pin-mirror")).toBeVisible();
    // Back at the origin nothing has scrolled past: no pin, and no layout
    // space reserved for it (the first turn sits at the scroller's top,
    // clear of the 4px spacer alone).
    await msgs.evaluate((n) => {
      n.scrollTop = 0;
    });
    await expect(page.locator(".pin-bar")).toHaveCount(0);
    const gap = await msgs.evaluate((n) => {
      const turn = n.querySelector(".turn");
      return turn.getBoundingClientRect().top - n.getBoundingClientRect().top;
    });
    expect(gap).toBeLessThanOrEqual(5);
  } finally {
    rig.stop();
  }
});

test("a peer card never docks; the own pill holds the pin through it", async ({ page }) => {
  const rig = await startRig({ env: rigEnv() });
  try {
    await page.goto(rig.url);
    await page.waitForSelector(".msgs .turn .msg.user", { timeout: 15_000 });
    // A live peer note joins the open (last) turn as an assistant row —
    // under the ruling it must stay in flow, never taking the pin.
    await fetch(`${rig.api}/__control/peer-note`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Dock attempt from a peer session." }),
    });
    const card = page.locator(".msg.user.peer");
    await expect(card).toHaveCount(1);
    await page.locator(".msgs").evaluate((n) => {
      n.scrollTop = n.scrollHeight;
    });
    const bar = page.locator(".pin-bar .pin-mirror");
    await expect(bar).toBeVisible();
    await expect(bar).toContainText("Question 12:");
    await expect(bar).not.toContainText("Dock attempt");
    expect(
      await card.evaluate((n) => getComputedStyle(n).position),
    ).toBe("static");
  } finally {
    rig.stop();
  }
});

test("an expanded pill docks as its clamped twin", async ({ page }) => {
  const rig = await startRig({ env: rigEnv() });
  try {
    await page.goto(rig.url);
    await page.waitForSelector(".msgs .turn .msg.user", { timeout: 15_000 });
    // Turn 2's prompt is the long one. Expanding it jumps it to the top
    // (reading mode, in view); nudging past docks the pin — as the folded
    // form: the twin is a header, the reading surface is the real pill.
    const pill = page.locator(".turn .msg.user", { hasText: "Question 2:" }).first();
    await pill.locator(".clamp-toggle").click();
    await expect(pill.locator(".user-text.expanded")).toBeVisible();
    const msgs = page.locator(".msgs");
    await msgs.evaluate((n) => {
      n.scrollTop += 30;
    });
    const bar = page.locator(".pin-bar .pin-mirror");
    await expect(bar).toBeVisible();
    await expect(bar).toContainText("Question 2:");
    // The decision, pinned: uniform docking — clamped twin, no toggle, no
    // actions. The affordances live on the real pill the click jumps to.
    const twin = bar.locator(".user-text");
    await expect(twin).toHaveClass(/clamped/);
    await expect(twin).not.toHaveClass(/expanded/);
    await expect(bar.locator(".clamp-toggle")).toHaveCount(0);
    await expect(bar.locator(".msg-actions")).toHaveCount(0);
  } finally {
    rig.stop();
  }
});

test("the successor's arrival pushes the pinned twin out", async ({ page }) => {
  const rig = await startRig({ env: rigEnv() });
  try {
    await page.goto(rig.url);
    await page.waitForSelector(".msgs .turn .msg.user", { timeout: 15_000 });
    const msgs = page.locator(".msgs");
    const bar = page.locator(".pin-bar .pin-mirror");
    // The twin's top relative to the scroller's top edge: 0 pinned flush,
    // negative riding up and out.
    const edge = () =>
      bar.evaluate((n) => {
        const sc = n.closest(".msgs");
        return n.getBoundingClientRect().top - sc.getBoundingClientRect().top;
      });
    const offs = await page.evaluate(() => {
      const sc = document.querySelector(".msgs");
      const r = sc.getBoundingClientRect();
      const find = (label) =>
        [...sc.querySelectorAll(".turn .msg.user")].find((n) =>
          n.textContent?.includes(label),
        );
      return {
        t9:
          find("Question 9:").getBoundingClientRect().top -
          r.top +
          sc.scrollTop,
      };
    });
    // Docked on 8 (turn 8's reply in between), 9 still below: pinned
    // flush, nothing pushing.
    await msgs.evaluate((n, v) => {
      n.scrollTop = v;
    }, offs.t9 - 300);
    await expect(bar).toContainText("Question 8:");
    expect(Math.abs(await edge())).toBeLessThanOrEqual(1);
    // 9 approaching the edge: the twin rides up out of its way — the
    // push-out hand-off, the old sticky's motion.
    const h = await bar.evaluate((n) => n.offsetHeight);
    await msgs.evaluate((n, v) => {
      n.scrollTop = v;
    }, offs.t9 - Math.round(h / 2));
    await expect
      .poll(edge, { timeout: 3_000 })
      .toBeLessThanOrEqual(-h / 2 + 2);
    await expect(bar).toContainText("Question 8:");
    // The crossing: 9 takes the pin, flush again.
    await msgs.evaluate((n, v) => {
      n.scrollTop = v;
    }, offs.t9 + 1);
    await expect(bar).toContainText("Question 9:");
    expect(Math.abs(await edge())).toBeLessThanOrEqual(1);
  } finally {
    rig.stop();
  }
});

test("clicking the docked twin jumps back to its turn", async ({ page }) => {
  const rig = await startRig({ env: rigEnv() });
  try {
    await page.goto(rig.url);
    await page.waitForSelector(".msgs .turn .msg.user", { timeout: 15_000 });
    const msgs = page.locator(".msgs");
    await msgs.evaluate((n) => {
      n.scrollTop = n.scrollHeight;
    });
    const bar = page.locator(".pin-bar .pin-mirror");
    await expect(bar).toContainText("Question 11:");
    await bar.click();
    // Landed: the turn's top is the scroller's top — the pill at the edge,
    // pinned there (the boundary is inclusive, the old sticky's), and the
    // bar keeps carrying it.
    await expect(bar).toContainText("Question 11:");
    const last = page.locator(".turn .msg.user", { hasText: "Question 11:" });
    await expect(last).toBeVisible();
    const tops = await last.evaluate((n) => {
      const sc = n.closest(".msgs");
      return n.getBoundingClientRect().top - sc.getBoundingClientRect().top;
    });
    expect(Math.abs(tops)).toBeLessThanOrEqual(6);
  } finally {
    rig.stop();
  }
});
