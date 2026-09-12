import * as assert from "assert";
import * as vscode from "vscode";
import { tokenizeToTokens, type TokenRun } from "../tokenizer";
import { glowShadow } from "../theme";

// Runs inside the extension host (see lifecycle.ts for the harness). Covers
// tokenizer.ts against the real built-in grammars of the test instance:
// run invariants, discovery failures, cache behavior, and glow styling.

// Built-in language basics that ship with VS Code, most likely first.
const CANDIDATE_LANGS = [
  "typescript",
  "javascript",
  "json",
  "jsonc",
  "markdown",
  "css",
  "scss",
  "html",
  "xml",
  "yaml",
  "shellscript",
  "powershell",
  "ini",
  "sql",
];

const SAMPLE = "const title = 1; // note\nhello(2)\n";

async function firstLang(colored: boolean): Promise<string | undefined> {
  for (const lang of CANDIDATE_LANGS) {
    const runs = await tokenizeToTokens(lang, SAMPLE);
    if (runs && (!colored || runs.some((r) => r.color))) return lang;
  }
  return undefined;
}

function joined(runs: TokenRun[]): string {
  return runs.map((r) => r.text).join("");
}

suite("opencode tokenizer", function () {
  test("a built-in grammar is reachable", async function () {
    assert.ok(await firstLang(false), "no candidate language tokenized");
  });

  test("rejects empty, oversized, and unknown-language input", async function () {
    const lang = (await firstLang(false))!;
    assert.strictEqual(await tokenizeToTokens(lang, ""), undefined);
    assert.strictEqual(await tokenizeToTokens(lang, "x".repeat(200_001)), undefined);
    assert.strictEqual(
      await tokenizeToTokens("no-such-language-xyz", SAMPLE),
      undefined,
    );
  });

  test("token runs round-trip the source and never repeat styling", async function () {
    const lang = (await firstLang(false))!;
    const cases = [
      "single line",
      "two\nlines",
      "trailing newline\n",
      "crlf\r\nlines\r\n",
      "\n\n",
      SAMPLE,
    ];
    for (const code of cases) {
      const runs = await tokenizeToTokens(lang, code);
      assert.ok(runs, `tokenizable: ${JSON.stringify(code)}`);
      assert.strictEqual(joined(runs), code);
      for (let i = 1; i < runs.length; i++) {
        const a = runs[i - 1];
        const b = runs[i];
        assert.ok(
          a.color !== b.color || a.shadow !== b.shadow,
          `adjacent runs share styling: ${JSON.stringify([a, b])}`,
        );
      }
    }
  });

  test("language lookup is case-insensitive", async function () {
    const lang = (await firstLang(false))!;
    assert.deepStrictEqual(
      await tokenizeToTokens(lang, SAMPLE),
      await tokenizeToTokens(lang.toUpperCase(), SAMPLE),
    );
  });

  test("caches small inputs and skips the cache above the cap", async function () {
    const lang = (await firstLang(false))!;
    const small = "const x = 1;\n".repeat(10);
    assert.strictEqual(
      await tokenizeToTokens(lang, small),
      await tokenizeToTokens(lang, small),
      "small input served from cache",
    );
    const big = "const x = 1;\n".repeat(2000); // 26k chars — over CACHEABLE
    const b1 = await tokenizeToTokens(lang, big);
    const b2 = await tokenizeToTokens(lang, big);
    assert.notStrictEqual(b1, b2, "big input not cached");
    assert.deepStrictEqual(b1, b2);
  });

  test("glow mode adds a shadow in each colored run's own color", async function () {
    const lang = await firstLang(true);
    if (!lang) return; // no colored grammar in this instance — nothing to style
    const cfg = vscode.workspace.getConfiguration("opencodeGui");
    const orig = cfg.get<boolean>("codeGlow", false);
    try {
      await cfg.update("codeGlow", true, vscode.ConfigurationTarget.Global);
      const runs = await tokenizeToTokens(lang, SAMPLE);
      assert.ok(runs);
      assert.ok(runs.some((r) => r.color), "theme colors at least one run");
      for (const r of runs) {
        if (r.color) assert.strictEqual(r.shadow, glowShadow(r.color));
        else assert.strictEqual(r.shadow, undefined);
      }
    } finally {
      await cfg.update("codeGlow", orig, vscode.ConfigurationTarget.Global);
    }
  });
});
