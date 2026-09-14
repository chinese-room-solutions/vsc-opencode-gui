// Launches rig-fake.js on a fresh port and waits for its READY line.
// Fresh rig per call: fake API state (prompt turns, stream-more growth)
// never leaks between tests.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export async function startRig({ env = {} } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    const dir = mkdtempSync(path.join(tmpdir(), "oc-rig-"));
    const port = 45_000 + Math.floor(Math.random() * 2_000);
    const child = spawn(
      process.execPath,
      [path.join(repo, "test", "ui", "support", "rig-fake.js"), dir, String(port)],
      { cwd: repo, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const url = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(undefined), 20_000);
      child.on("exit", () => {
        clearTimeout(timer);
        resolve(undefined);
      });
      const poll = setInterval(() => {
        const m = out.match(/READY (http:\/\/\S+?)\/?\s/);
        const a = out.match(/API\s+(http:\/\/\S+?)\s/);
        if (m && a) {
          clearTimeout(timer);
          clearInterval(poll);
          resolve({ rig: m[1], api: a[1] });
        }
      }, 25);
      setTimeout(() => clearInterval(poll), 20_000);
    });
    if (url) {
      const stop = () => {
        if (child.exitCode !== null) return;
        if (process.platform === "win32") {
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        } else {
          child.kill("SIGTERM");
        }
      };
      return { url: url.rig, api: url.api, dir, pid: child.pid, stop };
    }
    lastErr = `rig failed to start (port ${port}): ${err || out}`.slice(0, 500);
    try {
      if (child.exitCode === null) {
        spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      }
    } catch {}
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
  throw new Error(lastErr ?? "rig failed to start");
}
