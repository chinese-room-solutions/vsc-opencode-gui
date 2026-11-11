// The attachment lightbox: every open starts unzoomed. The component mounts
// once at the app root and only unrenders when closed, so without a reset
// its zoom (and pan) leak from one picture into the next.
import { test, expect, openSession, watchPage } from "./support/fixture.mjs";

const pasteImage = (page) =>
  page.evaluate(() => {
    const ta = document.querySelector(".composer textarea");
    const dt = new DataTransfer();
    // 120x120: a 1px image renders entirely under the lightbox's × button,
    // which straddles its frame corner and would swallow the wheel.
    const png = "iVBORw0KGgoAAAANSUhEUgAAAHgAAAB4CAIAAAC2BqGFAAAA7ElEQVR4nO3QAQkAIADAMOMYwv4YyxYKd/AAZ2PPpQuN5wefBBp0K9CgW4EG3Qo06FagQbcCDboVaNCtQINuBRp0K9CgW4EG3Qo06FagQbcCDboVaNCtQINuBRp0K9CgW4EG3Qo06FagQbcCDboVaNCtQINuBRp0K9CgW4EG3Qo06FagQbcCDboVaNCtQINuBRp0K9CgW4EG3Qo06FagQbcCDboVaNCtQINuBRp0K9CgW4EG3Qo06FagQbcCDboVaNCtQINuBRp0K9CgW4EG3Qo06FagQbcCDboVaNCtQINuBRp0K9CgW4EG3eoAgFvu0D46VuAAAAAASUVORK5CYII=";
    dt.items.add(new File([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], "dot.png", { type: "image/png" }));
    ta.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });

test("a reopened lightbox starts unzoomed", async ({ page, rig }) => {
  const watched = watchPage(page);
  await openSession(page, rig.url);
  await page.click(".composer textarea");
  await pasteImage(page);
  const chip = page.locator(".composer-files .file-chip.chip-img");
  await expect(chip).toHaveCount(1);
  await chip.click();
  const img = page.locator(".img-preview img");
  await expect(img).toHaveAttribute("src", /^data:image\/png/);
  // The rig's canned preview is a 1px PNG whose whole area sits under the
  // overhanging × button — scale it up so the wheel can land on the
  // picture itself. (A <style> tag would violate the CSP; CSSOM writes
  // are allowed, and preact patches only the transform/cursor keys.)
  await img.evaluate((el) => {
    el.style.minWidth = "300px";
    el.style.minHeight = "300px";
  });
  // Wheel up over the picture: the name carries the zoom percent.
  await img.hover();
  await page.mouse.wheel(0, -600);
  await expect(page.locator(".img-preview-name")).toContainText("%");
  // Esc, reopen: the fresh open starts clean.
  await page.keyboard.press("Escape");
  await expect(page.locator(".img-preview")).toHaveCount(0);
  await chip.click();
  await expect(page.locator(".img-preview img")).toHaveAttribute("src", /^data:image\/png/);
  await expect(page.locator(".img-preview-name")).not.toContainText("%");
  await expect(img).toHaveAttribute(
    "style",
    /transform: translate\(0px, 0px\) scale\(1\)/,
  );
  expect(watched.errors).toEqual([]);
});
