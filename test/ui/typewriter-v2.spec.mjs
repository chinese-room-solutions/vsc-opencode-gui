// Typewriter streaming over the v2 wire: the reveal must engage through
// the v2 translation path (v2events.ts session.text.delta →
// session.next.text.delta → store appendPartText), not just the v1 one
// typewriter.spec.mjs exercises. Same fake pacing (170-char chunks every
// 150 ms), so growth finer than one chunk proves the reveal — wire-sized
// jumps would mean the v2 path breaks the streaming plumbing. Own rig per
// test: these need OPENCODE_DIALECT v2, which the auto fixture doesn't set.
import {
  test,
  expect,
  watchPage,
  openSession,
  waitIdle,
} from "./support/fixture.mjs";
import { startRig } from "./support/rig.mjs";

const ENV = {
  OPENCODE_ROUTE: JSON.stringify({ view: "session", id: "ses_seed_1" }),
  OPENCODE_TABS: JSON.stringify(["ses_seed_1"]),
  OPENCODE_DIALECT: "v2",
  OPENCODE_READY_SOUND: "0",
  OPENCODE_PERMISSION_SOUND: "0",
  OPENCODE_QUESTION_SOUND: "0",
};

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
}) => {
  const rig = await startRig({ env: ENV });
  try {
    const watched = watchPage(page);
    await openSession(page, rig.url);
    const rowsBefore = await page.locator(".assistant-text").count();

    await page.click(".composer textarea");
    await page.fill(".composer textarea", "Probe the typewriter reveal");
    await page.press(".composer textarea", "Enter");

    // v2 spawns the part on its first delta (~10 s in — the thinking phase
    // streams first; text.started projects nothing), and the answer runs
    // ~6.6 s more.
    await expect
      .poll(() => page.locator(".assistant-text").count(), { timeout: 15000 })
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
    // chunk: the deltas themselves arrive in chunks, so only the reveal
    // can paint finer. Steps after the settle snap are exempt — the
    // trailing-edge guarantee completes the text at once by design.
    let run = 0;
    let best = 0;
    for (const s of steps) {
      run = s > 0 && s < 170 ? run + 1 : 0;
      best = Math.max(best, run);
    }
    expect(best, dump).toBeGreaterThanOrEqual(2);

    await waitIdle(rig);

    // No truncation: the settled bubble equals the turn's full text —
    // whitespace-stripped, since paragraph breaks don't survive textContent.
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
  } finally {
    rig.stop();
  }
});

// A reload mid-turn: the reloaded page rebuilds from the v2 message page
// (stepsRows serve the partial text), re-attaches the reveal, and still
// settles complete. Pacing is test 1's subject, not this one's.
test("a mid-stream reload still settles complete", async ({ page }) => {
  const rig = await startRig({ env: ENV });
  try {
    const watched = watchPage(page);
    await openSession(page, rig.url);
    const rowsBefore = await page.locator(".assistant-text").count();

    await page.click(".composer textarea");
    await page.fill(".composer textarea", "Reload mid-stream");
    await page.press(".composer textarea", "Enter");
    await expect
      .poll(() => page.locator(".assistant-text").count(), { timeout: 15000 })
      .toBe(rowsBefore + 1);

    // Past the first delta (the answer starts ~10 s in and runs ~6.6 s):
    // reload into the middle of it.
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
  } finally {
    rig.stop();
  }
});

// The thinking fold's body unmounts on collapse ({open && <Markdown/>} in
// ThinkingBlock): re-opening mid-stream remounts the reveal, and the
// contract is that it shows everything already streamed at once and types
// only what arrives from here. A replay-from-zero bug would repaint the
// backlog at the reveal's catchup pace (~1.5 s time constant) and miss
// this window.
test("re-expanding the thinking fold shows the current text, not a replay", async ({
  page,
}) => {
  const rig = await startRig({ env: ENV });
  try {
    const watched = watchPage(page);
    await openSession(page, rig.url);

    await page.click(".composer textarea");
    await page.fill(".composer textarea", "Re-expand the thinking fold");
    await page.press(".composer textarea", "Enter");

    // The reasoning part spawns collapsed on its first delta (~2 s in).
    await expect
      .poll(() => page.locator(".thinking-block").count(), { timeout: 8000 })
      .toBeGreaterThan(0);
    await page.click(".thinking-head");

    const thinkLen = () =>
      page.evaluate(() => {
        const el = document.querySelector(".thinking-body");
        return el ? (el.textContent ?? "").length : 0;
      });
    // The think streams ~6 s: let the typed body grow past a few deltas.
    await expect.poll(thinkLen, { timeout: 10_000 }).toBeGreaterThan(800);
    const l1 = await thinkLen();

    // Collapse (the body unmounts) while deltas keep landing, then
    // re-open: within 500 ms the whole accumulated text must be there.
    await page.click(".thinking-head");
    await page.waitForTimeout(700);
    await page.click(".thinking-head");
    const t0 = Date.now();
    let full = false;
    while (Date.now() - t0 < 500) {
      if ((await thinkLen()) >= l1) {
        full = true;
        break;
      }
      await page.waitForTimeout(100);
    }
    expect(full, `re-opened body never reached L1=${l1}`).toBe(true);

    await waitIdle(rig);

    // No truncation: the settled body equals the wire truth's reasoning —
    // whitespace-stripped, since paragraph breaks don't survive textContent.
    const truth = await (await fetch(`${rig.api}/__control/last-prompt`)).json();
    expect(truth.reasoning.length, "wire truth is non-empty").toBeGreaterThan(
      1000,
    );
    await expect
      .poll(
        async () =>
          strip(
            await page.evaluate(() => {
              const el = document.querySelector(".thinking-body");
              return el ? (el.textContent ?? "") : "";
            }),
          ),
        { timeout: 10_000 },
      )
      .toBe(strip(truth.reasoning));

    expect(watched.errors).toEqual([]);
  } finally {
    rig.stop();
  }
});
