// Shared fixture: a fresh fake-API rig per test, booted straight into the
// seeded long session, plus geometry/control helpers for the follow tests.
import { test as base, expect } from "@playwright/test";
import { startRig } from "./rig.mjs";

const SEED_ROUTE = { view: "session", id: "ses_seed_1" };

const test = base.extend({
  rig: [
    async ({}, use) => {
      const rig = await startRig({
        env: {
          OPENCODE_ROUTE: JSON.stringify(SEED_ROUTE),
          OPENCODE_TABS: JSON.stringify([SEED_ROUTE.id]),
          OPENCODE_READY_SOUND: "0",
          OPENCODE_PERMISSION_SOUND: "0",
          OPENCODE_QUESTION_SOUND: "0",
        },
      });
      await use(rig);
      rig.stop();
    },
    { auto: true },
  ],
});

// Collect app-originated console errors / page errors / failed requests.
// The rig serves no favicon — the browser's 404 for it is not the app's.
function watchPage(page) {
  const errors = [];
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    // The rig serves no favicon; the browser's 404 for it is not the app's.
    if ((m.location()?.url ?? "").includes("favicon")) return;
    errors.push(`console: ${m.location()?.url ?? ""} ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("requestfailed", (r) => {
    if (r.url().includes("favicon")) return;
    errors.push(`requestfailed: ${r.method()} ${r.url()} ${r.failure()?.errorText}`);
  });
  return { errors };
}

// .msgs scroller geometry.
async function geom(page) {
  return page.locator(".msgs").evaluate((el) => ({
    top: el.scrollTop,
    h: el.scrollHeight,
    c: el.clientHeight,
  }));
}

const dist = (g) => g.h - g.top - g.c;

// Load the rig URL and wait until the seeded transcript rendered and the
// view came to rest at the bottom.
async function openSession(page, url) {
  await page.goto(url);
  await page.waitForSelector(".msgs .turn .msg.user", { timeout: 15_000 });
  await expect
    .poll(async () => dist(await geom(page)), { timeout: 10_000 })
    .toBeLessThanOrEqual(3);
}

// POST to the fake API's control endpoints.
async function control(rig, path, body) {
  const res = await fetch(`${rig.api}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw new Error(`control ${path}: ${res.status}`);
  return res.json();
}

// Wait until no synthetic stream is running.
async function waitIdle(rig, timeoutMs = 30_000) {
  await expect
    .poll(async () => (await (await fetch(`${rig.api}/__control/status`)).json()).streaming, {
      timeout: timeoutMs,
      intervals: [250],
    })
    .toBe(false);
}

// Sample the scroller for `ms`. A following view keeps returning to the
// bottom between stream deltas (dist spikes are one delta's height and
// settle within a tick); a disengaged one lets dist run away monotonically
// (the stream grows ~1 delta per 150ms, so 3s of disengage ≈ thousands of px).
async function assertFollows(page, ms, interval = 200) {
  const samples = [];
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    samples.push(Math.round(dist(await geom(page))));
    await page.waitForTimeout(interval);
  }
  const label = `dist samples: ${samples.join(", ")}`;
  expect(Math.max(...samples), label).toBeLessThan(150);
  expect(samples.filter((d) => d <= 8).length, label).toBeGreaterThan(0);
}

async function wheelToBottom(page) {
  for (let i = 0; i < 60; i++) {
    if (dist(await geom(page)) <= 3) return;
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(70);
  }
  throw new Error("never reached the bottom by wheeling");
}

export { test, expect, watchPage, geom, dist, openSession, control, waitIdle, assertFollows, wheelToBottom };
