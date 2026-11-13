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
  // The shared 2-core CI runner starves the real-server specs: across runs
  // different specs miss their deadlines once (never locally, never twice
  // the same). Retry in CI only — local runs stay strict.
  retries: process.env.CI ? 2 : 0,
  use: {
    ...chromeLaunch,
    headless: true,
    viewport: { width: 1_280, height: 800 },
    actionTimeout: 10_000,
  },
  reporter: [["list"]],
});
