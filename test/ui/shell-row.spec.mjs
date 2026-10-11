// Native shell rows (commands run in the session's directory, delivered
// as session.shell.started/ended) run outside any model turn — nothing
// streams their output. FAKE_API_SHELL seeds a live one whose output
// grows chunk by chunk per poll, and a durable running row whose shell no
// registry holds (the shape a server restart leaves). Specs: the tail
// streams into the card, stop kills the command server-side, and the
// orphaned row heals instead of spinning forever.
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

const cardBy = (page, pill) =>
  page.locator(".tool").filter({
    has: page.locator(".tool-pill", { hasText: pill }),
  });

test("a running native shell streams output into its card", async ({ page }) => {
  const rig = await startRig({ env: ENV });
  try {
    await page.goto(rig.url);
    const card = cardBy(page, "npm run watch");
    await expect(card).toHaveCount(1, { timeout: 15_000 });
    // Running: the stop control shows and the row is not settled.
    await expect(card.locator(".tool-stop")).toHaveCount(1);
    await expect(card.locator(".tool-dot")).toHaveClass(/running/);
    // The chunks arrive only through the tail poller — the started frame
    // and the fixture rows carry no output.
    await card.locator(".tool-row.expander").click();
    const out = card.locator(".tool-body-row", { hasText: "OUT" }).locator(".tool-body-text");
    await expect(out).toContainText("watching for changes...", { timeout: 10_000 });
    await expect(out).toContainText("rebuilt src/main.ts", { timeout: 10_000 });
  } finally {
    rig.stop();
  }
});

test("stopping a native shell kills it server-side and settles the row", async ({ page }) => {
  const rig = await startRig({ env: ENV });
  try {
    await page.goto(rig.url);
    const card = cardBy(page, "npm run watch");
    await expect(card.locator(".tool-stop")).toHaveCount(1, { timeout: 15_000 });
    await card.locator(".tool-stop").click();
    // The DELETE reached the server's shell registry.
    const deletes = async () =>
      (await (await fetch(`${rig.api}/__control/shell`)).json()).deletes;
    await expect
      .poll(async () => (await deletes()).some((d) => d.id === "shl_live_1"))
      .toBe(true);
    // The ended frame settles the row.
    await expect(card.locator(".tool-stop")).toHaveCount(0, { timeout: 10_000 });
    await expect(card.locator(".tool-dot")).not.toHaveClass(/running/);
  } finally {
    rig.stop();
  }
});

test("a running row whose shell vanished settles with a note", async ({ page }) => {
  const rig = await startRig({ env: ENV });
  try {
    await page.goto(rig.url);
    const card = cardBy(page, "cargo build");
    await expect(card).toHaveCount(1, { timeout: 15_000 });
    // The tail poller asks the server, gets a 404, settles the row.
    await expect(card.locator(".tool-stop")).toHaveCount(0, { timeout: 10_000 });
    await expect(card.locator(".tool-dot")).not.toHaveClass(/running/);
    await card.locator(".tool-row.expander").click();
    await expect(card.locator(".tool-body-text").last()).toContainText(
      "no longer running on the server",
      { timeout: 5_000 },
    );
  } finally {
    rig.stop();
  }
});
