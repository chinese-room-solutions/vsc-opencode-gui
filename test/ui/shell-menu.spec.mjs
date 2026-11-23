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
    const xs = () =>
      page.evaluate(() =>
        [".sam-btn", ".sjm-btn"].map((s) => document.querySelector(s).getBoundingClientRect().x),
      );
    const running = await xs();
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
    await expect(page.locator(".sjm")).toHaveClass(/idle/);
    // Going idle moves neither head button.
    expect(await xs()).toEqual(running);
    await page.screenshot({ path: "test/ui/out/shell-menu-stopped.png" });
    // Closing the menu drops the settled row. The button stays, idle, and
    // reopens on an empty roster.
    await page.locator(".sjm .backdrop").click();
    await expect(btn).toHaveCount(1);
    await btn.click();
    await expect(page.locator(".sjm-menu .sjm-empty")).toHaveText("None running");
    await expect(page.locator(".sjm-menu .sjm-chip")).toHaveCount(0);
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
    // Collapsing the settled row drops it: nothing runs, the menu says so.
    await chip.click();
    await expect(chip).toHaveCount(0);
    await expect(page.locator(".sjm-menu .sjm-empty")).toHaveText("None running");
  } finally {
    rig.stop();
  }
});

// The row's terminal button hands the command to the host, which streams
// its whole output into a terminal tab. The rig records host posts.
test("the terminal button asks the host for the command's terminal", async ({ page }) => {
  const rig = await startRig({ env: ENV });
  try {
    await page.goto(rig.url);
    await page.locator(".sjm-btn").click();
    const chip = page.locator(".sjm-menu .sjm-chip");
    await expect(chip.locator(".sjm-cmd")).toHaveText("npm run watch", { timeout: 15_000 });
    await page.evaluate(() => (window.__hostPosted = []));
    await chip.getByRole("button", { name: "Open the output in a terminal" }).click();
    await expect
      .poll(async () => (await page.evaluate(() => window.__hostPosted ?? [])).at(-1))
      .toMatchObject({ type: "open-shell-terminal", id: "shl_live_1", command: "npm run watch" });
    // The click doesn't toggle the row, and the menu closes behind it.
    await expect(page.locator(".sjm-menu")).toHaveCount(0);
  } finally {
    rig.stop();
  }
});
