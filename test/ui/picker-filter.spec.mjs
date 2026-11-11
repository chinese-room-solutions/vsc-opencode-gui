// The picker cursor follows filtering: the model menu reseeds its keyboard
// cursor whenever the row set changes, so Enter confirms the row the filter
// highlighted — it never clamps onto the last row of the narrowed list.
import { test, expect, openSession, watchPage } from "./support/fixture.mjs";

test("Enter after a filter picks the highlighted row", async ({ page, rig }) => {
  const watched = watchPage(page);
  await openSession(page, rig.url);
  await page.click('.comp-chip[title="Model"]');
  const menu = page.locator(".pop-model");
  await expect(menu).toBeVisible();
  // The session's model starts highlighted. Two Downs park the cursor on
  // the last row — the stale position a mount-only cursor would keep.
  await expect(menu.locator(".menu-item.active")).toHaveText(/Fake Model/);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(menu.locator(".menu-item.active")).toHaveText(/Fake Mini/);
  // A filter that keeps two rows: the cursor must follow the filtering, so
  // the highlight lands on a real row and Enter confirms it.
  await page.keyboard.type("o");
  await expect(menu.locator(".menu-item")).toHaveCount(2);
  // The reseeded cursor highlights a real row; a stale mount-only cursor
  // would sit past the end with nothing highlighted.
  await expect(menu.locator(".menu-item.active")).toHaveCount(1);
  const highlighted =
    (await menu
      .locator(".menu-item.active .menu-label")
      .textContent())?.trim() ?? "";
  await page.keyboard.press("Enter");
  await expect(
    page.locator('.comp-chip[title="Model"] .comp-chip-label'),
  ).toHaveText(highlighted);
  expect(watched.errors).toEqual([]);
});
