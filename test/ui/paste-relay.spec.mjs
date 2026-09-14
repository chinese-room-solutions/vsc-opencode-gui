// T1 — macOS clipboard keydown relay (src/webview/app/main.tsx).
// The relay arms a 300ms fallback on trusted Cmd+C/X/V in editables and
// runs document.execCommand only when no native clipboard event landed.
// Untrusted keydowns (host re-dispatches) must be ignored outright.
// Cmd+A runs selectAll directly.
//
// The page runs with a Mac Chrome UA so the relay installs; Playwright's
// keyboard events are trusted, and a synthetic ClipboardEvent stands in
// for the host's native clipboard relay (the relay's native-event listener
// does not check isTrusted).
import { test, expect, watchPage, openSession } from "./support/fixture.mjs";

const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Instrument before any app script runs: record execCommand calls and
// clipboard events on the document.
const INSTRUMENT = () => {
  window.__exec = [];
  window.__clip = { paste: 0, copy: 0, cut: 0 };
  const orig = Document.prototype.execCommand;
  Document.prototype.execCommand = function (cmd, ...rest) {
    window.__exec.push(String(cmd));
    return orig.call(this, cmd, ...rest);
  };
  for (const t of ["paste", "copy", "cut"])
    document.addEventListener(t, () => { window.__clip[t]++; }, true);
};

async function macPage(browser, rig) {
  const ctx = await browser.newContext({ userAgent: MAC_UA, viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const watched = watchPage(page);
  await page.addInitScript(INSTRUMENT);
  await openSession(page, rig.url);
  await page.click(".composer textarea");
  await page.keyboard.type("relay probe text");
  return { ctx, page, watched };
}

const execCalls = (page, cmd) =>
  page.evaluate((c) => window.__exec.filter((x) => x === c), cmd);
const clipCount = (page, kind) =>
  page.evaluate((k) => window.__clip[k], kind);
// A synthetic native clipboard event, as the host's relay would fire.
const dispatchNative = (page, kind) =>
  page.evaluate((k) => {
    const ta = document.querySelector(".composer textarea");
    const dt = new DataTransfer();
    dt.setData("text/plain", "native relay");
    ta.dispatchEvent(new ClipboardEvent(k, { clipboardData: dt, bubbles: true }));
  }, kind);

test("untrusted Cmd+C/V keydown never arms the fallback", async ({ browser, rig }) => {
  const { ctx, page, watched } = await macPage(browser, rig);
  await page.evaluate(() => {
    const ta = document.querySelector(".composer textarea");
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "v", metaKey: true, bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "c", metaKey: true, bubbles: true }));
  });
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.__exec)).toEqual([]);
  expect(await page.evaluate(() => window.__clip)).toEqual({ paste: 0, copy: 0, cut: 0 });
  expect(watched.errors).toEqual([]);
  await ctx.close();
});

test("trusted Cmd+V with the host's native paste: no fallback execCommand", async ({ browser, rig }) => {
  const { ctx, page, watched } = await macPage(browser, rig);
  await page.keyboard.press("Meta+v");
  await page.waitForTimeout(50);
  await dispatchNative(page, "paste");
  await page.waitForTimeout(600); // past the 300ms fallback arm
  expect(await execCalls(page, "paste")).toHaveLength(0);
  expect(await clipCount(page, "paste")).toBe(1); // exactly one paste total
  expect(watched.errors).toEqual([]);
  await ctx.close();
});

test("trusted Cmd+V with no native event: exactly one fallback paste", async ({ browser, rig }) => {
  const { ctx, page, watched } = await macPage(browser, rig);
  await page.keyboard.press("Meta+v");
  await expect
    .poll(() => execCalls(page, "paste"), { timeout: 1500, intervals: [50] })
    .toHaveLength(1);
  await page.waitForTimeout(600); // a second arm window must not re-fire
  expect(await execCalls(page, "paste")).toHaveLength(1);
  expect(watched.errors).toEqual([]);
  await ctx.close();
});

test("trusted Cmd+C with the host's native copy: no fallback execCommand", async ({ browser, rig }) => {
  const { ctx, page, watched } = await macPage(browser, rig);
  await page.keyboard.press("Meta+c");
  await page.waitForTimeout(50);
  await dispatchNative(page, "copy");
  await page.waitForTimeout(600);
  expect(await execCalls(page, "copy")).toHaveLength(0);
  expect(await clipCount(page, "copy")).toBe(1);
  expect(watched.errors).toEqual([]);
  await ctx.close();
});

test("trusted Cmd+C with no native event falls back exactly once", async ({ browser, rig }) => {
  const { ctx, page, watched } = await macPage(browser, rig);
  await page.keyboard.press("Meta+c");
  await expect
    .poll(() => execCalls(page, "copy"), { timeout: 1500, intervals: [50] })
    .toHaveLength(1);
  await page.waitForTimeout(600);
  expect(await execCalls(page, "copy")).toHaveLength(1);
  expect(watched.errors).toEqual([]);
  await ctx.close();
});

test("trusted Cmd+X with no native event falls back exactly once", async ({ browser, rig }) => {
  const { ctx, page, watched } = await macPage(browser, rig);
  await page.keyboard.press("Meta+x");
  await expect
    .poll(() => execCalls(page, "cut"), { timeout: 1500, intervals: [50] })
    .toHaveLength(1);
  await page.waitForTimeout(600);
  expect(await execCalls(page, "cut")).toHaveLength(1);
  expect(watched.errors).toEqual([]);
  await ctx.close();
});

test("Cmd+A runs selectAll directly", async ({ browser, rig }) => {
  const { ctx, page, watched } = await macPage(browser, rig);
  await page.keyboard.press("Meta+a");
  await expect
    .poll(() => execCalls(page, "selectAll"), { timeout: 1000, intervals: [50] })
    .toHaveLength(1);
  expect(await execCalls(page, "paste")).toHaveLength(0);
  expect(await execCalls(page, "copy")).toHaveLength(0);
  expect(await execCalls(page, "cut")).toHaveLength(0);
  expect(watched.errors).toEqual([]);
  await ctx.close();
});
