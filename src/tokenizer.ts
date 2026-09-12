// Editor-true code blocks: tokenize with the real TextMate grammars of the
// installed extensions (vscode-textmate + oniguruma, in the extension host)
// and color each token from the active theme's own rules. The webview's
// highlight.js stays as the first paint; when the token run list round-trips
// (AppHost's "tokenized" reply) it replaces the fenced block, so the colors
// and glyph splits match the editor. Any failure returns undefined and the
// block keeps the highlight.js rendering.

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { Registry, parseRawGrammar } from "vscode-textmate";
import { loadWASM } from "vscode-oniguruma";
import { colorFor, glowEnabled, glowShadow, themeKey, themeRules, type TokenRule } from "./theme";

interface GrammarRef {
  scopeName: string;
  path: string;
  language?: string;
}

// scopeName → file, language id/alias → scopeName. Built from the grammar
// contributions of every installed extension, so it covers whatever the
// user has, not a bundled subset.
let catalog: { byScope: Map<string, string>; byLanguage: Map<string, string> } | undefined;

function grammarCatalog(): { byScope: Map<string, string>; byLanguage: Map<string, string> } {
  if (catalog) return catalog;
  const byScope = new Map<string, string>();
  const byLanguage = new Map<string, string>();
  for (const ext of vscode.extensions.all) {
    const grammars: GrammarRef[] | undefined = ext.packageJSON?.contributes?.grammars;
    if (!Array.isArray(grammars)) continue;
    for (const g of grammars) {
      if (typeof g?.scopeName !== "string" || typeof g?.path !== "string") continue;
      byScope.set(g.scopeName, path.join(ext.extensionPath, g.path));
      if (typeof g.language === "string") {
        byLanguage.set(g.language.toLowerCase(), g.scopeName);
      }
    }
    const languages: Array<{ id?: string; aliases?: string[] }> | undefined =
      ext.packageJSON?.contributes?.languages;
    if (Array.isArray(languages)) {
      for (const l of languages) {
        if (typeof l.id !== "string") continue;
        const scope = byLanguage.get(l.id.toLowerCase());
        if (!scope) continue;
        for (const a of l.aliases ?? []) {
          if (typeof a === "string") byLanguage.set(a.toLowerCase(), scope);
        }
      }
    }
  }
  catalog = { byScope, byLanguage };
  return catalog;
}

let registryInit: Promise<Registry> | undefined;
const grammars = new Map<string, Awaited<ReturnType<Registry["loadGrammar"]>>>();

function getRegistry(): Promise<Registry> {
  // Memoized: concurrent first tokenizations must not double-init the
  // oniguruma wasm.
  registryInit ??= (async () => {
    // The wasm ships next to the bundle (scripts/build-extension.js); a
    // plain file read keeps it working from any install layout.
    const wasm = new Uint8Array(fs.readFileSync(path.join(__dirname, "onig.wasm")));
    await loadWASM(wasm.buffer as ArrayBuffer);
    return new Registry({
      onigLib: import("vscode-oniguruma").then((m) => ({
        createOnigScanner: (patterns) => new m.OnigScanner(patterns),
        createOnigString: (s) => new m.OnigString(s),
      })),
      loadGrammar: async (scopeName) => {
        const file = grammarCatalog().byScope.get(scopeName);
        if (!file || !fs.existsSync(file)) return undefined;
        try {
          return parseRawGrammar(fs.readFileSync(file, "utf-8"), file);
        } catch {
          return undefined;
        }
      },
    });
  })();
  return registryInit;
}

// Fence language → scopeName: language id, alias, or a scope name itself.
function scopeForLanguage(lang: string): string | undefined {
  const { byScope, byLanguage } = grammarCatalog();
  const key = lang.toLowerCase();
  return byLanguage.get(key) ?? (byScope.has(key) ? key : undefined);
}

// Cap the cache: streaming turns re-render the same blocks, but a session
// could otherwise accumulate unbounded code.
const cache = new Map<string, TokenRun[]>();
const CACHE_MAX = 200;
// The key and the runs both retain the full text — big blocks must not
// take residence (reads still work; they just re-tokenize).
const CACHEABLE = 20_000;

// One styled (or plain) run of text. The webview applies color/shadow via
// element.style — CSP never governs CSSOM, while inline style attributes in
// HTML would be stripped by the nonce'd style-src.
export interface TokenRun {
  text: string;
  color?: string;
  shadow?: string;
}

// Tokenize `code` (fence language `lang`) against the real grammar and
// theme. Undefined keeps the highlight.js fallback.
export async function tokenizeToTokens(
  lang: string,
  code: string,
): Promise<TokenRun[] | undefined> {
  const rules = themeRules();
  if (!rules || !code || code.length > 200_000) return undefined;
  const cacheKey = `${themeKey()} ${lang} ${code}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;

  const scopeName = scopeForLanguage(lang);
  if (!scopeName) return undefined;
  try {
    const reg = await getRegistry();
    if (!grammars.has(scopeName)) grammars.set(scopeName, await reg.loadGrammar(scopeName));
    const grammar = grammars.get(scopeName);
    if (!grammar) return undefined;

    const glow = glowEnabled();
    const runs: TokenRun[] = [];
    const push = (text: string, color?: string) => {
      if (!text) return;
      const shadow = color && glow ? glowShadow(color) : undefined;
      const last = runs[runs.length - 1];
      // Merge adjacent same-styled runs so the payload stays small.
      if (last && last.color === color && last.shadow === shadow) {
        last.text += text;
        return;
      }
      runs.push({ text, ...(color ? { color } : {}), ...(shadow ? { shadow } : {}) });
    };
    let stack: Parameters<typeof grammar.tokenizeLine>[1] = null;
    for (const line of code.split("\n")) {
      const result = grammar.tokenizeLine(line, stack);
      stack = result.ruleStack;
      let last = 0;
      for (const token of result.tokens) {
        push(line.slice(last, token.startIndex));
        push(line.slice(token.startIndex, token.endIndex), colorForStack(token.scopes, rules));
        last = token.endIndex;
      }
      push(line.slice(last));
      push("\n");
    }
    // tokenizeLine is line-based: drop the trailing newline the split added.
    const tail = runs[runs.length - 1];
    if (tail) tail.text = tail.text.replace(/\n$/, "");

    if (code.length <= CACHEABLE) {
      if (cache.size >= CACHE_MAX) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(cacheKey, runs);
    }
    return runs;
  } catch {
    return undefined;
  }
}

// The token's scope stack, innermost first: the deepest scope whose rule
// matches supplies the color, matching TextMate's most-specific-wins.
function colorForStack(scopes: string[], rules: TokenRule[]): string | undefined {
  for (let i = scopes.length - 1; i >= 0; i--) {
    const color = colorFor(scopes[i], rules);
    if (color) return color;
  }
  return undefined;
}
