// Every file-editing tool row shows its +/- diffstat and unfolds to the
// patch, across the three wire shapes: v2's edit/apply_patch success
// (FileDiff.Info[] in metadata.files), v1's structured.files[].patch, and
// the older metadata.diff string. v2's write carries no diff — no stat.
import { test, expect } from "@playwright/test";
import { startRig } from "./support/rig.mjs";

const rowByPill = (page, text) =>
  page.locator(".tool").filter({
    has: page.locator(".tool-pill", { hasText: text }),
  });

test("edit rows show the diffstat and unfold to the diff on every wire shape", async ({ page }) => {
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
    await page.goto(rig.url);
    await page.waitForSelector(".msgs .turn .msg.user", { timeout: 15_000 });

    // The old shapes keep rendering: metadata.diff (v2 legacy) and the
    // structured.files fallback (v1) share the same row contract.
    const legacy = rowByPill(page, "src/main.ts");
    await expect(legacy.locator(".diff-add")).toHaveText("+1");
    await expect(legacy.locator(".diff-del")).toHaveText("-0");

    // v2.1.4's edit success: metadata.files[].patch drives the stat…
    const v2edit = rowByPill(page, "src/webview/app/store.ts");
    await expect(v2edit.locator(".diff-add")).toHaveText("+1");
    await expect(v2edit.locator(".diff-del")).toHaveText("-0");
    // …and the unfolded body shows the highlighted patch. (The click aims
    // at the row's name label: the pill at the row's center is a file link
    // that stops propagation.)
    await v2edit.locator(".tool-name").click();
    await expect(v2edit.locator("pre.diff")).toContainText("const b = 2");

    // apply_patch spans files: the stat sums them, and the body carries
    // every patch. (Its pill is the summary text, not the path.)
    const patch = page.locator(".tool").filter({
      has: page.locator(".tool-name", { hasText: "Patch" }),
    });
    await expect(patch.locator(".diff-add")).toHaveText("+1");
    await expect(patch.locator(".diff-del")).toHaveText("-1");
    await patch.locator(".tool-name").click();
    await expect(patch.locator("pre.diff")).toContainText("added line");
    await expect(patch.locator("pre.diff")).toContainText("removed line");

    // v2's write success carries no diff metadata — no stat, no fold.
    const write = rowByPill(page, "notes.md");
    await expect(write.locator(".diff-stat")).toHaveCount(0);
    await expect(write.locator("pre.diff")).toHaveCount(0);
  } finally {
    rig.stop();
  }
});
