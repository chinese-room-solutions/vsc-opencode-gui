// Skill tool rows: the pill names the skill that loaded, like Shell names
// its command. FAKE_API_SKILL seeds a completed skill call on the last
// turn (the durable wire shape: input.name + title + metadata.name).
import { test, expect } from "./support/fixture.mjs";
import { startRig } from "./support/rig.mjs";

const ENV = {
  OPENCODE_ROUTE: JSON.stringify({ view: "session", id: "ses_seed_1" }),
  OPENCODE_TABS: JSON.stringify(["ses_seed_1"]),
  OPENCODE_DIALECT: "v2",
  OPENCODE_READY_SOUND: "0",
  OPENCODE_PERMISSION_SOUND: "0",
  OPENCODE_QUESTION_SOUND: "0",
  FAKE_API_SKILL: "1",
};

test("a skill call's row names the skill", async ({ page }) => {
  const rig = await startRig({ env: ENV });
  try {
    await page.goto(rig.url);
    const card = page
      .locator(".tool")
      .filter({ has: page.locator(".tool-name", { hasText: "Skill" }) });
    await expect(card).toHaveCount(1, { timeout: 15_000 });
    await expect(card.locator(".tool-pill")).toHaveText("concise");
  } finally {
    rig.stop();
  }
});
