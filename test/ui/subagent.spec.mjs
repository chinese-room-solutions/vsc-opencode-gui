// Sub-agent chip sizing: the chip is content-sized — the agent name plus a
// constant description slot and the stop button — not a fixed width, so a
// long model name can no longer overflow the chip and push the stop button
// outside its border (the reported defect). Runs against the fake-API rig;
// the seeded last turn carries two settled task chips (support/fake-api.mjs).
import { test, expect, openSession } from "./support/fixture.mjs";
import { startRig } from "./support/rig.mjs";

test("chip width follows the agent name, description stays a constant slot", async ({ page, rig }) => {
  await openSession(page, rig.url);
  const chips = page.locator(".subagent-chip");
  await expect(chips).toHaveCount(2);
  const short = chips.nth(0);
  const long = chips.nth(1);
  await expect(short.locator(".subagent-agent")).toHaveText("General");
  await expect(long.locator(".subagent-agent")).toHaveText(
    "Oc-Model-Ai-Gateway-Fireworks-Glm-5-3-Flash",
  );
  const shortBox = await short.evaluate((el) => el.getBoundingClientRect().width);
  const longBox = await long.evaluate((el) => el.getBoundingClientRect().width);
  expect(longBox).toBeGreaterThan(shortBox);
  // At the rig's column width the long name renders in full, not clipped.
  const clipped = await long
    .locator(".subagent-agent")
    .evaluate((el) => el.scrollWidth > el.clientWidth);
  expect(clipped).toBe(false);
  // The description ellipsizes past its constant 16ch slot.
  const descClipped = await long
    .locator(".subagent-desc")
    .evaluate((el) => el.scrollWidth > el.clientWidth);
  expect(descClipped).toBe(true);
  // The chip stays inside the transcript column.
  const within = await long.evaluate((el) => {
    const col = el.closest(".msgs").getBoundingClientRect();
    return el.getBoundingClientRect().right <= col.right + 1;
  });
  expect(within).toBe(true);
});

test("the stop button never leaves the chip's border", async ({ page, rig }) => {
  await openSession(page, rig.url);
  const chip = page.locator(".subagent-chip").nth(1);
  await expect(chip).toBeVisible();
  // The button renders only while running; settle for the structural claim:
  // with width:max-content the chip grows to contain anything appended to
  // it, so the reported overflow (button past the border) cannot occur.
  const contained = await chip.evaluate((el) => {
    const b = document.createElement("button");
    b.className = "subagent-stop";
    el.appendChild(b);
    const out =
      b.getBoundingClientRect().right <= el.getBoundingClientRect().right + 0.5;
    b.remove();
    return out;
  });
  expect(contained).toBe(true);
});

// A running foreground sub-agent's run-in-background affordance. Runs on a
// dedicated v2-dialect rig (the shared fixture bakes v1; the fake serves
// both surfaces). The seeded child session (ses_child_1) is busy: the first
// chip runs off the child's status, so the affordance renders; the second
// chip has no live child and offers nothing.
test("a running foreground sub-agent offers run-in-background and posts on click", async ({ page }) => {
  const rig = await startRig({
    env: {
      OPENCODE_ROUTE: JSON.stringify({ view: "session", id: "ses_seed_1" }),
      OPENCODE_TABS: JSON.stringify(["ses_seed_1"]),
      OPENCODE_DIALECT: "v2",
      OPENCODE_READY_SOUND: "0",
      OPENCODE_PERMISSION_SOUND: "0",
      OPENCODE_QUESTION_SOUND: "0",
    },
  });
  try {
    // Not openSession: the running chip's pulse perturbs the scroller's
    // at-bottom settle, which this spec doesn't care about.
    await page.goto(rig.url);
    const chips = page.locator(".subagent-chip");
    await chips.nth(0).waitFor({ timeout: 15_000 });
    const running = chips.nth(0);
    const settled = chips.nth(1);
    await expect(running.locator(".subagent-bg")).toBeVisible();
    await expect(running.locator(".subagent-bg")).toHaveAttribute(
      "title",
      /background/,
    );
    await expect(settled.locator(".subagent-bg")).toHaveCount(0);
    // Clicking must stay on the chip (no child drill-down) — only the
    // parent's background conversion POST fires, keyed by the route's
    // session.
    await running.locator(".subagent-bg").click();
    await expect
      .poll(async () => (await (await fetch(`${rig.api}/__control/background`)).json()).calls)
      .toEqual(["ses_seed_1"]);
    await expect(chips).toHaveCount(2);
  } finally {
    rig.stop();
  }
});

