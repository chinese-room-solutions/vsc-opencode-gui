// Fenced code blocks should show the same token colors the editor shows for
// the same code. Webviews only receive registered colors, which don't
// include syntax tokens, so read the active theme file itself: its
// tokenColors feed both the highlight.js fallback (--oc-tok-* variables,
// baked as a style tag) and the TextMate tokenizer (src/tokenizer.ts), which
// colors per glyph. Anything that fails to resolve is simply absent — the
// webview CSS falls back.

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

export interface TokenRule {
  scope?: string | string[];
  settings?: { foreground?: string };
}

// The colors the webview's highlight.js classes reference: the semantic
// token keys to try first (what the editor's semantic highlighting uses),
// then the most specific TextMate scope each resolves through.
const QUERIES: Array<{ name: string; semantic: string[]; scope: string }> = [
  { name: "keyword", semantic: ["keyword"], scope: "keyword.control" },
  { name: "string", semantic: ["string"], scope: "string.quoted.double" },
  { name: "comment", semantic: ["comment"], scope: "comment.line" },
  { name: "number", semantic: ["number"], scope: "constant.numeric" },
  {
    name: "function",
    semantic: ["function", "method"],
    scope: "entity.name.function",
  },
  {
    name: "type",
    semantic: ["type", "class", "interface"],
    scope: "entity.name.type",
  },
  { name: "variable", semantic: ["variable"], scope: "variable.other" },
  {
    name: "attr",
    semantic: ["attribute"],
    scope: "entity.other.attribute-name",
  },
  { name: "operator", semantic: ["operator"], scope: "keyword.operator" },
];

interface Resolved {
  key: string;
  vars: Record<string, string>;
  rules?: TokenRule[];
  colors?: Record<string, string>;
}

let cache: Resolved | undefined;

// The theme changed — drop everything resolved so the next use reads the
// new theme file.
export function invalidateThemeTokens(): void {
  cache = undefined;
}

// The full tokenColors rule set for the tokenizer's per-scope matching.
export function themeRules(): TokenRule[] | undefined {
  return resolve().rules;
}

export function themeKey(): string {
  return resolve().key;
}

// CSS custom properties for the active theme: --oc-tok-* → hex color, and
// with codeGlow on, --oc-glow-* → text-shadow in the token's own color.
function themeTokenVars(): Record<string, string> {
  return resolve().vars;
}

function resolve(): Resolved {
  const theme = vscode.workspace
    .getConfiguration("workbench")
    .get<string>("colorTheme", "");
  const glow = glowEnabled();
  const key = `${theme}|${glow ? "glow" : "flat"}`;
  if (cache?.key === key) return cache;
  const resolved: Resolved = { key, vars: {} };
  try {
    const file = findThemeFile(theme);
    if (file) {
      const { rules, semantic, colors } = readTheme(file, 0);
      resolved.rules = rules;
      resolved.colors = colors;
      for (const q of QUERIES) {
        const color = q.semantic
          .map((k) => semantic[k])
          .find(isHexColor);
        resolved.vars[`--oc-tok-${q.name}`] =
          color ?? colorFor(q.scope, rules) ?? "";
      }
      if (glow) {
        for (const q of QUERIES) {
          const c = resolved.vars[`--oc-tok-${q.name}`];
          if (c) resolved.vars[`--oc-glow-${q.name}`] = glowShadow(c);
        }
        // The block's unclassed text uses --vscode-editor-foreground, whose
        // value lives in the theme's colors: editor.foreground, falling back
        // to the base foreground.
        const fg =
          [colors["editor.foreground"], colors["foreground"]].find(isHexColor) ??
          undefined;
        if (fg) resolved.vars["--oc-glow-plain"] = glowShadow(fg);
      }
    }
  } catch {
    // Broken or unreadable theme — no vars, the webview falls back.
  }
  for (const k of Object.keys(resolved.vars)) if (!resolved.vars[k]) delete resolved.vars[k];
  cache = resolved;
  return resolved;
}

// Theme files carry no glow; themes like SynthWave '84 add theirs by
// injecting CSS into the workbench, which never reaches webview documents.
// codeGlow synthesizes the effect: a halo in each token's own color.
export function glowEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("opencodeGui")
    .get<boolean>("codeGlow", false);
}

export function glowShadow(color: string): string {
  return `0 0 2px ${color}, 0 0 8px ${withAlpha(color, 0.5)}`;
}

function withAlpha(color: string, alpha: number): string {
  let hex = color.slice(1);
  if (hex.length === 3 || hex.length === 4)
    hex = [...hex].map((c) => c + c).join("");
  if (hex.length === 8) hex = hex.slice(0, 6);
  const n = parseInt(hex, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

// A <style> tag carrying the vars, with the template's nonce placeholder —
// AppHost replaces {{NONCE}} first, so the tag lands inside the CSP.
export function themeStyle(): string {
  const vars = themeTokenVars();
  if (Object.keys(vars).length === 0) return "";
  const body = Object.entries(vars)
    .map(([name, color]) => `${name}:${color};`)
    .join("");
  return `<style nonce="{{NONCE}}">:root{${body}}</style>`;
}

const isHexColor = (c: unknown): c is string =>
  typeof c === "string" && /^#[\da-fA-F]{3,8}$/.test(c);

// The active theme's definition file, found via the theme contributions of
// installed extensions (built-in and user themes alike).
function findThemeFile(label: string): string | undefined {
  if (!label) return undefined;
  for (const ext of vscode.extensions.all) {
    const themes = ext.packageJSON?.contributes?.themes;
    if (!Array.isArray(themes)) continue;
    for (const t of themes) {
      const match =
        (typeof t?.label === "string" &&
          t.label.toLowerCase() === label.toLowerCase()) ||
        (typeof t?.id === "string" &&
          t.id.toLowerCase() === label.toLowerCase());
      if (match && typeof t.path === "string") {
        return path.join(ext.extensionPath, t.path);
      }
    }
  }
  return undefined;
}

// Theme files are JSONC — comments and trailing commas are legal and common
// (SynthWave '84, for one, ships trailing commas), and strict JSON.parse on
// them would leave every token color unresolved. Strip both, never touching
// string contents.
function parseJsonc(text: string): unknown {
  let out = "";
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      out += ch;
      if (ch === "\\") out += text[++i] ?? "";
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] !== "}" && text[j] !== "]") out += ch;
    } else {
      out += ch;
    }
  }
  return JSON.parse(out.replace(/^﻿/, ""));
}

// tokenColors/semanticTokenColors/colors of the theme plus its `include`
// chain (included base first, so the theme's own rules win).
function readTheme(
  file: string,
  depth: number,
): {
  rules: TokenRule[];
  semantic: Record<string, string>;
  colors: Record<string, string>;
} {
  const data = parseJsonc(fs.readFileSync(file, "utf-8")) as {
    include?: string;
    tokenColors?: unknown;
    semanticTokenColors?: unknown;
    colors?: unknown;
  };
  const rules: TokenRule[] = [];
  const semantic: Record<string, string> = {};
  const colors: Record<string, string> = {};
  if (depth < 5 && typeof data.include === "string") {
    const merged = readTheme(
      path.join(path.dirname(file), data.include),
      depth + 1,
    );
    rules.push(...merged.rules);
    Object.assign(semantic, merged.semantic);
    Object.assign(colors, merged.colors);
  }
  if (Array.isArray(data.tokenColors)) {
    for (const r of data.tokenColors) {
      if (r && typeof r === "object") rules.push(r as TokenRule);
    }
  }
  if (
    data.semanticTokenColors &&
    typeof data.semanticTokenColors === "object"
  ) {
    Object.assign(semantic, data.semanticTokenColors);
  }
  if (data.colors && typeof data.colors === "object") {
    Object.assign(colors, data.colors);
  }
  return { rules, semantic, colors };
}

// The theme rule matching the query scope best: a rule matches when its
// scope is the query or an ancestor of it (TextMate prefix semantics); the
// longest scope wins, and on ties the later rule (theme over include).
export function colorFor(query: string, rules: TokenRule[]): string | undefined {
  let best: string | undefined;
  let bestLen = -1;
  for (const rule of rules) {
    const scopes = Array.isArray(rule.scope)
      ? rule.scope
      : typeof rule.scope === "string"
        ? rule.scope.split(",").map((s) => s.trim())
        : [];
    for (const scope of scopes) {
      if (
        (query === scope || query.startsWith(`${scope}.`)) &&
        scope.length >= bestLen &&
        isHexColor(rule.settings?.foreground)
      ) {
        best = rule.settings?.foreground;
        bestLen = scope.length;
      }
    }
  }
  return best;
}
