// The editor tab's status prefix, page half: the session page reports
// its tab's facts to the host (App.tsx's poster + store's turnEnded
// post), and the host drives the icon (SessionPanel's TabSignal — held
// in the lifecycle suite). These specs pin the seam in a real browser:
// a scripted turn posts busy, then its end posts busy:false plus the
// turnEnded moment; a re-rooted sub-agent page keeps reporting its
// pinned conversation, re-posting on the beat.
import { test, expect } from "@playwright/test";
import { startRig } from "./support/rig.mjs";

const rigEnv = () => ({
  OPENCODE_ROUTE: JSON.stringify({ view: "session", id: "ses_seed_1" }),
  OPENCODE_TABS: JSON.stringify(["ses_seed_1"]),
  OPENCODE_DIALECT: "v2",
});

test("a re-rooted sub-agent page still reports its tab's conversation", async ({ page }) => {
  // Boot pinned to ses_seed_1 but routed into its sub-agent child —
  // ToolCard's re-root state (chip clicked inside a child). The poster
  // must keep posting for the pinned conversation: the parent's scripted
  // turn spins the tab while the child's page is on screen, and the beat
  // re-posts unchanged facts so a dropped post self-heals.
  const rig = await startRig({
    env: {
      OPENCODE_ROUTE: JSON.stringify({ view: "session", id: "ses_child_1" }),
      OPENCODE_RIG_PIN: "ses_seed_1",
      OPENCODE_TABS: JSON.stringify(["ses_seed_1"]),
      OPENCODE_DIALECT: "v2",
    },
  });
  try {
    await page.goto(rig.url);
    await page.waitForSelector(".msgs .turn .msg.user", { timeout: 15_000 });
    const signals = async () =>
      page.evaluate(() =>
        (window.__hostPosted ?? []).filter((m) => m.type === "tab-signal"),
      );
    // The gate is the session meta, not the route: mount posts despite
    // the re-rooted root.
    await expect
      .poll(async () => (await signals()).length, { timeout: 10_000 })
      .toBeGreaterThan(0);
    // The beat: unchanged facts re-post (recovery source for drops).
    const first = (await signals()).length;
    await expect
      .poll(async () => (await signals()).length, { timeout: 20_000 })
      .toBeGreaterThan(first);
    // Facts follow the top ancestor: the parent's busy posts while the
    // child transcript is displayed.
    const res = await fetch(`${rig.api}/session/ses_seed_1/prompt_async`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "spin the re-rooted tab" }),
    });
    expect(res.ok).toBe(true);
    await expect
      .poll(async () => (await signals()).some((m) => m.busy === true), {
        timeout: 30_000,
        intervals: [250],
      })
      .toBe(true);
  } finally {
    rig.stop();
  }
});

test("a scripted turn reports the tab prefix facts", async ({ page }) => {
  const rig = await startRig({ env: rigEnv() });
  try {
    await page.goto(rig.url);
    await page.waitForSelector(".msgs .turn .msg.user", { timeout: 15_000 });
    // The rig stub records host-bound posts on window.__hostPosted.
    const signals = async () =>
      page.evaluate(() =>
        (window.__hostPosted ?? []).filter((m) => m.type === "tab-signal"),
      );
    // Mount posts the resting facts.
    await expect
      .poll(async () => (await signals()).length, { timeout: 10_000 })
      .toBeGreaterThan(0);
    const res = await fetch(`${rig.api}/session/ses_seed_1/prompt_async`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "spin the tab prefix" }),
    });
    expect(res.ok).toBe(true);
    // The turn runs: busy flips true once the events mark it, and the
    // end posts busy:false plus turnEnded (the green mark's moment).
    await expect
      .poll(
        async () => {
          const s = await signals();
          const iBusy = s.findIndex((m) => m.busy === true);
          const rest = iBusy < 0 ? [] : s.slice(iBusy + 1);
          return (
            iBusy >= 0 &&
            rest.some((m) => m.busy === false) &&
            rest.some((m) => m.turnEnded === true)
          );
        },
        { timeout: 30_000, intervals: [250] },
      )
      .toBe(true);
  } finally {
    rig.stop();
  }
});
