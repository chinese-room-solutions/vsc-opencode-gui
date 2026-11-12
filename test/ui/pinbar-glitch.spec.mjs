// An expanded pill must not dock its clamped twin over its own text while
// any of it is in view (user report: the pinned twin stays over the
// expanded pill). The inclusive pin boundary counted the expand landing as
// pinned, and any scroll into the text docked the twin again. Vectors:
//  - origin (the sub-session case): the long first pill expanded at
//    scrollTop 0 — the jump is the 4px spacer, and the twin covered the
//    expanded text's top 100+px.
//  - mid-transcript: the pill's turn jumped to the edge first (twin docked,
//    the inclusive boundary), then "Show more" — the expand jump is a 0px
//    no-op firing no scroll event, and the twin simply stayed.
//  - the twin's click-jump back onto an already expanded pill.
import { test, expect } from "@playwright/test";
import { startRig } from "./support/rig.mjs";

const rigEnv = (route, extra = {}) => ({
  OPENCODE_ROUTE: JSON.stringify(route),
  OPENCODE_TABS: JSON.stringify(["ses_seed_1"]),
  OPENCODE_DIALECT: "v2",
  OPENCODE_READY_SOUND: "0",
  OPENCODE_PERMISSION_SOUND: "0",
  OPENCODE_QUESTION_SOUND: "0",
  ...extra,
});

// Counts .pin-bar mounts/unmounts inside the scroller (direct child of
// .msgs), installed BEFORE the interaction under test.
const installPinObserver = (page) =>
  page.evaluate(() => {
    const sc = document.querySelector(".msgs");
    window.__pinObs = { mounts: 0, unmounts: 0 };
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes)
          if (n.nodeType === 1 && n.classList.contains("pin-bar"))
            window.__pinObs.mounts++;
        for (const n of m.removedNodes)
          if (n.nodeType === 1 && n.classList.contains("pin-bar"))
            window.__pinObs.unmounts++;
      }
    });
    mo.observe(sc, { childList: true });
  });

// Clicks the marker pill's clamp-toggle from inside the page and samples
// every animation frame for `ms`: pin-bar presence and the pill row's
// offset from the scroller's top edge.
const expandAndSample = (page, marker, ms) =>
  page.evaluate(
    ([marker, ms]) =>
      new Promise((resolve) => {
        const sc = document.querySelector(".msgs");
        const row = [...sc.querySelectorAll(".turn .msg.user")].find((n) =>
          n.textContent?.includes(marker),
        );
        if (!row) throw new Error(`no pill row for ${marker}`);
        const frames = [];
        const t0 = performance.now();
        row.querySelector(".clamp-toggle")?.click();
        const tick = () => {
          frames.push({
            t: Math.round(performance.now() - t0),
            bar: Boolean(sc.querySelector(".pin-bar")),
            top: Math.round(
              (row.getBoundingClientRect().top - sc.getBoundingClientRect().top) * 10,
            ) / 10,
          });
          if (performance.now() - t0 < ms) requestAnimationFrame(tick);
          else resolve({ frames, obs: window.__pinObs });
        };
        requestAnimationFrame(tick);
      }),
    [marker, ms],
  );

// Scrolls through the marker pill in 40px steps until its row's bottom
// nears the edge, recording whether the bar is up two frames after each.
const readThrough = (page, marker) =>
  page.evaluate(async (marker) => {
    const sc = document.querySelector(".msgs");
    const row = [...sc.querySelectorAll(".turn .msg.user")].find((n) =>
      n.textContent?.includes(marker),
    );
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    const steps = [];
    for (;;) {
      const left =
        row.getBoundingClientRect().bottom - sc.getBoundingClientRect().top;
      // Stops 2px short: scrollTop is whole pixels, the row's bottom can
      // sit on a half one, and half a pixel left is the docking boundary.
      if (left < 3) return steps;
      sc.scrollTop += Math.min(40, Math.floor(left - 2));
      await frame();
      await frame();
      steps.push({
        top: sc.scrollTop,
        left: row.getBoundingClientRect().bottom - sc.getBoundingClientRect().top,
        bar: Boolean(sc.querySelector(".pin-bar")),
      });
    }
  }, marker);

// Puts the marker pill's row 2px past the scroller's top edge.
const scrollPast = (page, marker) =>
  page.evaluate((marker) => {
    const sc = document.querySelector(".msgs");
    const row = [...sc.querySelectorAll(".turn .msg.user")].find((n) =>
      n.textContent?.includes(marker),
    );
    sc.scrollTop +=
      row.getBoundingClientRect().bottom - sc.getBoundingClientRect().top + 2;
  }, marker);

// The mount opens at the bottom with the follow armed; scroll to the
// origin and let the 2.5s settle hold expire so nothing fights the reads.
const settleAt = async (page, scrollTop) => {
  await page.waitForTimeout(2_600);
  await page.locator(".msgs").evaluate((n, v) => {
    n.scrollTop = v;
  }, scrollTop);
  await page.waitForTimeout(300);
};

test("expanding the first pill at the origin never docks a twin over it", async ({
  page,
}) => {
  const rig = await startRig({
    env: rigEnv(
      { view: "session", id: "ses_seed_1", child: "ses_child_1" },
      // The sub-agent spawn-prompt shape: a long FIRST pill.
      { FAKE_API_LONG_P1: "1" },
    ),
  });
  try {
    await page.goto(rig.url);
    await page.waitForSelector(".msgs .turn .msg.user", { timeout: 15_000 });
    await expect(page.locator(".crumb")).toBeVisible();
    await expect(page.locator(".msgs .turn .msg.user").first()).toContainText(
      "Question 1:",
    );
    await settleAt(page, 0);
    await expect(page.locator(".pin-bar")).toHaveCount(0);
    await installPinObserver(page);
    const out = await expandAndSample(page, "Question 1:", 1_500);
    // The reading state: the pill expanded from the scroller's top edge,
    // and no clamped twin docked over it — every frame clean.
    expect(out.obs.mounts).toBe(0);
    for (const f of out.frames) expect(f.bar).toBe(false);
    const first = out.frames[0];
    const last = out.frames[out.frames.length - 1];
    expect(first.top).toBeGreaterThanOrEqual(-1);
    expect(last.top).toBeLessThanOrEqual(6);
    expect(Math.abs(last.top - first.top)).toBeLessThanOrEqual(1);
    // Reading on: no twin over the text at any step, until the whole row
    // scrolled past and the pill docks as its clamped twin.
    const steps = await readThrough(page, "Question 1:");
    expect(steps.length).toBeGreaterThan(3);
    expect(steps.filter((s) => s.bar), JSON.stringify(steps)).toEqual([]);
    await scrollPast(page, "Question 1:");
    const bar = page.locator(".pin-bar .pin-mirror");
    await expect(bar).toBeVisible();
    await expect(bar).toContainText("Question 1:");
    const twin = bar.locator(".user-text");
    await expect(twin).toHaveClass(/clamped/);
    await expect(twin).not.toHaveClass(/expanded/);
  } finally {
    rig.stop();
  }
});

test("expanding a pill docked at the edge un-docks the twin", async ({ page }) => {
  const rig = await startRig({
    env: rigEnv({ view: "session", id: "ses_seed_1" }),
  });
  try {
    await page.goto(rig.url);
    await page.waitForSelector(".msgs .turn .msg.user", { timeout: 15_000 });
    await settleAt(page, 0);
    const pill = page
      .locator(".turn .msg.user", { hasText: "Question 2:" })
      .first();
    // Click the pill body: jumpToTurn lands its turn at the edge and the
    // twin docks (the inclusive boundary). Then expand.
    await pill.locator(".user-pill").click();
    const bar = page.locator(".pin-bar .pin-mirror");
    await expect(bar).toBeVisible();
    await expect(bar).toContainText("Question 2:");
    await installPinObserver(page);
    const out = await expandAndSample(page, "Question 2:", 1_500);
    // Expanding un-pins: the twin steps aside for the real, expanded pill
    // sitting at the edge (the ClampedText doc's contract). The 0px jump
    // fires no scroll event of its own — the un-dock must happen within
    // the expand's own frames, not on an unrelated later re-render.
    expect(out.obs.unmounts).toBeGreaterThanOrEqual(1);
    for (const f of out.frames.slice(5)) expect(f.bar).toBe(false);
    const last = out.frames[out.frames.length - 1];
    expect(last.top).toBeLessThanOrEqual(6);
    await expect(pill.locator(".user-text.expanded")).toBeVisible();
    // Scrolled past, the twin docks. Its click-jump lands the still
    // expanded pill back at the edge, and the twin steps aside again.
    await scrollPast(page, "Question 2:");
    await expect(bar).toContainText("Question 2:");
    await bar.click();
    await expect(page.locator(".pin-bar")).toHaveCount(0);
    await expect(pill.locator(".user-text.expanded")).toBeVisible();
  } finally {
    rig.stop();
  }
});
