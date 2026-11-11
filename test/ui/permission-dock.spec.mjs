// The permission dock keeps redirect drafts by request id: answering one
// ask drops its tab and the survivors shift left, so an index-aligned
// draft store would show the remaining ask an empty box (or a neighbor's
// text). The rig's /__control/ask seeds two asks on the permission.asked
// envelope (v2 dialect, like popover-ask: the dock and its answers are v2
// surface); the dock answers on the v2 per-session reply route.
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

const ask = (rig, body) =>
  fetch(`${rig.api}/__control/ask`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("a survivor's redirect draft survives an earlier ask's answer", async ({
  page,
}) => {
  const rig = await startRig({ env: rigEnv() });
  try {
    await page.goto(rig.url);
    await page.waitForSelector(".msgs .turn .msg.user", { timeout: 15_000 });
    await ask(rig, { id: "perm_rig1", action: "bash", resources: ["rm -rf /tmp/one"] });
    await ask(rig, { id: "perm_rig2", action: "write", resources: ["/repo/two.txt"] });
    const dock = page.locator('[data-testid="permission-dock"]');
    await expect(dock).toBeVisible();
    await expect(dock.locator(".dock-tab")).toHaveCount(2);
    // Type a redirect on the second ask, then answer the first one.
    await dock.locator('.dock-tab:has-text("/repo/two.txt")').click();
    await dock.locator(".dock-input").fill("use another path");
    await dock.locator('.dock-tab:has-text("rm -rf /tmp/one")').click();
    await dock.locator(".dock-choice").first().click();
    // The answered tab drops and the second ask lands first — still holding
    // its draft, because the draft keys by request id, not tab position.
    await expect(dock.locator(".dock-tab")).toHaveCount(1);
    await expect(dock.locator(".dock-tab")).toHaveText("/repo/two.txt");
    await expect(dock.locator(".dock-input")).toHaveValue("use another path");
  } finally {
    rig.stop();
  }
});
