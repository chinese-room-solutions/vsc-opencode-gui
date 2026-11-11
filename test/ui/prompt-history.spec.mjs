// Prompt-history sweep ends on typing: Up recalls the previous sent prompt,
// and typing into the recalled text must hand the sweep back — the next
// Down keeps the edited draft instead of stepping the history walk further
// or restoring the stale pre-sweep draft over the user's edits.
import { test, expect, openSession, watchPage } from "./support/fixture.mjs";

test("typing into a recalled prompt ends the sweep", async ({ page, rig }) => {
  const watched = watchPage(page);
  await openSession(page, rig.url);
  const ta = page.locator(".composer textarea");
  await ta.click();
  await expect(ta).toHaveValue("");
  // Up on the empty box recalls the newest sent prompt, caret parked at 0.
  await page.keyboard.press("ArrowUp");
  const recalled = await ta.inputValue();
  expect(recalled).toContain("Question 12");
  // Typing lands at the parked caret, in front of the recalled text, and
  // must end the sweep (programmatic value writes never fire input, so the
  // recall itself survives this rule).
  await page.keyboard.type("x");
  const edited = "x" + recalled;
  await expect(ta).toHaveValue(edited);
  // Down with the sweep still live would step to the next entry or restore
  // the pre-sweep draft (here an empty box) — with the sweep ended it is a
  // plain caret move and the text stays.
  await page.keyboard.press("ArrowDown");
  await expect(ta).toHaveValue(edited);
  expect(watched.errors).toEqual([]);
});
