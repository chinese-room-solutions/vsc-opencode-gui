// Esc in a child (sub-agent) drill-down returns to the parent — the
// breadcrumb's move — but only when no other Esc affordance claims the
// key: an open confirm dialog's Esc cancels the dialog and leaves the
// child view in place. Runs against the fake-API rig; the seeded parent
// (ses_seed_1) carries two settled task chips that open ses_child_1.
import { test, expect, openSession } from "./support/fixture.mjs";

// Preact attaches a component's window listeners a frame after its DOM
// paints (deferred useEffect). A selector assertion can pass inside that
// window, so let passive effects flush before driving the key.
async function settleEffects(page) {
  await page.evaluate(
    () =>
      new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done())),
      ),
  );
  await page.waitForTimeout(25);
}

async function openChild(page, url) {
  await openSession(page, url);
  await page.locator(".subagent-chip").nth(0).click();
  await page.waitForSelector(".crumb-parent");
  await settleEffects(page);
}

test("Escape returns a child drill-down to its parent", async ({ page, rig }) => {
  await openChild(page, rig.url);
  await page.keyboard.press("Escape");
  await expect(page.locator(".crumb-parent")).toHaveCount(0);
  // Back on the parent: its transcript carries the two chips again.
  await expect(page.locator(".subagent-chip")).toHaveCount(2);
});

test("Escape cancels an open confirm and keeps the child view", async ({ page, rig }) => {
  await openChild(page, rig.url);
  // The chat's own menu → Delete session raises the in-app confirm.
  await page.locator(".msgs .turn .msg.user").first().click({ button: "right" });
  const menu = page.locator(".row-menu");
  await expect(menu).toBeVisible();
  await menu.locator('.menu-item:has-text("Delete session")').click();
  const dialog = page.locator(".confirm-backdrop");
  await expect(dialog).toHaveCount(1);
  await settleEffects(page);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".crumb-parent")).toHaveCount(1);
});

test("Enter runs the confirm's danger action", async ({ page, rig }) => {
  await openChild(page, rig.url);
  await page.locator(".msgs .turn .msg.user").first().click({ button: "right" });
  const menu = page.locator(".row-menu");
  await expect(menu).toBeVisible();
  await menu.locator('.menu-item:has-text("Delete session")').click();
  const dialog = page.locator(".confirm-backdrop");
  await expect(dialog).toHaveCount(1);
  await settleEffects(page);
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  // Confirmed, not cancelled: the child's transcript drops from the view.
  await expect(page.locator(".msgs .turn")).toHaveCount(0);
});
