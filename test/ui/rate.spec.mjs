// T7 — the live token rate on the turn footer (MessageView.tsx): it must
// survive a multi-step agentic turn. The fake API's /__control/steps runs
// one: steady text, a step boundary whose usage report dwarfs the streamed
// chars (the tool-call burst), a tool wait, a second text step, and a
// tool-only step whose row sits textless for seconds before settling.
//
// Rate basis under test: the pace must come from streamed text/reasoning,
// not from boundary usage jumps (bursts spike it), and must not blank while
// the turn is live (each step restart used to zero it).
import { test, expect, watchPage, openSession, control } from "./support/fixture.mjs";

// "63.6 tok/s" / "1.2k tok/s" → tokens/s as a number.
function parseRate(text) {
  const m = text && text.match(/([\d.]+)(k?) tok\/s/);
  return m ? parseFloat(m[1]) * (m[2] ? 1000 : 1) : null;
}

async function pollFooter(page, ms) {
  const samples = [];
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const text = await page.evaluate(() => {
      const els = document.querySelectorAll(".turn-footer");
      return els.length ? els[els.length - 1].textContent : null;
    });
    samples.push({ t: Date.now() - t0, rate: parseRate(text) });
    await page.waitForTimeout(200);
  }
  return samples;
}

test("rate holds through usage bursts and tool-only steps", async ({ page, rig }) => {
  const watched = watchPage(page);
  await openSession(page, rig.url);

  await control(rig, "/__control/steps", {});
  const samples = await pollFooter(page, 27_500);
  const dump = () => samples.map((s) => `${s.t}:${s.rate ?? "-"}`).join(" ");
  const inWin = (a, b) => samples.filter((s) => s.t >= a && s.t <= b);

  // Baseline: steady phase 1 text (deltas 0.5s-6.4s) reads a stable pace.
  const base = inWin(4000, 6400).map((s) => s.rate).filter((r) => r !== null);
  expect(base.length, dump()).toBeGreaterThan(5);
  base.sort((a, b) => a - b);
  const median = base[Math.floor(base.length / 2)];
  expect(median).toBeGreaterThan(0);

  // The burst window (usage report at 6.55s, chars flat until 10.05s):
  // the displayed pace must stay within 1.6x of baseline — a usage jump
  // is not generation. Ends before the tool completes at 9.55s: the
  // settled flash that follows re-derives from partial tool time.
  const burst = inWin(6550, 9400).map((s) => s.rate ?? 0);
  expect(burst.length, dump()).toBeGreaterThan(5);
  expect(Math.max(...burst) / median, dump()).toBeLessThan(1.6);

  // No blank windows: tool wait (settled branch), both post-boundary
  // resumes (step 2 at 9.75s, tool-only step 3 at 19s), and the text step
  // after it (22.5s-25.4s) — once a rate has shown, the turn keeps one.
  for (const [a, b] of [[6900, 9400], [10200, 15900], [19900, 25000]]) {
    const missing = inWin(a, b).filter((s) => s.rate === null);
    expect(missing, `window ${a}-${b}: ${dump()}`).toEqual([]);
  }

  // Settled (idle at 25.85s): the footer lands on a positive final rate.
  expect(samples.filter((s) => s.t >= 26400).some((s) => s.rate > 0), dump()).toBe(true);

  expect(watched.errors).toEqual([]);
});

// The same underlying pace (~170 chars/150ms) delivered two ways: steady
// 150ms deltas, then one 2.8k-char batch every 2.5s — the offload pattern
// providers show. The displayed rate must not depend on delivery shape: a
// sampler that drops no-movement seconds reads the batch size as pace
// (~2.5x here) while the idle seconds the batch accumulated over never
// count.
test("batched delivery reads the same pace as steady delivery", async ({ page, rig }) => {
  const watched = watchPage(page);
  await openSession(page, rig.url);

  await control(rig, "/__control/batches", {});
  const samples = await pollFooter(page, 20_000);
  const dump = () => samples.map((s) => `${s.t}:${s.rate ?? "-"}`).join(" ");
  const med = (a, b) => {
    const v = samples
      .filter((s) => s.t >= a && s.t <= b)
      .map((s) => s.rate)
      .filter((r) => r !== null && r > 0);
    v.sort((x, y) => x - y);
    expect(v.length, dump()).toBeGreaterThan(4);
    return v[Math.floor(v.length / 2)];
  };

  // Steady phase (deltas 0.5s-3.35s) reads a positive pace.
  const steady = med(2500, 3900);

  // Batchy phase (4s-16.5s) reads within 1.7x of steady — same generation,
  // different arrival shape.
  const batchy = med(11000, 16000);
  expect(batchy / steady, dump()).toBeGreaterThan(0.55);
  expect(batchy / steady, dump()).toBeLessThan(1.7);

  // No blanks across the live span, batchy phase included.
  const missing = samples
    .filter((s) => s.t >= 1500 && s.t <= 16000)
    .filter((s) => s.rate === null);
  expect(missing, dump()).toEqual([]);

  // Settled (idle at 17.5s): the whole-turn pace agrees with the live one.
  const settled = med(18000, 20000);
  expect(settled / steady, dump()).toBeGreaterThan(0.6);
  expect(settled / steady, dump()).toBeLessThan(1.6);

  expect(watched.errors).toEqual([]);
});
