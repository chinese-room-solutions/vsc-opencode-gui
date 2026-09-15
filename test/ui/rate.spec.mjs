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
