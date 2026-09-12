import Mocha from "mocha";

// Loaded by @vscode/test-electron (test/runTest.js). Mocha's tdd globals
// only exist while mocha is loading a file, so the tests live in
// lifecycle.ts and get added with addFile.
export function run(): Promise<void> {
  const mocha = new Mocha({ ui: "tdd", color: true, timeout: 120_000 });
  // Module suites first, lifecycle.js last: its uncaught-exception gate then
  // covers every suite, and its manageModels quick pick is the only UI left
  // pending when the window closes.
  mocha.addFile(require.resolve("./tokenizer.js"));
  mocha.addFile(require.resolve("./theme.js"));
  mocha.addFile(require.resolve("./attachments.js"));
  mocha.addFile(require.resolve("./serverManager.js"));
  mocha.addFile(require.resolve("./commands.js"));
  mocha.addFile(require.resolve("./lifecycle.js"));
  return new Promise((resolve, reject) => {
    mocha.run((failures) =>
      failures > 0 ? reject(new Error(`${failures} tests failed`)) : resolve(),
    );
  });
}
