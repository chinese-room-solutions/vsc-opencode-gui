import * as assert from "assert";
import * as vscode from "vscode";
import {
  colorFor,
  glowEnabled,
  glowShadow,
  invalidateThemeTokens,
  themeKey,
  themeRules,
  themeStyle,
  type TokenRule,
} from "../theme";

// Runs inside the extension host (see lifecycle.ts for the harness). Covers
// theme.ts: the pure transforms exactly, and the theme-file resolution
// against the test instance's real default theme.

async function until(pred: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("condition not met in time");
}

suite("opencode theme", function () {
  const origTheme = vscode.workspace
    .getConfiguration("workbench")
    .get<string>("colorTheme", "");
  const origGlow = vscode.workspace
    .getConfiguration("opencodeGui")
    .get<boolean>("codeGlow", false);

  test("glowShadow handles 3, 4, 6, and 8-digit hex", function () {
    assert.strictEqual(
      glowShadow("#ff8800"),
      "0 0 2px #ff8800, 0 0 8px rgba(255,136,0,0.5)",
    );
    assert.strictEqual(
      glowShadow("#f80"),
      "0 0 2px #f80, 0 0 8px rgba(255,136,0,0.5)",
    );
    assert.strictEqual(
      glowShadow("#1a2b"),
      "0 0 2px #1a2b, 0 0 8px rgba(17,170,34,0.5)",
    );
    assert.strictEqual(
      glowShadow("#ff8800aa"),
      "0 0 2px #ff8800aa, 0 0 8px rgba(255,136,0,0.5)",
    );
  });

  test("colorFor matches prefix scopes, longest wins, ties go to the later rule", function () {
    const rules: TokenRule[] = [
      { scope: "comment", settings: { foreground: "#00ff00" } },
      { scope: "comment.line", settings: { foreground: "not-a-hex" } },
      { scope: "keyword.control", settings: { foreground: "#ff0000" } },
      { scope: "keyword.control.if", settings: { foreground: "#0000ff" } },
      { scope: "a.b", settings: { foreground: "#111111" } },
      { scope: "a.b", settings: { foreground: "#222222" } },
      { scope: ["x.y", "z.w"], settings: { foreground: "#abcdef" } },
      { scope: "p.q, r.s", settings: { foreground: "#987654" } },
      { settings: { foreground: "#ffff00" } },
    ];
    assert.strictEqual(colorFor("comment.line", rules), "#00ff00");
    assert.strictEqual(colorFor("comment", rules), "#00ff00");
    assert.strictEqual(colorFor("keyword.control.if", rules), "#0000ff");
    assert.strictEqual(colorFor("keyword.control.while", rules), "#ff0000");
    assert.strictEqual(colorFor("a.b.c", rules), "#222222");
    assert.strictEqual(colorFor("x.y.z", rules), "#abcdef");
    assert.strictEqual(colorFor("z.w", rules), "#abcdef");
    assert.strictEqual(colorFor("r.s.v", rules), "#987654");
    assert.strictEqual(colorFor("nothing.matching", rules), undefined);
    assert.strictEqual(colorFor("p", rules), undefined);
  });

  test("glowEnabled tracks the codeGlow setting", async function () {
    const cfg = vscode.workspace.getConfiguration("opencodeGui");
    try {
      await cfg.update("codeGlow", true, vscode.ConfigurationTarget.Global);
      assert.strictEqual(glowEnabled(), true);
      await cfg.update("codeGlow", false, vscode.ConfigurationTarget.Global);
      assert.strictEqual(glowEnabled(), false);
    } finally {
      await cfg.update("codeGlow", origGlow, vscode.ConfigurationTarget.Global);
    }
  });

  test("the active theme resolves to rules, a key, and token vars", async function () {
    const cfg = vscode.workspace.getConfiguration("opencodeGui");
    await cfg.update("codeGlow", false, vscode.ConfigurationTarget.Global);
    assert.ok(
      Array.isArray(themeRules()) && themeRules()!.length > 0,
      "default theme provides token rules",
    );
    assert.ok(themeKey().includes(origTheme), `key names the theme: ${themeKey()}`);
    assert.ok(themeKey().endsWith("|flat"), "glow off by default");
    const style = themeStyle();
    assert.ok(style.startsWith('<style nonce="{{NONCE}}">:root{'), style);
    assert.ok(style.endsWith("}</style>"));
    assert.ok(style.includes("--oc-tok-"), "at least one token var baked");
    assert.ok(!style.includes("--oc-glow-"), "no glow vars while glow is off");
  });

  test("themeKey flips with the glow flag, cache included", async function () {
    const cfg = vscode.workspace.getConfiguration("opencodeGui");
    try {
      await cfg.update("codeGlow", true, vscode.ConfigurationTarget.Global);
      assert.ok(themeKey().endsWith("|glow"));
      assert.ok(themeStyle().includes("--oc-glow-"), "glow vars baked");
      await cfg.update("codeGlow", false, vscode.ConfigurationTarget.Global);
      assert.ok(themeKey().endsWith("|flat"));
    } finally {
      await cfg.update("codeGlow", origGlow, vscode.ConfigurationTarget.Global);
    }
  });

  test("an unresolvable theme name yields no rules and an empty style", async function () {
    await vscode.workspace
      .getConfiguration("workbench")
      .update("colorTheme", "oc-test-no-such-theme", vscode.ConfigurationTarget.Global);
    invalidateThemeTokens();
    await until(() => themeKey().startsWith("oc-test-no-such-theme"));
    assert.strictEqual(themeRules(), undefined);
    assert.strictEqual(themeStyle(), "");
  });

  suiteTeardown(async function () {
    await vscode.workspace
      .getConfiguration("workbench")
      .update("colorTheme", origTheme, vscode.ConfigurationTarget.Global);
    await vscode.workspace
      .getConfiguration("opencodeGui")
      .update("codeGlow", origGlow, vscode.ConfigurationTarget.Global);
    invalidateThemeTokens();
  });
});
