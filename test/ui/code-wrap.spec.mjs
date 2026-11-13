// Long code lines fold inside the fenced block (Claude Code's model): the
// block never scrolls horizontally, an unbreakable run (a 300-char token in
// a string literal) folds at the box edge too, and the copy button keeps
// its post on the first line.
import { test, expect, watchPage } from "./support/fixture.mjs";

test("a long code line wraps inside the fenced block", async ({ page, rig }) => {
  const watched = watchPage(page);
  await page.goto(rig.url);
  await page.waitForSelector(".msgs .turn .msg.user", { timeout: 15_000 });

  await fetch(`${rig.api}/__control/next-reply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      // The single line carries an unbreakable 300-char run: without
      // `overflow-wrap: anywhere` the fold at spaces would still leave
      // the token pushing the block past its box.
      text: ["```ts", `const path = "${"x".repeat(300)}";`, "```"].join("\n"),
    }),
  });
  await page.fill(".composer textarea", "show me");
  await page.click(".comp-send");
  await expect
    .poll(async () => (await (await fetch(`${rig.api}/__control/status`)).json()).streaming, {
      timeout: 30_000,
      intervals: [250],
    })
    .toBe(false);

  const block = page.locator(".code-block", { hasText: "const path" }).last();
  await expect(block).toHaveCount(1);
  const m = await block.locator("pre").evaluate((el) => ({
    sw: el.scrollWidth,
    cw: el.clientWidth,
    h: Math.round(el.getBoundingClientRect().height),
  }));
  // No horizontal overflow — the line folded, token included…
  expect(m.sw, `scrollWidth ${m.sw} vs clientWidth ${m.cw}`).toBeLessThanOrEqual(m.cw);
  // …into several 19px code lines (one unwrapped line is 19px + padding).
  expect(m.h, `pre height ${m.h}`).toBeGreaterThan(19 + 2 * 10 + 19);
  // The copy button still anchors to the block's first line.
  await expect(block.locator(".code-copy")).toHaveCount(1);
  // And the transcript column itself gained no horizontal scroll.
  const msgs = await page.locator(".msgs").evaluate((el) => ({
    sw: el.scrollWidth,
    cw: el.clientWidth,
  }));
  expect(msgs.sw).toBeLessThanOrEqual(msgs.cw);
  expect(watched.errors).toEqual([]);
});
