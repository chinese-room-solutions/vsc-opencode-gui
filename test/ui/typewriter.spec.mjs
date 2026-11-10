// Typewriter streaming (the Markdown component in MessageView.tsx): while
// a part streams, the bubble's text must grow finer-grained than the wire
// delivers — the fake streams 170-char chunks every 150 ms and the reveal
// runs per frame between the 250 ms parse ticks — and the settled render
// must match the wire truth, so the slicing loses nothing.
import {
  test,
  expect,
  watchPage,
  openSession,
  waitIdle,
} from "./support/fixture.mjs";

// textContent flattens <p> boundaries away — compare whitespace-stripped.
const strip = (s) => s.replace(/\s+/g, "");

async function tailLen(page) {
  return page.evaluate(() => {
    const els = document.querySelectorAll(".assistant-text");
    return els.length ? (els[els.length - 1].textContent ?? "").length : 0;
  });
}

test("streaming text reveals per character and settles complete", async ({
  page,
  rig,
}) => {
  const watched = watchPage(page);
  await openSession(page, rig.url);
  const rowsBefore = await page.locator(".assistant-text").count();

  await page.click(".composer textarea");
  await page.fill(".composer textarea", "Probe the typewriter reveal");
  await page.press(".composer textarea", "Enter");

  // The scripted turn's empty reply part mounts within a second of the
  // POST; the first delta lands ~2.4 s in and streams for ~6.6 s more.
  await expect
    .poll(() => page.locator(".assistant-text").count(), { timeout: 5000 })
    .toBe(rowsBefore + 1);

  // Sample the reply's text length through the stream until it stops
  // growing for a second (the reveal caught up past the last delta).
  const samples = [];
  const t0 = Date.now();
  let stable = 0;
  while (Date.now() - t0 < 15_000 && stable < 10) {
    const len = await tailLen(page);
    if (samples.length && len === samples[samples.length - 1]) stable++;
    else stable = 0;
    samples.push(len);
    await page.waitForTimeout(100);
  }
  const dump = `lengths: ${samples.join(",")}`;
  const steps = samples.slice(1).map((n, i) => n - samples[i]);
  // Two consecutive growth steps, each finer than one 170-char wire
  // chunk (the pre-typewriter behavior repainted ~2 chunks per tick).
  // Steps after the settle snap are exempt: idle lands right after the
  // last delta, and the trailing-edge guarantee completes the text at
  // once — one large final step is by design.
  let run = 0;
  let best = 0;
  for (const s of steps) {
    run = s > 0 && s < 170 ? run + 1 : 0;
    best = Math.max(best, run);
  }
  expect(best, dump).toBeGreaterThanOrEqual(2);

  await waitIdle(rig);

  // No truncation: the settled bubble equals the scripted turn's full
  // text — whitespace-stripped, since paragraph breaks don't survive
  // textContent across <p> boundaries.
  const truth = await (await fetch(`${rig.api}/__control/last-prompt`)).json();
  expect(truth.text.length, "wire truth is non-empty").toBeGreaterThan(1000);
  await expect
    .poll(
      async () =>
        strip(
          await page.evaluate(() => {
            const els = document.querySelectorAll(".assistant-text");
            return els.length ? (els[els.length - 1].textContent ?? "") : "";
          }),
        ),
      { timeout: 10_000 },
    )
    .toBe(strip(truth.text));

  expect(watched.errors).toEqual([]);
});

// A reload mid-turn (constant habit here): the reveal state is
// display-layer only, so the reloaded page must re-attach, re-type
// whatever already streamed, and still settle complete. Pacing is
// test 1's subject, not this one's.
test("a mid-stream reload still settles complete", async ({ page, rig }) => {
  const watched = watchPage(page);
  await openSession(page, rig.url);
  const rowsBefore = await page.locator(".assistant-text").count();

  await page.click(".composer textarea");
  await page.fill(".composer textarea", "Reload mid-stream");
  await page.press(".composer textarea", "Enter");
  await expect
    .poll(() => page.locator(".assistant-text").count(), { timeout: 5000 })
    .toBe(rowsBefore + 1);

  // Past the first delta (the stream runs ~6.6 s): reload into the
  // middle of it.
  await expect
    .poll(() => tailLen(page), { timeout: 8000 })
    .toBeGreaterThan(400);
  await page.reload();

  await openSession(page, rig.url);
  await waitIdle(rig);
  const truth = await (await fetch(`${rig.api}/__control/last-prompt`)).json();
  expect(truth.text.length, "wire truth is non-empty").toBeGreaterThan(1000);
  await expect
    .poll(
      async () =>
        strip(
          await page.evaluate(() => {
            const els = document.querySelectorAll(".assistant-text");
            return els.length ? els[els.length - 1].textContent ?? "" : "";
          }),
        ),
      { timeout: 10_000 },
    )
    .toBe(strip(truth.text));

  expect(watched.errors).toEqual([]);
});

// The reveal is unconditional: Chromium maps prefers-reduced-motion to
// the OS animation setting, and a performance-tuned machine (animations
// off) must not lose the typewriter. Under emulated reduce the reveal
// still runs, then settles complete like everywhere else.
test("reduced motion still types per character and settles complete", async ({
  page,
  rig,
}) => {
  const watched = watchPage(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openSession(page, rig.url);
  const rowsBefore = await page.locator(".assistant-text").count();

  await page.click(".composer textarea");
  await page.fill(".composer textarea", "Probe the reduced-motion path");
  await page.press(".composer textarea", "Enter");
  await expect
    .poll(() => page.locator(".assistant-text").count(), { timeout: 5000 })
    .toBe(rowsBefore + 1);

  const samples = [];
  const t0 = Date.now();
  let stable = 0;
  while (Date.now() - t0 < 15_000 && stable < 10) {
    const len = await tailLen(page);
    if (samples.length && len === samples[samples.length - 1]) stable++;
    else stable = 0;
    samples.push(len);
    await page.waitForTimeout(100);
  }
  // Per-character reveal regardless of the media query: growth runs finer
  // than the 170-char wire chunks.
  const steps = samples.slice(1).map((n, i) => n - samples[i]);
  let run = 0;
  let best = 0;
  for (const s of steps) {
    run = s > 0 && s < 170 ? run + 1 : 0;
    best = Math.max(best, run);
  }
  expect(best, `lengths: ${samples.join(",")}`).toBeGreaterThanOrEqual(2);

  await waitIdle(rig);
  const truth = await (await fetch(`${rig.api}/__control/last-prompt`)).json();
  await expect
    .poll(
      async () =>
        strip(
          await page.evaluate(() => {
            const els = document.querySelectorAll(".assistant-text");
            return els.length ? (els[els.length - 1].textContent ?? "") : "";
          }),
        ),
      { timeout: 10_000 },
    )
    .toBe(strip(truth.text));

  expect(watched.errors).toEqual([]);
});
