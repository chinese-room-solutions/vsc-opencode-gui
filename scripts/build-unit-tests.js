// Bundles the webview unit tests (mocha, plain Node) into a single CJS
// file. setup.test.ts must stay the first import of unit-tests.ts — it
// installs the browser globals the app modules touch at import time.
const esbuild = require("esbuild");

esbuild
  .build({
    entryPoints: ["src/webview/app/unit-tests.ts"],
    outfile: "out/test-unit/tests.js",
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "es2022",
    loader: { ".mp3": "dataurl" },
    logLevel: "info",
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
