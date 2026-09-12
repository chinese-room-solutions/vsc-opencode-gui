// Bundles the webview app (Preact + signals) to out/webview. The extension
// host never imports these sources — they are type-checked separately by
// tsconfig.webview.json and loaded from chat.html as webview resources.
const esbuild = require("esbuild");

esbuild
  .build({
    entryPoints: ["src/webview/app/main.tsx"],
    outfile: "out/webview/app.js",
    bundle: true,
    format: "iife",
    target: "es2022",
    jsx: "automatic",
    jsxImportSource: "preact",
    minify: true,
    loader: { ".mp3": "dataurl" },
    logLevel: "info",
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
