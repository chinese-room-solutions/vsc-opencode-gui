// The navigator host (the sidebar view): opening a session is a host
// handoff, never an in-app route — a local row posts open-session (the
// host opens/reveals that session's editor tab) and a foreign row posts
// open-project (the deep link opens its folder in a new window). The
// rig's acquireVsCodeApi stub records every host-directed post in
// window.__hostPosted.
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
