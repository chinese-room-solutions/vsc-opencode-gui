// Copy behavior end to end: every copy affordance must put plain text on
// the clipboard with newlines preserved, and selection copies inside code
// must carry no text/html flavor (no theme colors into rich paste targets,
// no white-space:pre dependency to lose the newlines). Runs against the
// fake-API rig; turn 6 of the seeded transcript carries the code fixture
// (support/fake-api.mjs CODE_TAIL).
import { test, expect, openSession } from "./support/fixture.mjs";

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

const TS = "const a = 1;\nconst b = 2;\nconsole.log(a + b);";
const TALL = Array.from({ length: 14 }, (_, i) => `// line ${i + 1} of the tall block`).join("\n");
const SH = "npm run compile\nnpm test";

const readText = (page) =>
  page.evaluate(() => navigator.clipboard.readText()).then((s) => s.replace(/\r\n/g, "\n"));
const readTypes = (page) =>
  page.evaluate(async () => {
    const items = await navigator.clipboard.read();
    return items.flatMap((i) => [...i.types]);
  });
const readHtml = (page) =>
  page.evaluate(async () => {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      if (item.types.includes("text/html")) {
        const blob = await item.getType("text/html");
        return blob.text();
      }
    }
    return "";
  });
const sentinel = (page, s = "__none__") =>
  page.evaluate((t) => navigator.clipboard.writeText(t), s);

// Replace the clipboard content with the given selection before copying.
const selectAllIn = (page, sel) =>
  page.evaluate((q) => {
    const el = document.querySelector(q);
    const r = document.createRange();
    r.selectNodeContents(el);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }, sel);

const selectPartialIn = (page, sel) =>
  page.evaluate((q) => {
    const el = document.querySelector(q);
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    const r = document.createRange();
    r.setStart(nodes[0], Math.min(6, nodes[0].length));
    const last = nodes[nodes.length - 1];
    r.setEnd(last, Math.max(1, last.length - 1));
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }, sel);

test.beforeEach(async ({ page, rig }) => {
  await openSession(page, rig.url);
});

test("fence copy button preserves newlines (plain, tall, list-nested)", async ({ page }) => {
  const blocks = page.locator(".code-block");
  await expect(blocks).toHaveCount(3);

  await sentinel(page);
  await blocks.filter({ has: page.locator("code.language-ts") }).locator(".code-copy").click();
  expect(await readText(page)).toBe(TS);

  await sentinel(page);
  await blocks.filter({ has: page.locator("code.language-js") }).locator(".code-copy").click();
  expect(await readText(page)).toBe(TALL);

  await sentinel(page);
  await blocks.filter({ has: page.locator("code.language-sh") }).locator(".code-copy").click();
  expect(await readText(page)).toBe(SH);
  expect(await readTypes(page)).toEqual(["text/plain"]);
});

test("modifier+click copies a small block in place", async ({ page }) => {
  await sentinel(page);
  await page.locator(".code-block pre code.language-ts").click({ modifiers: ["Alt"] });
  expect(await readText(page)).toBe(TS);
});

test("modifier+click copies an inline code span", async ({ page }) => {
  await sentinel(page);
  await page.locator("code.code-inline").filter({ hasText: "inlineSpan(42)" }).click({ modifiers: ["Alt"] });
  expect(await readText(page)).toBe("inlineSpan(42)");
});

test("turn footer copies the raw markdown of the reply", async ({ page }) => {
  await sentinel(page);
  const turn = page.locator(".turn").filter({ has: page.locator("code.language-ts") });
  await turn.locator(".turn-copy").click();
  const text = await readText(page);
  expect(text).toContain("```ts");
  expect(text).toContain(TS);
  expect(text).toContain("```");
});

test("user message copy button copies the prompt", async ({ page }) => {
  await sentinel(page);
  await page.hover(".msgs .turn .msg.user");
  await page.locator(".msgs .turn .msg-actions button").first().click();
  expect((await readText(page)).startsWith("Question 1:")).toBe(true);
});

test("tool output copy button preserves newlines", async ({ page }) => {
  await page.locator(".tool-row.expander").first().click();
  await sentinel(page);
  await page.locator('button[aria-label="Copy OUT"]').first().click();
  expect(await readText(page)).toBe("out/webview/app.js   390.6kb\nDone in 19ms");
});

test("selection copy inside a code block keeps newlines, drops styles", async ({ page }) => {
  await sentinel(page);
  await selectAllIn(page, ".code-block pre code.language-ts");
  await page.keyboard.press("Control+c");
  expect(await readText(page)).toBe(TS);
  const types = await readTypes(page);
  expect(types).toContain("text/plain");
  expect(types).toContain("text/html");
  const html = await readHtml(page);
  expect(html).toContain("<pre>");
  expect(html).toContain("(a + b);");
  expect(html).not.toMatch(/style=|class=|color/i);
});

test("partial selection across lines keeps the inner newlines", async ({ page }) => {
  await sentinel(page);
  await selectPartialIn(page, ".code-block pre code.language-ts");
  await page.keyboard.press("Control+c");
  const text = await readText(page);
  expect(text).toContain("\nconst b = 2;\n");
  expect(await readTypes(page)).toContain("text/html");
});

test("whole-message selection pastes clean structure (no colors, no chrome)", async ({ page }) => {
  // The LibreOffice report: a prose+code selection pasted into a rich
  // target must be structural HTML — no computed-style dump, no copy
  // buttons, no tokenizer colors.
  await page.evaluate(() => {
    const code = document.querySelector(".code-block pre code");
    const turn = code.closest(".turn");
    const body = turn.querySelector(".msg-body") ?? turn;
    const r = document.createRange();
    r.selectNodeContents(body);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
  });
  await page.keyboard.press("Control+c");
  const text = await readText(page);
  expect(text).toContain(TS);
  const html = await readHtml(page);
  expect(html).toContain("<pre>");
  expect(html).toContain("Plain fence:");
  expect(html).toContain("inlineSpan(42)");
  expect(html).not.toMatch(/style=|class=|<svg|<button|color/i);
});
