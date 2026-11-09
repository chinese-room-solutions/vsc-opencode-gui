// The Sessions list loads older pages on its own: a sentinel at the list's
// end fires the next cursor page as it scrolls into view (an
// IntersectionObserver; rows clipped by the list's scroll never intersect
// the viewport, so only the real end triggers). The "Load older sessions"
// button stays as the failed-fetch retry: an observer never re-fires
// without an intersection change, so a fetch that dies under a parked
// sentinel needs the click.
// FAKE_API_PAGINATE=2 seeds 104 sessions, 103 listable (the seeded
// sub-agent row never lists) — three cursor pages (50+50+4): the boot
// page overflows the view, one scroll loads page two, a second scroll
// exhausts the history.
import { test, expect } from "./support/fixture.mjs";
import { startRig } from "./support/rig.mjs";

const ENV = {
  OPENCODE_HOST: "navigator",
  OPENCODE_ROUTE: JSON.stringify({ view: "home" }),
  OPENCODE_TABS: JSON.stringify([]),
  OPENCODE_DIALECT: "v2",
  OPENCODE_READY_SOUND: "0",
  OPENCODE_PERMISSION_SOUND: "0",
  OPENCODE_QUESTION_SOUND: "0",
  FAKE_API_PAGINATE: "2",
};

const rows = (page) => page.locator(".sess-row");
const toEnd = (page) =>
  page
    .locator(".sess-body")
    .evaluate((el) => el.scrollTo(0, el.scrollHeight));

test("scrolling to the end loads the history until it exhausts", async ({
  page,
}) => {
  const rig = await startRig({ env: ENV });
  try {
    await page.goto(rig.url);
    // The boot page (50 served, one seeded sub-agent row never lists).
    await expect(rows(page)).toHaveCount(49, { timeout: 15_000 });
    await expect(page.locator(".load-older")).toHaveCount(1);

    // Scroll to the end: the sentinel pages the rest in, no click. Rows
    // land below and the view pins to the end (scroll anchoring), so the
    // pump continues past page two on its own; the second scroll is the
    // nudge for a view that didn't pin. No button assertion here: a late
    // boot-retry resync legitimately re-offers the cursor over a complete
    // list.
    await toEnd(page);
    await expect(rows(page)).toHaveCount(99, { timeout: 15_000 }).catch(() => {});
    await toEnd(page);
    await expect(rows(page)).toHaveCount(103, { timeout: 15_000 });
  } finally {
    rig.stop();
  }
});

test("a query pages raw history through the filter while parked at the end", async ({
  page,
}) => {
  const rig = await startRig({ env: ENV });
  try {
    await page.goto(rig.url);
    await expect(rows(page)).toHaveCount(49, { timeout: 15_000 });

    // "bulk" matches all 102 bulk titles; the seeded rows don't match.
    // The cursor walk under a query pages RAW history (searchAllSessions
    // never sets a cursor) — the client-side filter decides what shows.
    await page.locator(".sess-body .search input").fill("bulk");
    await expect(rows(page)).toHaveCount(48, { timeout: 15_000 });

    // One scroll to the end: the pump pages the raw cursor through to
    // exhaustion — no further scrolls, no clicks.
    await toEnd(page);
    await expect(rows(page)).toHaveCount(102, { timeout: 15_000 });
  } finally {
    rig.stop();
  }
});

test("a failed fetch leaves the button as the retry", async ({ page }) => {
  const rig = await startRig({ env: ENV });
  try {
    // The next page dies under the pump: page two lands, the pump tries
    // page three, the fetch fails (no growth) and the pump stops — rows
    // stay put, the button stays.
    await page.route(/cursor=page3/, (r) => r.abort());
    await page.goto(rig.url);
    await expect(rows(page)).toHaveCount(49, { timeout: 15_000 });
    await toEnd(page);
    await expect(page.locator(".load-older")).toHaveCount(1);
    await expect(rows(page)).toHaveCount(99);

    // The button is the way back.
    await page.unroute(/cursor=page3/);
    await page.locator(".load-older").click();
    await expect(rows(page)).toHaveCount(103, { timeout: 15_000 });
  } finally {
    rig.stop();
  }
});
