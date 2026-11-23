// The head's background-command roster. FAKE_API_SHELL seeds a running
// command (npm run watch) the server's listing owns to the open session,
// its output growing one chunk per poll. The roster lists it with its
// elapsed time, streams its output in a pane under the row (read from the
// server, never by adding a transcript row), stops it server-side, and
// keeps a command that ends while shown listed with its end state.
import { test, expect } from "./support/fixture.mjs";
import { startRig } from "./support/rig.mjs";

const ENV = {
  OPENCODE_ROUTE: JSON.stringify({ view: "session", id: "ses_seed_1" }),
  OPENCODE_TABS: JSON.stringify(["ses_seed_1"]),
  OPENCODE_DIALECT: "v2",
  OPENCODE_READY_SOUND: "0",
  OPENCODE_PERMISSION_SOUND: "0",
  OPENCODE_QUESTION_SOUND: "0",
  FAKE_API_SHELL: "1",
};

async function openPane(page) {
  const btn = page.locator(".sjm-btn");
  await btn.waitFor({ timeout: 15_000 });
  await expect(btn.locator(".sjm-count")).toHaveText("1");
  await btn.click();
  const chip = page.locator(".sjm-menu .sjm-chip");
  await expect(chip).toHaveCount(1);
  await expect(chip.locator(".sjm-cmd")).toHaveText("npm run watch");
  // The whole chip's hover shows the full command.
  await expect(chip).toHaveAttribute("title", "npm run watch");
  await expect(chip.locator(".sjm-time")).toHaveText(/^\d+s$/);
  await chip.click();
  const out = page.locator(".sjm-menu .sjm-out");
  await expect(out).toContainText("watching for changes...", { timeout: 10_000 });
  await expect(out).toContainText("rebuilt src/main.ts", { timeout: 10_000 });
  return { btn, chip, out };
}

test("the roster streams a command's output and stops it", async ({ page }) => {
  const rig = await startRig({ env: ENV });
  try {
    await page.goto(rig.url);
    const { btn, chip, out } = await openPane(page);
    // The transcript keeps its one row for the command.
    await expect(
      page.locator(".msgs .tool-pill", { hasText: "npm run watch" }),
    ).toHaveCount(1);
    await page.screenshot({ path: "test/ui/out/shell-menu-open.png" });
    await chip.locator(".sjm-stop").click();
    const deletes = async () =>
      (await (await fetch(`${rig.api}/__control/shell`)).json()).deletes;
    await expect
      .poll(async () => (await deletes()).some((d) => d.id === "shl_live_1"))
      .toBe(true);
    // The row settles in place and keeps the output it read.
    await expect(chip.locator(".sjm-stop")).toHaveCount(0, { timeout: 10_000 });
    await expect(chip.locator(".sjm-time")).toHaveText("Stopped");
    await expect(out).toContainText("rebuilt src/main.ts");
    await expect(btn.locator(".sjm-count")).toHaveText("0");
    await page.screenshot({ path: "test/ui/out/shell-menu-stopped.png" });
    // Closing the menu drops the settled row, and the button with it.
    await page.locator(".sjm .backdrop").click();
    await expect(page.locator(".sjm-btn")).toHaveCount(0);
  } finally {
    rig.stop();
  }
});

test("a command that exits while shown stays listed with its exit code", async ({ page }) => {
  const rig = await startRig({ env: ENV });
  try {
    await page.goto(rig.url);
    const { chip, out } = await openPane(page);
    await fetch(`${rig.api}/__control/shell-exit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ exit: 2 }),
    });
    await expect(chip.locator(".sjm-time")).toHaveText("Exit 2", { timeout: 10_000 });
    await expect(chip.locator(".sjm-time")).toHaveClass(/failed/);
    await expect(chip.locator(".pixel-mark.failed")).toHaveCount(1);
    await expect(out).toContainText("rebuilt src/main.ts");
    // Collapsing the settled row drops it: nothing runs, the menu closes.
    await chip.click();
    await expect(page.locator(".sjm-btn")).toHaveCount(0);
  } finally {
    rig.stop();
  }
});
