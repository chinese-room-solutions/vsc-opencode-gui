// Home multiselect: Ctrl+Click toggles one row; Shift+Click works the
// span from the anchor, its direction read off the anchor's own state —
// a picked anchor adds (adjacent blocks merge), an unpicked anchor
// removes. Picks are sessions-or-projects, never both. One floating
// Delete docked bottom-center runs the bulk delete through a confirm;
// Esc or a click landing on no row drops the picks. FAKE_API_HOME_LIST
// seeds six extra sessions across two project folders; display order is
// seeded, then Bulk 6..1.
import { test, expect } from "./support/fixture.mjs";
import { startRig } from "./support/rig.mjs";

const ENV = {
  OPENCODE_ROUTE: JSON.stringify({ view: "home" }),
  OPENCODE_TABS: JSON.stringify([]),
  OPENCODE_DIALECT: "v2",
  OPENCODE_READY_SOUND: "0",
  OPENCODE_PERMISSION_SOUND: "0",
  OPENCODE_QUESTION_SOUND: "0",
  FAKE_API_HOME_LIST: "1",
};

async function homeRig() {
  return startRig({ env: ENV });
}

test("shift follows the anchor: picked adds and merges, unpicked removes", async ({ page }) => {
  const rig = await homeRig();
  try {
    await page.goto(rig.url);
    const rows = page.locator(".sess-row .sess-open");
    await expect(rows).toHaveCount(7, { timeout: 15_000 });
    const dock = page.locator(".pick-delete");

    // Ctrl+Click two singles; the anchor rides the last one (row 3).
    await rows.nth(0).click({ modifiers: ["Control"] });
    await rows.nth(3).click({ modifiers: ["Control"] });
    await expect(dock).toHaveText("Delete 2 sessions");

    // Shift from the picked anchor adds the span — row 0's pick and the
    // 3..5 block are neighbors merged by nothing but the set.
    await rows.nth(5).click({ modifiers: ["Shift"] });
    await expect(dock).toHaveText("Delete 4 sessions");
    await expect(page.locator(".sess-row.picked")).toHaveCount(4);

    // Repeating the shift never flips: the anchor stays picked, the span
    // stays added.
    await rows.nth(5).click({ modifiers: ["Shift"] });
    await expect(dock).toHaveText("Delete 4 sessions");

    // Unpick the anchor (Ctrl toggles it off), shift the same span: the
    // unpicked anchor removes it — unselect-many.
    await rows.nth(3).click({ modifiers: ["Control"] });
    await rows.nth(5).click({ modifiers: ["Shift"] });
    await expect(dock).toHaveText("Delete 1 session");

    // Last pick off: no dock at all.
    await rows.nth(0).click({ modifiers: ["Control"] });
    await expect(page.locator(".pick-dock")).toHaveCount(0);
  } finally {
    rig.stop();
  }
});

test("escape and a click outside the rows drop the picks", async ({ page }) => {
  const rig = await homeRig();
  try {
    await page.goto(rig.url);
    const rows = page.locator(".sess-row .sess-open");
    await expect(rows).toHaveCount(7, { timeout: 15_000 });

    await rows.nth(1).click({ modifiers: ["Control"] });
    await rows.nth(2).click({ modifiers: ["Control"] });
    await expect(page.locator(".pick-dock")).toHaveCount(1);

    await page.keyboard.press("Escape");
    await expect(page.locator(".pick-dock")).toHaveCount(0);
    await expect(page.locator(".sess-row.picked")).toHaveCount(0);

    // A click on the Projects heading lands on no row: picks drop.
    await rows.nth(1).click({ modifiers: ["Control"] });
    await page.locator(".home-h").click();
    await expect(page.locator(".pick-dock")).toHaveCount(0);

    // A plain click on a row keeps the picks (it opens the session
    // instead) — the picks survive the trip back.
    await rows.nth(1).click({ modifiers: ["Control"] });
    await expect(page.locator(".pick-dock")).toHaveCount(1);
  } finally {
    rig.stop();
  }
});

test("loading older sessions keeps the picks", async ({ page }) => {
  const rig = await startRig({ env: { ...ENV, FAKE_API_PAGINATE: "1" } });
  try {
    await page.goto(rig.url);
    const rows = page.locator(".sess-row .sess-open");
    await expect(rows.first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".load-older")).toHaveCount(1);

    await rows.nth(1).click({ modifiers: ["Control"] });
    await rows.nth(2).click({ modifiers: ["Control"] });
    await expect(page.locator(".pick-delete")).toHaveText("Delete 2 sessions");

    // The button sits outside the rows; clicking it grows the list the
    // picks live in — it must not drop them.
    await page.locator(".load-older").click();
    await expect(rows).toHaveCount(53);
    await expect(page.locator(".load-older")).toHaveCount(0);
    await expect(page.locator(".pick-delete")).toHaveText("Delete 2 sessions");
    await expect(page.locator(".sess-row.picked")).toHaveCount(2);
  } finally {
    rig.stop();
  }
});

test("picked sessions bulk-delete through the confirm dialog", async ({ page }) => {
  const rig = await homeRig();
  try {
    await page.goto(rig.url);
    const rows = page.locator(".sess-row .sess-open");
    await expect(rows).toHaveCount(7, { timeout: 15_000 });

    await rows.nth(1).click({ modifiers: ["Control"] });
    await rows.nth(2).click({ modifiers: ["Control"] });
    await rows.nth(4).click({ modifiers: ["Control"] });
    await page.locator(".pick-delete").click();
    await expect(page.locator(".confirm .confirm-text")).toHaveText(
      "Delete 3 sessions? They cannot be recovered.",
    );
    await page.locator(".confirm .confirm-danger").click();

    await expect(rows).toHaveCount(4);
    await expect(page.locator(".pick-dock")).toHaveCount(0);
    await expect(page.locator(".sess-row", { hasText: "Bulk session 6" })).toHaveCount(0);
    await expect(page.locator(".sess-row", { hasText: "Bulk session 1" })).toHaveCount(1);
  } finally {
    rig.stop();
  }
});

test("project picks replace session picks and purge through the dialog", async ({ page }) => {
  const rig = await homeRig();
  try {
    await page.goto(rig.url);
    const projs = page.locator(".proj-row .proj-open");
    const rows = page.locator(".sess-row .sess-open");
    await expect(projs).toHaveCount(2, { timeout: 15_000 });
    await expect(rows).toHaveCount(7);

    // Sessions or projects, never both: the first project pick drops
    // the session picks (and the dock flips wording).
    await rows.nth(0).click({ modifiers: ["Control"] });
    await expect(page.locator(".pick-delete")).toHaveText("Delete 1 session");
    await projs.nth(0).click({ modifiers: ["Control"] });
    await expect(page.locator(".pick-delete")).toHaveText("Delete 1 project");
    await expect(page.locator(".sess-row.picked")).toHaveCount(0);

    await projs.nth(1).click({ modifiers: ["Control"] });
    await expect(page.locator(".pick-delete")).toHaveText("Delete 2 projects");

    await page.locator(".pick-delete").click();
    await expect(page.locator(".confirm .confirm-text")).toHaveText(
      "Delete 2 projects and all their sessions? The sessions cannot be recovered.",
    );
    await page.locator(".confirm .confirm-danger").click();

    // Both worktrees tombstone: no project rows, and no sessions left to
    // list (every seeded session lives in one of the two folders).
    await expect(projs).toHaveCount(0);
    await expect(page.locator(".sess-row")).toHaveCount(0);
    await expect(page.locator(".pick-dock")).toHaveCount(0);
  } finally {
    rig.stop();
  }
});
