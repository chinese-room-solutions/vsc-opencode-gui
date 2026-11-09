// The completion chime's host arbitration, webview half: every chat page
// (sidebar + one editor tab per session) rings the same event, but VS Code
// gives each webview viewType its own origin, so pages can't gate each
// other browser-side. The page CLAIMS the ring (sound.ts); the extension
// host grants exactly one claim per window (ChatHub.claimBell — held in
// the lifecycle suite). These specs pin the seam in a real browser: the
// claim fires on the real busy→idle path, and only a grant rings.
import { test, expect } from "@playwright/test";
import { startRig } from "./support/rig.mjs";

const rigEnv = () => ({
  OPENCODE_ROUTE: JSON.stringify({ view: "session", id: "ses_seed_1" }),
  OPENCODE_TABS: JSON.stringify(["ses_seed_1"]),
  OPENCODE_DIALECT: "v2",
  // Sounds stay on: the whole point is the claim path.
});

// The rig stub records host-bound posts on window.__hostPosted.
const claims = (page, kind = "ready") =>
  page.evaluate(
    ({ kind }) =>
      (window.__hostPosted ?? []).filter(
        (m) => m.type === "bell-claim" && m.kind === kind,
      ).length,
    { kind },
  );

const rang = (page) =>
  page.evaluate(() => localStorage.getItem("opencode.bellAt.ready") !== null);

test("a finished turn claims the chime; only the host's grant rings it", async ({
  page,
}) => {
  const rig = await startRig({ env: rigEnv() });
  try {
    await page.goto(rig.url);
    await page.waitForSelector(".msgs .turn .msg.user", { timeout: 15_000 });
    // The autoplay policy keeps a fresh AudioContext suspended; one real
    // pointer event resumes it, and only a running context claims (a
    // suspended page must not consume another page's chime).
    await page.mouse.click(10, 10);
    await expect
      .poll(() => page.evaluate(() => new AudioContext().state), {
        timeout: 5_000,
      })
      .toBe("running");
    expect(await claims(page)).toBe(0);
    // A scripted turn through the fake API: durable rows, a streaming
    // part (busy observed), then session.idle — the ring's trigger.
    const res = await fetch(`${rig.api}/session/ses_seed_1/prompt_async`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "ring the bell" }),
    });
    expect(res.ok).toBe(true);
    await expect
      .poll(() => claims(page), { timeout: 30_000, intervals: [250] })
      .toBeGreaterThanOrEqual(1);
    // The rig's stub is a host that always grants its single page — the
    // grant rode back and the chime actually rang (the throttle key is
    // written only on playback).
    await expect
      .poll(() => rang(page), { timeout: 5_000 })
      .toBe(true);
  } finally {
    rig.stop();
  }
});

test("a page whose audio is suspended claims nothing", async ({ page }) => {
  const rig = await startRig({ env: rigEnv() });
  try {
    await page.goto(rig.url);
    await page.waitForSelector(".msgs .turn .msg.user", { timeout: 15_000 });
    // No interaction: if this runner's policy suspends fresh contexts,
    // the page must stay silent rather than claim (and maybe swallow
    // the window another page could have won).
    const state = await page.evaluate(() => {
      try {
        return new AudioContext().state;
      } catch {
        return "none";
      }
    });
    test.skip(state === "running", "runner's autoplay policy auto-runs audio");
    const res = await fetch(`${rig.api}/session/ses_seed_1/prompt_async`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "stay silent" }),
    });
    expect(res.ok).toBe(true);
    await page.waitForTimeout(14_000);
    expect(await claims(page)).toBe(0);
    expect(await rang(page)).toBe(false);
  } finally {
    rig.stop();
  }
});
