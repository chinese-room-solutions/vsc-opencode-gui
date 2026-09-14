// Final smoke: rig + browser, dump every console message + network failure.
import { chromium } from "@playwright/test";
import { startRig } from "./rig.mjs";

const rig = await startRig({
  env: {
    OPENCODE_ROUTE: JSON.stringify({ view: "session", id: "ses_seed_1" }),
    OPENCODE_TABS: JSON.stringify(["ses_seed_1"]),
    OPENCODE_READY_SOUND: "0",
  },
});
console.log("rig:", rig.url, "api:", rig.api);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage();
const lines = [];
page.on("console", (m) => lines.push(`[${m.type()}] ${m.location()?.url ?? ""} ${m.text().slice(0, 120)}`));
page.on("pageerror", (e) => lines.push(`[pageerror] ${e.message}`));
page.on("requestfailed", (r) => lines.push(`[requestfailed] ${r.method()} ${r.url()} ${r.failure()?.errorText}`));
await page.goto(rig.url);
await page.waitForSelector(".msgs .turn .msg.user", { timeout: 15_000 });
await page.waitForTimeout(2000);
// exercise a prompt end-to-end once, then a passive growth
await page.click(".composer textarea");
await page.fill(".composer textarea", "smoke");
await page.press(".composer textarea", "Enter");
await page.waitForTimeout(3500);
await fetch(`${rig.api}/__control/stream-more`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
await page.waitForTimeout(2000);
const dist = await page.locator(".msgs").evaluate((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight));
console.log("dist after growth:", dist);
console.log("console lines:", lines.length ? lines : "(none)");
await browser.close();
rig.stop();
