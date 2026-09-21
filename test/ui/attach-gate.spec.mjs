// Model-aware attachment gating: the composer's paste/drop gate consults
// the active session model's catalog input modalities (attachInputs +
// attachAllowed in src/webview/app). The fake catalog's "fake-model" takes
// image+pdf; "fake-audio" (switched in via the model picker) denies pdf.
// No prompt is ever sent from these tests.
import { test, expect, openSession, watchPage } from "./support/fixture.mjs";

// A window-level drop of one pdf File, the same path a real drop takes
// (Composer's window dragover/drop handlers read dataTransfer.files).
const dropPdf = (page, name = "gate.pdf") =>
  page.evaluate((n) => {
    const dt = new DataTransfer();
    dt.items.add(new File(["%PDF-1.4 fake page"], n, { type: "application/pdf" }));
    window.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
    window.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, name);

// Same drop path for raw bytes (content sniff tests need exact payloads).
const dropBytes = (page, bytes, name) =>
  page.evaluate(
    ([b, n]) => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(b)], n));
      window.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
      window.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    },
    [bytes, name],
  );

test("a pdf attaches on a model whose input covers pdf", async ({ page, rig }) => {
  const watched = watchPage(page);
  await openSession(page, rig.url);
  await dropPdf(page);
  const chip = page.locator(".composer-files .file-chip:not(.chip-img)");
  await expect(chip).toHaveCount(1);
  await expect(chip.locator(".chip-ext")).toHaveText("PDF");
  await expect(chip.locator(".chip-name")).toHaveText("gate.pdf");
  await expect(page.locator(".send-error")).toHaveCount(0);
  expect(watched.errors).toEqual([]);
});

test("a pdf is refused with an error on a model without pdf input", async ({ page, rig }) => {
  const watched = watchPage(page);
  await openSession(page, rig.url);
  // Switch the session to the audio-only catalog model via the picker.
  await page.click('.comp-chip[title="Model"]');
  await page.click('.pop-model .menu-item:has-text("Fake Audio")');
  await expect(page.locator('.comp-chip[title="Model"] .comp-chip-label')).toHaveText("Fake Audio");
  await dropPdf(page, "denied.pdf");
  await expect(page.locator(".composer-files .file-chip")).toHaveCount(0);
  await expect(page.locator(".send-error")).toHaveText(
    "1 file not attached (not supported by this model).",
  );
  expect(watched.errors).toEqual([]);
});

test("a text file with an unknown extension attaches by content sniff", async ({ page, rig }) => {
  const watched = watchPage(page);
  await openSession(page, rig.url);
  const notes = Array.from(new TextEncoder().encode("meeting notes\n- second line\n"));
  await dropBytes(page, notes, "notes.weird");
  const chip = page.locator(".composer-files .file-chip:not(.chip-img)");
  await expect(chip).toHaveCount(1);
  await expect(chip.locator(".chip-name")).toHaveText("notes.weird");
  await expect(page.locator(".send-error")).toHaveCount(0);
  expect(watched.errors).toEqual([]);
});

test("a binary file is refused with an error", async ({ page, rig }) => {
  const watched = watchPage(page);
  await openSession(page, rig.url);
  // MZ header with a NUL byte - the sniff must refuse it.
  await dropBytes(page, [0x4d, 0x5a, 0x00, 0x01, 0x02], "blob.bin");
  await expect(page.locator(".composer-files .file-chip")).toHaveCount(0);
  await expect(page.locator(".send-error")).toHaveText(
    "1 file not attached (unsupported type).",
  );
  expect(watched.errors).toEqual([]);
});

test("multiple files attach in one paste", async ({ page, rig }) => {
  const watched = watchPage(page);
  await openSession(page, rig.url);
  await page.click(".composer textarea");
  await page.evaluate(() => {
    const ta = document.querySelector(".composer textarea");
    const dt = new DataTransfer();
    dt.items.add(new File(["%PDF-1.4 fake page"], "one.pdf", { type: "application/pdf" }));
    dt.items.add(new File(["plain notes\n"], "two.weird"));
    dt.items.add(new File([new Uint8Array([0x4d, 0x5a, 0x00])], "three.bin"));
    ta.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  const chip = page.locator(".composer-files .file-chip");
  await expect(chip).toHaveCount(2);
  await expect(chip.nth(0).locator(".chip-name")).toHaveText("one.pdf");
  await expect(chip.nth(1).locator(".chip-name")).toHaveText("two.weird");
  // The refused file is named with its reason.
  await expect(page.locator(".send-error")).toHaveText(
    "1 file not attached (unsupported type).",
  );
  expect(watched.errors).toEqual([]);
});

test("a file over the relay cap is refused and points at the + picker", async ({ page, rig }) => {
  const watched = watchPage(page);
  await openSession(page, rig.url);
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["x".repeat(51 * 1024 * 1024)], "huge.log"));
    window.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
    window.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await expect(page.locator(".composer-files .file-chip")).toHaveCount(0);
  await expect(page.locator(".send-error")).toHaveText(
    "1 file not attached (over 50 MB - use + for large files).",
  );
  expect(watched.errors).toEqual([]);
});
