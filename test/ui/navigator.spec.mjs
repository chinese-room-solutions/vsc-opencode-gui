// The navigator host (the sidebar view): opening a session is a host
// handoff, never an in-app route — a local row posts open-session (the
// host opens/reveals that session's editor tab) and a foreign row posts
// open-project (the deep link opens its folder in a new window). The
// rig's acquireVsCodeApi stub records every host-directed post in
// window.__hostPosted. The view itself is two collapsible sections —
// Projects above day-grouped Sessions, each with its own search.
import { test, expect } from "./support/fixture.mjs";
import { startRig } from "./support/rig.mjs";

const ENV = {
  OPENCODE_HOST: "navigator",
  OPENCODE_DIALECT: "v2",
  OPENCODE_READY_SOUND: "0",
  OPENCODE_PERMISSION_SOUND: "0",
  OPENCODE_QUESTION_SOUND: "0",
  FAKE_API_HOME_LIST: "1",
};

const posted = (page) => page.evaluate(() => window.__hostPosted ?? []);

test("a local session row posts open-session with the row's id", async ({ page }) => {
  const rig = await startRig({ env: ENV });
  try {
    await page.goto(rig.url);
    const rows = page.locator(".sess-row .sess-open");
    await expect(rows).toHaveCount(7, { timeout: 15_000 });
    await page.evaluate(() => (window.__hostPosted = []));
    await rows.nth(0).click();
    await expect
      .poll(async () => (await posted(page)).at(-1), { timeout: 5_000 })
      .toEqual({ type: "open-session", id: "ses_seed_1" });
  } finally {
    rig.stop();
  }
});

test("a foreign project's row posts open-project deep-linking the session", async ({ page }) => {
  const rig = await startRig({ env: ENV });
  try {
    await page.goto(rig.url);
    // Bulk 4..6 live in `<workspace>-other` — another project's folder.
    const foreign = page.locator(".sess-row", { hasText: "Bulk session 4" });
    await expect(foreign).toHaveCount(1, { timeout: 15_000 });
    await foreign.locator(".sess-open").click();
    const dir = await page.evaluate(
      () =>
        document
          .querySelector('meta[name="opencode-workspace"]')
          .content.replace(/\\/g, "/") + "-other",
    );
    await expect
      .poll(async () => (await posted(page)).at(-1), { timeout: 5_000 })
      .toEqual({ type: "open-project", path: dir, session: "ses_bulk_4" });
  } finally {
    rig.stop();
  }
});

test("both sections render stacked, each with its own search", async ({ page }) => {
  const rig = await startRig({ env: ENV });
  try {
    await page.goto(rig.url);
    const rows = page.locator(".sess-row .sess-open");
    await expect(rows).toHaveCount(7, { timeout: 15_000 });

    // Regression probe ("Projects gone, only Sessions" once seen): the
    // Projects section renders its rows whenever project data exists —
    // both seeded folders (the workspace dir and its -other twin).
    await expect(
      page.locator(".proj-sec .sec-toggle .sec-title"),
    ).toHaveText("Projects");
    await expect(
      page.locator(".sess-sec .sec-toggle .sec-title"),
    ).toHaveText("Sessions");
    const projs = page.locator(".proj-row .proj-open");
    await expect(projs).toHaveCount(2);

    // Each section's search sits at the top of its own body.
    await expect(page.locator(".proj-body .search input")).toHaveAttribute(
      "placeholder",
      "Search projects",
    );
    await expect(page.locator(".sess-body .search input")).toHaveAttribute(
      "placeholder",
      "Search sessions",
    );

    // Projects stacks above Sessions.
    const projHead = await page.locator(".proj-sec .sec-head").boundingBox();
    const sessHead = await page.locator(".sess-sec .sec-head").boundingBox();
    expect(projHead.y).toBeLessThan(sessHead.y);
  } finally {
    rig.stop();
  }
});

test("the two section searches filter independently", async ({ page }) => {
  const rig = await startRig({ env: ENV });
  try {
    await page.goto(rig.url);
    const rows = page.locator(".sess-row .sess-open");
    await expect(rows).toHaveCount(7, { timeout: 15_000 });
    const projs = page.locator(".proj-row .proj-open");

    // The Projects search narrows project rows only — sessions untouched.
    const projSearch = page.locator(".proj-body .search input");
    await projSearch.fill("other");
    await expect(projs).toHaveCount(1);
    await expect(rows).toHaveCount(7);

    // The Sessions search narrows session rows only (6 of 7 are "Bulk
    // session N") — the already-narrow project list stays as it is.
    const sessSearch = page.locator(".sess-body .search input");
    await sessSearch.fill("Bulk");
    await expect(rows).toHaveCount(6);
    await expect(projs).toHaveCount(1);

    // Clearing either restores its own list, the other untouched.
    await projSearch.fill("");
    await expect(projs).toHaveCount(2);
    await expect(rows).toHaveCount(6);
    await sessSearch.fill("");
    await expect(rows).toHaveCount(7);
  } finally {
    rig.stop();
  }
});

test("a project click narrows Sessions to it; clicking again clears", async ({ page }) => {
  const rig = await startRig({ env: ENV });
  try {
    await page.goto(rig.url);
    const rows = page.locator(".sess-row .sess-open");
    await expect(rows).toHaveCount(7, { timeout: 15_000 });

    // Clicking the second project (the -other folder) narrows Sessions
    // to it — 3 of the 7 seeded sessions live there. The selected row
    // carries the outline; clicking again clears both.
    const projs = page.locator(".proj-row .proj-open");
    await projs.nth(1).click();
    await expect(rows).toHaveCount(3);
    await expect(page.locator(".proj-row.selected")).toHaveCount(1);
    await projs.nth(1).click();
    await expect(rows).toHaveCount(7);
    await expect(page.locator(".proj-row.selected")).toHaveCount(0);
  } finally {
    rig.stop();
  }
});

test("each section collapses and expands from its header", async ({ page }) => {
  const rig = await startRig({ env: ENV });
  try {
    await page.goto(rig.url);
    const rows = page.locator(".sess-row .sess-open");
    await expect(rows).toHaveCount(7, { timeout: 15_000 });

    // Collapse Projects: its body (search and rows) is gone; Sessions
    // keeps its rows.
    await page.locator(".proj-sec .sec-toggle").click();
    await expect(page.locator(".proj-body")).toHaveCount(0);
    await expect(page.locator(".proj-sec .sec-toggle.closed")).toHaveCount(1);
    await expect(rows).toHaveCount(7);

    // Collapse Sessions too: both bodies gone, both headers stay.
    await page.locator(".sess-sec .sec-toggle").click();
    await expect(page.locator(".sess-body")).toHaveCount(0);
    await expect(page.locator(".sess-sec .sec-toggle.closed")).toHaveCount(1);
    await expect(page.locator(".sec-head")).toHaveCount(2);

    // Expand both: rows return.
    await page.locator(".proj-sec .sec-toggle").click();
    await page.locator(".sess-sec .sec-toggle").click();
    await expect(page.locator(".proj-row .proj-open")).toHaveCount(2);
    await expect(rows).toHaveCount(7);
  } finally {
    rig.stop();
  }
});

test("dragging the split resizes Projects against Sessions", async ({ page }) => {
  const rig = await startRig({ env: ENV });
  try {
    await page.goto(rig.url);
    const rows = page.locator(".sess-row .sess-open");
    await expect(rows).toHaveCount(7, { timeout: 15_000 });

    const height = (sel) =>
      page.locator(sel).evaluate((el) => el.getBoundingClientRect().height);
    const projBefore = await height(".proj-sec");
    const sessBefore = await height(".sess-sec");

    // Drag the border down 100px: the border follows the mouse, so
    // Projects grows and Sessions gives it up.
    const split = page.locator(".nav-split");
    const box = await split.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 100, {
      steps: 6,
    });
    await page.mouse.up();
    await expect
      .poll(() => height(".proj-sec"))
      .toBeCloseTo(projBefore + 100, 0);
    expect(await height(".sess-sec")).toBeCloseTo(sessBefore - 100, 0);

    // Collapsing drops the divider; the dragged height returns on expand.
    await page.locator(".proj-sec .sec-toggle").click();
    await expect(split).toHaveCount(0);
    await page.locator(".proj-sec .sec-toggle").click();
    await expect(height(".proj-sec")).resolves.toBeCloseTo(projBefore + 100, 0);
  } finally {
    rig.stop();
  }
});

test("the split defaults to half and survives a reload", async ({ page }) => {
  const rig = await startRig({ env: ENV });
  try {
    await page.goto(rig.url);
    await expect(page.locator(".sess-row").first()).toBeVisible({ timeout: 15_000 });
    const height = (sel) =>
      page.locator(sel).evaluate((el) => el.getBoundingClientRect().height);
    const homeH = await page.locator(".home").evaluate((el) => el.clientHeight);

    // Fresh boot, nothing stored: half and half.
    await expect.poll(() => height(".proj-sec")).toBeCloseTo(homeH / 2, -1);

    // Drag 100px down, then reload: the proportion comes back (same
    // viewport, same pixels).
    const split = page.locator(".nav-split");
    const box = await split.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      box.x + box.width / 2,
      box.y + box.height / 2 + 100,
      { steps: 4 },
    );
    await page.mouse.up();
    const dragged = await height(".proj-sec");
    await expect.poll(() => height(".proj-sec")).toBeCloseTo(homeH / 2 + 100, -1);

    await page.reload();
    await expect(page.locator(".sess-row").first()).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => height(".proj-sec")).toBeCloseTo(dragged, 0);
  } finally {
    rig.stop();
  }
});
