// The v2 transcript pages from the server — 50 newest rows per fetch,
// the rest behind "Load older messages" and its cursor walk. The walk
// pages cursor.next toward older rows, CONTIGUOUS with the window: a
// click reveals the rows just above it, never a jump to the transcript's
// start (the order=asc walk that used to strand the middle of long
// sessions). A refresh (the 30s busy poll, a reconnect's resync, a
// remount) re-fetches the newest page: rows the reader already expanded
// into view must survive it, or hours of history collapse back to the
// newest page mid-read. FAKE_API_LONG seeds 100 turns (200+ rows, past
// the window + one walk page); /__control/ssedrop forces the drop→
// connect cycle whose resync re-pulls messages.
import { test, expect } from "./support/fixture.mjs";
import { startRig } from "./support/rig.mjs";

const ENV = {
  OPENCODE_ROUTE: JSON.stringify({ view: "session", id: "ses_seed_1" }),
  OPENCODE_TABS: JSON.stringify(["ses_seed_1"]),
  OPENCODE_DIALECT: "v2",
  OPENCODE_READY_SOUND: "0",
  OPENCODE_PERMISSION_SOUND: "0",
  OPENCODE_QUESTION_SOUND: "0",
  FAKE_API_LONG: "1",
};

// The "Question N:" prompt numbers currently in the DOM, and whether they
// are gap-free (every number between min and max present). Matched
// anywhere in the row: an attachment chip renders before the prompt text.
const nums = (page) =>
  page.evaluate(() => {
    const n = [...document.querySelectorAll(".msg.user")]
      .map((e) => e.textContent?.match(/Question (\d+):/))
      .filter(Boolean)
      .map((m) => Number(m[1]))
      .sort((a, b) => a - b);
    const contiguous = new Set(n).size === n.length && (n.at(-1) ?? 0) - (n[0] ?? 0) + 1 === n.length;
    return { n, contiguous, min: n[0], max: n.at(-1) };
  });

test("Load older pages adjacent to the window, not from the transcript's start", async ({ page }) => {
  const rig = await startRig({ env: ENV });
  try {
    await page.goto(rig.url);
    // Windowed open: the newest page serves, the oldest turns hide
    // behind the button.
    await expect(page.locator(".load-older")).toHaveCount(1);
    let v = await nums(page);
    expect(v.min).toBeGreaterThan(1);
    expect(v.max).toBe(100);
    expect(v.contiguous).toBe(true);

    // One click walks one page OLDER, contiguous with the window — not
    // the transcript's oldest rows (which would leave a hole between the
    // oldest page and the window on a session this long).
    await page.locator(".load-older").click();
    v = await nums(page);
    expect(v.min).toBeGreaterThan(1); // the walk cannot have reached Q1 yet
    expect(v.contiguous).toBe(true);
    expect(await page.getByText("Question 1:").count()).toBe(0);

    // Walk to the transcript's start: every turn accounted for, no gaps.
    // A click can race the button unmounting as the walk completes —
    // tolerate the lost click, the Q1 check ends the loop.
    for (let i = 0; i < 6; i++) {
      if ((await page.getByText("Question 1:").count()) > 0) break;
      await page.locator(".load-older").click({ timeout: 4_000 }).catch(() => {});
    }
    v = await nums(page);
    expect(v.min).toBe(1);
    expect(v.max).toBe(100);
    expect(v.contiguous).toBe(true);

    // Drop the SSE stream; the reconnect resync re-pulls server truth.
    await fetch(`${rig.api}/__control/ssedrop`);
    await page.waitForTimeout(3_000);

    // The expansion must survive the re-pull.
    await expect(page.getByText("Question 1:")).toBeVisible();
    await expect(page.getByText("Question 100:")).toBeVisible();
  } finally {
    rig.stop();
  }
});

test("the page endpoint rejects a limit above 200", async () => {
  const rig = await startRig({ env: ENV });
  try {
    // The API url is announced the moment the rig server binds, before
    // the fake API child finishes booting — retry the first hit.
    const get = async (path) => {
      for (let i = 0; i < 10; i++) {
        try {
          return await fetch(`${rig.api}${path}`);
        } catch {
          await new Promise((r) => setTimeout(r, 300));
        }
      }
      throw new Error(`fake api unreachable at ${rig.api}`);
    };
    const over = await get("/api/session/ses_seed_1/message?limit=400");
    expect(over.status).toBe(400);
    const ok = await get("/api/session/ses_seed_1/message?limit=200");
    expect(ok.status).toBe(200);
  } finally {
    rig.stop();
  }
});
