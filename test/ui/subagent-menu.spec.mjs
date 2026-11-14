// The roster counts sub-agents, not task parts. FAKE_API_DUP_CHILD seeds
// two live task parts bound to the SAME child session — the wire shape a
// steer re-opening a child leaves (or the title fallback double-binding
// same-labeled spawns) — and the menu must list that child once: one
// badge count, one row, one chip.
import { test, expect } from "./support/fixture.mjs";
import { startRig } from "./support/rig.mjs";

test("the roster lists a twice-bound child session once", async ({ page }) => {
  const rig = await startRig({
    env: {
      OPENCODE_ROUTE: JSON.stringify({ view: "session", id: "ses_seed_1" }),
      OPENCODE_TABS: JSON.stringify(["ses_seed_1"]),
      OPENCODE_DIALECT: "v2",
      OPENCODE_READY_SOUND: "0",
      OPENCODE_PERMISSION_SOUND: "0",
      OPENCODE_QUESTION_SOUND: "0",
      FAKE_API_DUP_CHILD: "1",
    },
  });
  try {
    await page.goto(rig.url);
    const btn = page.locator(".sam-btn");
    await btn.waitFor({ timeout: 15_000 });
    await expect(btn.locator(".sam-count")).toHaveText("1");
    await btn.click();
    await expect(page.locator(".sam-row")).toHaveCount(1);
    await expect(page.locator(".sam-menu .subagent-chip")).toHaveCount(1);
  } finally {
    rig.stop();
  }
});

// Every row spans the widest chip: the stop buttons line up and a shorter
// agent name hands its slack to the description. FAKE_API_ROSTER keeps a
// second child working under a longer agent name.
test("roster rows share the widest chip's width", async ({ page }) => {
  const rig = await startRig({
    env: {
      OPENCODE_ROUTE: JSON.stringify({ view: "session", id: "ses_seed_1" }),
      OPENCODE_TABS: JSON.stringify(["ses_seed_1"]),
      OPENCODE_DIALECT: "v2",
      OPENCODE_READY_SOUND: "0",
      OPENCODE_PERMISSION_SOUND: "0",
      OPENCODE_QUESTION_SOUND: "0",
      FAKE_API_ROSTER: "1",
    },
  });
  try {
    await page.goto(rig.url);
    const btn = page.locator(".sam-btn");
    await btn.waitFor({ timeout: 15_000 });
    await expect(btn.locator(".sam-count")).toHaveText("2");
    await btn.click();
    const chips = page.locator(".sam-menu .subagent-chip");
    await expect(chips.locator(".subagent-stop")).toHaveCount(2);
    const rows = await chips.evaluateAll((els) =>
      els.map((el) => {
        const name = el.querySelector(".subagent-agent");
        const desc = el.querySelector(".subagent-desc");
        return {
          name: name.textContent,
          nameClipped: name.scrollWidth > name.clientWidth,
          width: el.getBoundingClientRect().width,
          stopRight: el.querySelector(".subagent-stop").getBoundingClientRect().right,
          desc: desc.getBoundingClientRect().width,
          descClipped: desc.scrollWidth > desc.clientWidth,
        };
      }),
    );
    const [short, long] = rows;
    expect(short.name).toBe("General");
    expect(long.name).toBe("Oc-Model-Glm-5-3-Flash");
    expect(Math.abs(short.width - long.width)).toBeLessThan(0.5);
    expect(Math.abs(short.stopRight - long.stopRight)).toBeLessThan(0.5);
    // The widest chip keeps its name whole and its 16ch slot, so the menu
    // doesn't grow to fit full descriptions.
    expect(long.nameClipped).toBe(false);
    expect(long.descClipped).toBe(true);
    // The shorter name's slack shows its whole task.
    expect(short.desc).toBeGreaterThan(long.desc);
    expect(short.descClipped).toBe(false);
  } finally {
    rig.stop();
  }
});
