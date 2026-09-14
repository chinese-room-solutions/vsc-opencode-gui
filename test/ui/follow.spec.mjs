// T2 — transcript auto-follow (src/webview/app/views/Session.tsx):
// stick (follow-at-bottom latch), pinHold (prompt-pin latch), the scroll
// handler, the wheel handler (recoil restore), and clamp-vs-intent.
//
// The fake API seeds a session whose transcript overflows the viewport
// many times; /__control/stream-more grows the tail passively and
// /__control/shrink collapses an above-viewport message.
import {
  test,
  expect,
  watchPage,
  geom,
  dist,
  openSession,
  control,
  waitIdle,
  assertFollows,
  wheelToBottom,
} from "./support/fixture.mjs";

async function mouseOverScroller(page) {
  const box = await page.locator(".msgs").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

test("follows passive tail growth while at the bottom", async ({ page, rig }) => {
  const watched = watchPage(page);
  await openSession(page, rig.url);
  const g0 = await geom(page);
  expect(g0.h).toBeGreaterThanOrEqual(3 * g0.c); // seeded history overflows ~3x

  await control(rig, "/__control/stream-more", { count: 26 });
  await assertFollows(page, 3000); // ~200ms samples for ~3s

  await waitIdle(rig);
  await expect
    .poll(async () => dist(await geom(page)), { timeout: 5000 })
    .toBeLessThanOrEqual(3);
  expect(watched.errors).toEqual([]);
});

// A short viewport makes the pin observable: the pill lands in the scroller's
// upper region, holds while the reply is shorter than the fold, then the
// view follows and the sticky pill rides at the top for the rest of the stream.
test.describe("short panel", () => {
  test.use({ viewport: { width: 900, height: 400 } });
  test("prompt pin: holds until the reply passes the fold, then follows", async ({ page, rig }) => {
  const watched = watchPage(page);
  await openSession(page, rig.url);
  const pillsBefore = await page.locator(".turn .msg.user").count();

  await page.click(".composer textarea");
  await page.fill(".composer textarea", "Probe the pin and follow behavior");
  const sentAt = Date.now();
  await page.press(".composer textarea", "Enter");

  // The new pill exists and pins in the scroller's upper region.
  await expect
    .poll(() => page.locator(".turn .msg.user").count(), { timeout: 3000 })
    .toBe(pillsBefore + 1);
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const el = document.querySelector(".msgs");
          const pills = el.querySelectorAll(".turn .msg.user");
          const pill = pills[pills.length - 1];
          if (!pill) return 1;
          return (pill.getBoundingClientRect().top - el.getBoundingClientRect().top) / el.clientHeight;
        }),
      { timeout: 2500, intervals: [100] },
    )
    .toBeLessThanOrEqual(0.45);

  // Hold window (no reply text yet): the view rests — no jump, no drift.
  await page.waitForTimeout(Math.max(0, sentAt + 700 - Date.now()));
  const holdA = await geom(page);
  await page.waitForTimeout(Math.max(0, sentAt + 1400 - Date.now()));
  const holdB = await geom(page);
  expect(dist(holdA)).toBeLessThanOrEqual(3);
  expect(Math.abs(holdB.top - holdA.top)).toBeLessThanOrEqual(3);
  expect(dist(holdB)).toBeLessThanOrEqual(3);

  // Past the fold the follow resumes and the sticky pill rides the top.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const el = document.querySelector(".msgs");
          const pills = el.querySelectorAll(".turn .msg.user");
          const pill = pills[pills.length - 1];
          if (!pill) return 9999;
          return Math.round(pill.getBoundingClientRect().top - el.getBoundingClientRect().top);
        }),
      { timeout: 10000, intervals: [200] },
    )
    .toBeLessThanOrEqual(4);

  // Stream end: back at the bottom.
  await waitIdle(rig);
  await expect
    .poll(async () => dist(await geom(page)), { timeout: 5000 })
    .toBeLessThanOrEqual(3);
  expect(watched.errors).toEqual([]);
  });
});

test("wheel-up disengages follow; returning to the bottom re-arms it", async ({ page, rig }) => {
  const watched = watchPage(page);
  await openSession(page, rig.url);
  await mouseOverScroller(page);

  await control(rig, "/__control/stream-more", { count: 80 });
  await page.waitForTimeout(500);
  await page.mouse.wheel(0, -400);
  await page.waitForTimeout(300);
  const left = await geom(page);
  expect(dist(left)).toBeGreaterThan(50); // genuinely left the bottom

  // Growth must not chase the reader: scrollTop stays put while height grows.
  for (let i = 0; i < 5; i++) {
    await page.waitForTimeout(350);
    const g = await geom(page);
    expect(Math.abs(g.top - left.top), `sample ${i} moved`).toBeLessThanOrEqual(3);
  }
  expect((await geom(page)).h).toBeGreaterThan(left.h + 200); // content did grow

  // Wheel back to the bottom: follow re-arms and tracks the stream again.
  await wheelToBottom(page);
  await assertFollows(page, 1500);

  await waitIdle(rig);
  await expect
    .poll(async () => dist(await geom(page)), { timeout: 5000 })
    .toBeLessThanOrEqual(3);
  expect(watched.errors).toEqual([]);
});

test("trackpad recoil at the bottom does not disengage follow", async ({ page, rig }) => {
  const watched = watchPage(page);
  await openSession(page, rig.url);
  await mouseOverScroller(page);

  // Tiny negative delta while resting at the bottom: no movement happens,
  // so no scroll event confirms intent — the 120ms restore must keep the
  // follow armed.
  await page.mouse.wheel(0, -3);
  await page.waitForTimeout(250);

  await control(rig, "/__control/stream-more", { count: 14 });
  const topBefore = (await geom(page)).top;
  const samples = [];
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(300);
    samples.push(Math.round(dist(await geom(page))));
  }
  const label = `dist samples: ${samples.join(", ")}`;
  expect(Math.max(...samples), label).toBeLessThan(150);
  expect(samples.filter((d) => d <= 8).length, label).toBeGreaterThan(0);
  // The view genuinely tracked the stream down, not sat frozen at the top.
  expect((await geom(page)).top).toBeGreaterThan(topBefore + 200);

  await waitIdle(rig);
  await expect
    .poll(async () => dist(await geom(page)), { timeout: 5000 })
    .toBeLessThanOrEqual(3);
  expect(watched.errors).toEqual([]);
});

test("clamp after content above shrinks is not leave intent", async ({ page, rig }) => {
  const watched = watchPage(page);
  await openSession(page, rig.url);

  // Collapse a tall message above the viewport while resting at the bottom:
  // the browser clamps scrollTop down (a rising scroll at dist 0) — the
  // follow must hold.
  const before = await geom(page);
  await control(rig, "/__control/shrink", { index: 3 });
  await page.waitForTimeout(400);
  const after = await geom(page);
  expect(after.h).toBeLessThan(before.h - 150); // the shrink really applied
  expect(dist(after)).toBeLessThanOrEqual(3); // still glued to the bottom

  // And growth afterwards is still followed.
  await control(rig, "/__control/stream-more", { count: 10 });
  await assertFollows(page, 1500);

  await waitIdle(rig);
  await expect
    .poll(async () => dist(await geom(page)), { timeout: 5000 })
    .toBeLessThanOrEqual(3);
  expect(watched.errors).toEqual([]);
});
