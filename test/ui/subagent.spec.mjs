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

// A prompt into a turn blocked on a foreground sub-agent answers instead
// of steering: the send releases the block to the background FIRST (the
// turn ends), then the prompt POSTs as its own turn. Runs on a dedicated
// v2-dialect rig in the fake's FAKE_API_BLOCKED mode: the parent session
// boots busy with a live task chip (child ses_child_1 working) — typing
// and Enter go to the FAKE server only, no model involved.
test("sending into a blocked turn backgrounds the sub-agent, then prompts", async ({ page }) => {
  const rig = await startRig({
    env: {
      OPENCODE_ROUTE: JSON.stringify({ view: "session", id: "ses_seed_1" }),
      OPENCODE_TABS: JSON.stringify(["ses_seed_1"]),
      OPENCODE_DIALECT: "v2",
      OPENCODE_READY_SOUND: "0",
      OPENCODE_PERMISSION_SOUND: "0",
      OPENCODE_QUESTION_SOUND: "0",
      FAKE_API_BLOCKED: "1",
    },
  });
  try {
    // Not openSession: the running chip's pulse perturbs the scroller's
    // at-bottom settle, which this spec doesn't care about.
    await page.goto(rig.url);
    const chips = page.locator(".subagent-chip");
    await chips.nth(0).waitFor({ timeout: 15_000 });
    // Unblocking is not a per-chip action anymore — no button anywhere.
    await expect(page.locator(".subagent-bg")).toHaveCount(0);
    await page.click(".composer textarea");
    await page.fill(".composer textarea", "keep going while it runs");
    await page.press(".composer textarea", "Enter");
    const ctrl = async (name) =>
      (await (await fetch(`${rig.api}/__control/${name}`)).json()).calls;
    await expect.poll(async () => (await ctrl("background")).length).toBe(1);
    await expect.poll(async () => (await ctrl("prompts")).length).toBe(1);
    const bg = (await ctrl("background"))[0];
    const prompt = (await ctrl("prompts"))[0];
    expect(bg.sessionID).toBe("ses_seed_1");
    expect(prompt.sessionID).toBe("ses_seed_1");
    expect(prompt.text).toBe("keep going while it runs");
    // The release precedes the prompt it unblocks — the shared record seq
    // orders calls across the two endpoints.
    expect(bg.seq).toBeLessThan(prompt.seq);
    await expect(chips).toHaveCount(2);
  } finally {
    rig.stop();
  }
});

