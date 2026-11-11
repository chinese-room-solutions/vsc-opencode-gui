// Modified digit keys never answer the permission dock: the dock's
// capture-phase window listener only owns bare digits — a workbench chord
// (Ctrl+2 = "move editor to group 2") pressed while an ask is up must not
// fire its numbered reply ("Yes, and don't ask again"). The rig is a plain
// browser, so the DOM handler is the thing under test; v2 dialect like
// popover-ask, with a save option so digit 2 is "always".
import { test, expect } from "@playwright/test";
import { startRig } from "./support/rig.mjs";

const rigEnv = () => ({
  OPENCODE_ROUTE: JSON.stringify({ view: "session", id: "ses_seed_1" }),
  OPENCODE_TABS: JSON.stringify(["ses_seed_1"]),
  OPENCODE_DIALECT: "v2",
  OPENCODE_READY_SOUND: "0",
  OPENCODE_PERMISSION_SOUND: "0",
  OPENCODE_QUESTION_SOUND: "0",
});

const ask = (rig) =>
  fetch(`${rig.api}/__control/ask`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: "perm_rig1",
      action: "bash",
      resources: ["npm test"],
      save: ["bash"],
    }),
  });

const replies = async (rig) =>
  (await (await fetch(`${rig.api}/__control/perm-replies`)).json()).replies;

test("Ctrl+2 leaves the dock alone; bare 2 answers it", async ({ page }) => {
  const rig = await startRig({ env: rigEnv() });
  try {
    await page.goto(rig.url);
    await page.waitForSelector(".msgs .turn .msg.user", { timeout: 15_000 });
    await ask(rig);
    const dock = page.locator('[data-testid="permission-dock"]');
    await expect(dock).toBeVisible();
    // The typing guard would mask the bug if focus sat in an input — the
    // keys only reach the dock from outside INPUT/TEXTAREA.
    const focusTag = () =>
      page.evaluate(() => document.activeElement?.tagName ?? "");
    expect(await focusTag()).not.toBe("INPUT");
    expect(await focusTag()).not.toBe("TEXTAREA");
    // The workbench chord does nothing: the dock stays and no reply left.
    await page.keyboard.press("Control+2");
    await page.waitForTimeout(300);
    await expect(dock).toBeVisible();
    expect(await replies(rig)).toEqual([]);
    // The bare digit answers: 2 = "Yes, and don't ask again".
    await page.keyboard.press("2");
    await expect(dock).toHaveCount(0);
    await expect.poll(() => replies(rig)).toHaveLength(1);
    expect((await replies(rig))[0].decision).toBe("always");
  } finally {
    rig.stop();
  }
});
