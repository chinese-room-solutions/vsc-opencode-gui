// Bundles the extension host into a single out/main.js. The host has runtime
// dependencies (vscode-textmate + vscode-oniguruma for editor-true code
// blocks), and loose node_modules next to the compiled files do not survive
// real installs — so they are inlined. Only `vscode` stays external. The
// oniguruma wasm ships as a plain asset next to the bundle (out/onig.wasm),
// loaded by src/tokenizer.ts relative to __dirname.
const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");

const options = {
  entryPoints: [path.join(root, "src", "main.ts")],
  outfile: path.join(root, "out", "main.js"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["vscode"],
  sourcemap: true,
  logLevel: "info",
};

async function main() {
  if (process.argv.includes("--watch")) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
  } else {
    await esbuild.build(options);
    fs.copyFileSync(
      path.join(root, "node_modules", "vscode-oniguruma", "release", "onig.wasm"),
      path.join(root, "out", "onig.wasm"),
    );
    // Plain assets copied next to the bundle: the attachments skill text.
    // It also lands in out/server/ — the tsc-compiled copy the test suite
    // imports resolve __dirname there.
    for (const dir of [path.join(root, "out"), path.join(root, "out", "server")]) {
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(
        path.join(root, "src", "server", "oc-attachments-skill.md"),
        path.join(dir, "oc-attachments-skill.md"),
      );
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
