import { defineConfig } from "@playwright/test";

// System Chrome via the "chrome" channel (resolves the local install, no
// browser download); explicit executablePath as fallback.
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const chromeLaunch = { channel: "chrome" };

export default defineConfig({
  testDir: ".",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  use: {
    ...chromeLaunch,
    headless: true,
    viewport: { width: 1_280, height: 800 },
    actionTimeout: 10_000,
  },
  reporter: [["list"]],
});
