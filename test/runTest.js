// Boots a real (headless-ish) VS Code with the extension loaded and runs
// the lifecycle suite inside it, then checks the exit for orphaned
// `opencode serve` processes on the port the suite recorded.
const path = require("path");
const fs = require("fs");
const os = require("os");
const { pathToFileURL } = require("url");
const { spawnSync } = require("child_process");
const { runTests } = require("@vscode/test-electron");

// This process may itself run under Electron (ELECTRON_RUN_AS_NODE=1) —
// unset it, or the spawned VS Code runs as a bare node and chokes on the
// launch args.
delete process.env.ELECTRON_RUN_AS_NODE;

const portFile = path.join(os.tmpdir(), "oc-test-server-port");

// Workspace under test — a throwaway folder per run (the spawned server
// may write state into it); override with OC_TEST_WORKSPACE to aim the
// suite at a real project. pathToFileURL for the absolute path:
// concatenating onto "file:///" turns a POSIX path into file:////…, which
// VS Code fails to open — the window then has no folder and the suite dies
// on workspaceFolders[0].
const workspaceDir = process.env.OC_TEST_WORKSPACE
  ? process.env.OC_TEST_WORKSPACE.replace(/\\/g, "/")
  : fs.mkdtempSync(path.join(os.tmpdir(), "oc-test-ws-"));
const workspaceUri = pathToFileURL(workspaceDir).href;

async function main() {
  if (!fs.existsSync(workspaceDir)) {
    console.error(`FAIL: test workspace does not exist: ${workspaceDir}`);
    process.exit(1);
  }
  fs.rmSync(portFile, { force: true });
  await runTests({
    extensionDevelopmentPath: path.resolve(__dirname, ".."),
    extensionTestsPath: path.resolve(__dirname, "../out/test/suite.js"),
    launchArgs: [
      "--folder-uri",
      workspaceUri,
      "--disable-extensions",
      "--disable-gpu",
    ],
  });

  // The extension host exited; any opencode it spawned must be gone. The
  // suite recorded the server ports (one per line).
  await new Promise((r) => setTimeout(r, 2000));
  const ports =
    (fs.existsSync(portFile) &&
      fs.readFileSync(portFile, "utf8").split("\n").map((s) => s.trim()).filter(Boolean)) ||
    [];
  for (const port of ports) {
    let orphan = false;
    if (process.platform === "win32") {
      const out = spawnSync(
        "powershell",
        [
          "-NoProfile",
          "-c",
          `Get-CimInstance Win32_Process -Filter "Name='opencode.exe'" | Where-Object { $_.CommandLine -like '*serve --port ${port}*' } | Select-Object -ExpandProperty ProcessId`,
        ],
        { encoding: "utf8" },
      ).stdout.trim();
      orphan = Boolean(out);
    } else {
      // pgrep exits 0 when a match exists (an orphan), 1 when clean.
      orphan = spawnSync("pgrep", ["-f", `serve --port ${port}`]).status === 0;
    }
    if (orphan) {
      console.error(`FAIL: an opencode survived extension-host exit on port ${port}`);
      process.exit(1);
    }
    console.log(`no orphans on port ${port}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
