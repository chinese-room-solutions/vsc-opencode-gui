// @-mention pills in sent messages: the seeded last turn's prompt ends in
// "@src/retry.ts" with its durable file part (support/fake-api.mjs), and the
// renderer lifts it into a .mention-pill — the shared .file-ref chip family,
// capped at 200px — while the text keeps the token for the model. Turn 11
// seeds a directory mention ("@docs/") for the openExternal branch, and the
// composer's mirror layer renders live @-tokens as chips that turn
// click-to-open once the finder vouches for the path. No prompt is ever
// sent from these tests.
import { test, expect, openSession, watchPage } from "./support/fixture.mjs";

// The rig's acquireVsCodeApi stand-in logs non-api host messages to the
// console as "[host-msg] {json}" — the observable side of a chip click.
const hostMsgs = (page) => {
  const seen = [];
  page.on("console", (m) => {
    const t = m.text();
    if (t.startsWith("[host-msg]")) seen.push(JSON.parse(t.slice(10)));
  });
  return seen;
};

test("a sent mention renders as a capped, click-to-open pill", async ({
  page,
  rig,
}) => {
  await openSession(page, rig.url);
  const pill = page
    .locator(".msg.user")
    .filter({ hasText: "Tune" })
    .locator(".mention-pill");
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

test("a sent directory pill opens with the system tool, not the editor", async ({
  page,
  rig,
}) => {
  const watched = watchPage(page);
  const msgs = hostMsgs(page);
  await openSession(page, rig.url);
  const pill = page
    .locator(".msg.user")
    .filter({ hasText: "Browse" })
    .locator(".mention-pill");
  await expect(pill).toHaveCount(1);
  await expect(pill).toHaveText("@docs/");
  await expect(pill).toHaveAttribute("data-dir", "1");
  await pill.click();
  await expect
    .poll(() => msgs.find((m) => m.type === "open-external")?.path)
    .toBe("/repo/docs/");
  expect(watched.errors).toEqual([]);
});

test("a sent file pill opens in the editor", async ({ page, rig }) => {
  const watched = watchPage(page);
  const msgs = hostMsgs(page);
  await openSession(page, rig.url);
  const pill = page
    .locator(".msg.user")
    .filter({ hasText: "Tune" })
    .locator(".mention-pill");
  await pill.click();
  await expect
    .poll(() => msgs.find((m) => m.type === "open-file"))
    .toEqual({ type: "open-file", path: "/repo/src/retry.ts" });
  expect(watched.errors).toEqual([]);
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

test("composer @-tokens render as inline chips, clickable once finder-verified", async ({
  page,
  rig,
}) => {
  const watched = watchPage(page);
  const msgs = hostMsgs(page);
  await openSession(page, rig.url);
  await page.click(".composer textarea");
  // A file token, a directory token, a ghost; then an agent token, which
  // must stay plain text (mentions name an agent, they don't link).
  await page.keyboard.type(
    "see @picks/config.json and @docs/ and @ghost/none.txt ok @general!",
  );
  const chip = page.locator(".composer-mirror .mention-chip");
  await expect(chip).toHaveCount(3);
  await expect(chip.nth(0)).toHaveText("@picks/config.json");
  await expect(chip.nth(1)).toHaveText("@docs/");
  await expect(chip.nth(2)).toHaveText("@ghost/none.txt");
  // The mirror paints the whole value, chips inline — a parity check on
  // the shared tokenizer (agent token included as plain text).
  const typed = "see @picks/config.json and @docs/ and @ghost/none.txt ok @general!";
  await expect
    .poll(() => page.locator(".composer-mirror").textContent())
    .toBe(typed);
  // Verified tokens (finder debounce) gain chip-open — the file and the
  // directory; the ghost and the agent stay inert.
  await expect(chip.nth(0)).toHaveClass(/chip-open/);
  await expect(chip.nth(1)).toHaveClass(/chip-open/);
  // Sequential verification: once the second chip opened, the ghost's
  // verdict landed too — it must NOT be clickable.
  await expect(chip.nth(2)).not.toHaveClass(/chip-open/);
  // Click the file chip → open-file with the resolved absolute path.
  await chip.nth(0).click();
  const base = rig.dir.replace(/\\/g, "/");
  await expect
    .poll(() => msgs.find((m) => m.type === "open-file")?.path)
    .toBe(`${base}/picks/config.json`);
  // Click the directory chip → open-external with its resolved path.
  await chip.nth(1).click();
  await expect
    .poll(() => msgs.find((m) => m.type === "open-external")?.path)
    .toBe(`${base}/docs/`);
  expect(watched.errors).toEqual([]);
});

test("an image mention the server inlined keeps its inline pill", async ({
  page,
  rig,
}) => {
  const watched = watchPage(page);
  const msgs = hostMsgs(page);
  await openSession(page, rig.url);
  const msg = page.locator(".msg.user").filter({ hasText: "Shot" });
  const pill = msg.locator(".mention-pill");
  await expect(pill).toHaveCount(1);
  await expect(pill).toHaveText("@picks/5.png");
  // Re-sourced against the session's directory (the rig's temp dir), not
  // the seeded part — the source is re-derived from the token.
  const base = rig.dir.replace(/\\/g, "/");
  await expect(pill).toHaveAttribute("data-path", `${base}/picks/5.png`);
  // Not duplicated as an attachment chip above the text.
  await expect(msg.locator(".msg-files")).toHaveCount(0);
  // Hover: a small cursor-anchored preview with the part's bytes.
  await pill.hover();
  const preview = page.locator(".hover-img");
  await expect(preview).toBeVisible();
  await expect(preview).toHaveAttribute(
    "src",
    "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEA",
  );
  // Click: the lightbox, not the editor.
  await pill.click();
  await expect(page.locator(".img-preview")).toBeVisible();
  await page.keyboard.press("Escape");
  expect(msgs.filter((m) => m.type === "open-file")).toEqual([]);
  expect(watched.errors).toEqual([]);
});

test("selection tint drops when the webview loses focus", async ({
  page,
  rig,
}) => {
  await openSession(page, rig.url);
  await page.click(".composer textarea");
  await page.keyboard.type("see @picks/config.json now");
  const chip = page.locator(".composer-mirror .mention-chip").first();
  await expect(chip).toHaveClass(/chip-open/);
  await page.keyboard.press("Control+a");
  await expect(chip).toHaveClass(/sel/);
  // Collapsing the selection by a plain click inside the input fires no
  // "select" event — only a caret set. The tint must follow the caret.
  const box = await chip.boundingBox();
  await page.mouse.click(box.x + box.width + 12, box.y + 8);
  await expect(chip).not.toHaveClass(/sel/);
  // Focus leaving the webview iframe (VS Code chrome, another tab) fires
  // only the window's blur — the textarea never blurs. Without the window
  // listener the tint sticks until the next keystroke.
  await page.keyboard.press("Control+a");
  await expect(chip).toHaveClass(/sel/);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(chip).not.toHaveClass(/sel/);
});

test("the mirror matches the textarea's metrics and the textarea paints transparent", async ({
  page,
  rig,
}) => {
  await openSession(page, rig.url);
  const same = await page.evaluate(() => {
    const ta = document.querySelector(".composer textarea");
    const m = document.querySelector(".composer-mirror");
    const a = getComputedStyle(ta);
    const b = getComputedStyle(m);
    return {
      // paddingTop/paddingLeft are deliberately unequal: the mirror rides
      // 5px above and 3px beside the textarea (chip-frame headroom) and
      // compensates with its own padding — glyph positions still match.
      metrics: ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "borderTopWidth", "whiteSpace", "overflowWrap"].every(
        (k) => a[k] === b[k],
      ),
      color: a.color,
      caret: a.caretColor,
      mirrorPointer: b.pointerEvents,
    };
  });
  expect(same.metrics).toBe(true);
  expect(same.color).toBe("rgba(0, 0, 0, 0)");
  expect(same.caret).not.toBe("rgba(0, 0, 0, 0)");
  expect(same.mirrorPointer).toBe("none");
});
