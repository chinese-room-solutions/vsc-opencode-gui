// @-mention pills in sent messages: the seeded last turn's prompt ends in
// "@src/retry.ts" with its durable file part (support/fake-api.mjs), and the
// renderer lifts it into a .mention-pill — the shared .file-ref chip family,
// capped at 200px — while the text keeps the token for the model.
import { test, expect, openSession } from "./support/fixture.mjs";

test("a sent mention renders as a capped, click-to-open pill", async ({
  page,
  rig,
}) => {
  await openSession(page, rig.url);
  const pill = page.locator(".msg.user .mention-pill");
  await expect(pill).toHaveCount(1);
  await expect(pill).toHaveText("@src/retry.ts");
  await expect(pill).toHaveAttribute("data-path", "/repo/src/retry.ts");
  const box = await pill.evaluate((el) => el.getBoundingClientRect());
  expect(box.width).toBeLessThanOrEqual(200.5);
  // The pill sits inline in the prompt, not on a chip row of its own.
  const inline = await pill.evaluate(
    (el) => getComputedStyle(el).display === "inline" || getComputedStyle(el).display === "inline-block",
  );
  expect(inline).toBe(true);
});

test("the sent attachment chip reuses the full cap the composer's × gives up", async ({
  page,
  rig,
}) => {
  await openSession(page, rig.url);
  // The seeded attachment's name is longer than the shared 178px name cap,
  // so both the sent chip and a pending one fill their caps exactly.
  // (Two "+"-picked file:// chips share the row — scope by name.)
  const chip = page.locator(
    ".msg.user .msg-files .file-chip:not(.chip-img)",
    { hasText: "DT DevOps" },
  );
  await expect(chip).toHaveCount(1);
  await expect(chip.locator(".chip-ext")).toHaveText("PDF");
  await expect(chip.locator(".chip-name")).toHaveText(
    "DT DevOps - Software Engineer Nomination Form.pdf",
  );
  // The pasted data-URI chip has no path and stays inert.
  await expect(chip).not.toHaveClass(/chip-open/);
  const m = await chip.evaluate((el) => {
    const name = el.querySelector(".chip-name");
    const ext = el.querySelector(".chip-ext");
    return {
      chip: el.getBoundingClientRect().width,
      name: name.clientWidth,
      ext: ext.getBoundingClientRect().width,
      truncated: name.scrollWidth > name.clientWidth,
    };
  });
  expect(m.truncated).toBe(true);
  // The sent chip spends its whole 200px content cap on badge + name (the
  // composer's reserves 22px for the ×); total 200 + padding 8 + border 2.
  expect(Math.abs(m.name - (196 - m.ext))).toBeLessThanOrEqual(1);
  expect(Math.abs(m.chip - 210)).toBeLessThanOrEqual(1);
});
