// Server-side provider control — both dialects speak the same config
// keys in opencode.json/jsonc: `disabled_providers` (denylist) and, v2
// only, `enabled_providers` (allowlist — absent means off; when present
// the server denies every provider not on the list, sub-agent sessions
// included). v1 exposes PATCH /config (deep-merges into the global
// file, applies immediately); v2 has NO write route, so the extension
// edits the global config file itself — the server watches it and
// hot-reloads (verified ≤3s on 2.0.18; POST /api/location/reload is
// the belt). These helpers are the pure text layer so the JSONC handling
// is unit-testable without vscode; ServerManager owns the I/O.
import { existsSync } from "node:fs";
import { join } from "node:path";

// The global config file (v1's merge order prefers an existing .jsonc;
// v2 accepts either — a fresh one is plain .json).
export function globalConfigPath(configRoot: string): string {
  for (const name of ["opencode.jsonc", "opencode.json"]) {
    const p = join(configRoot, name);
    if (existsSync(p)) return p;
  }
  return join(configRoot, "opencode.json");
}

// JSONC tolerance: // and /* */ comments stripped outside strings, plus
// trailing commas. Not a validator — garbage stays garbage and the JSON
// parse in the caller decides.
export function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  let str = false;
  while (i < text.length) {
    const c = text[i];
    const d = text[i + 1];
    if (str) {
      out += c;
      if (c === "\\") {
        out += d ?? "";
        i += 2;
        continue;
      }
      if (c === '"') str = false;
      i++;
      continue;
    }
    if (c === '"') {
      str = true;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && d === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && d === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/"))
        i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

export function readDisabledProviders(text: string | undefined): string[] {
  if (!text) return [];
  try {
    const cfg = JSON.parse(stripJsonc(text)) as {
      disabled_providers?: unknown;
    };
    return Array.isArray(cfg.disabled_providers)
      ? cfg.disabled_providers.filter(
          (x): x is string => typeof x === "string",
        )
      : [];
  } catch {
    return [];
  }
}

// The allowlist twin: null means the key is absent (allowlist mode off).
export function readEnabledProviders(text: string | undefined): string[] | null {
  if (!text) return null;
  try {
    const cfg = JSON.parse(stripJsonc(text)) as {
      enabled_providers?: unknown;
    };
    if (!Array.isArray(cfg.enabled_providers)) return null;
    return cfg.enabled_providers.filter(
      (x): x is string => typeof x === "string",
    );
  } catch {
    return null;
  }
}

// Surgical edit: only the key's element changes, so the rest of the
// file — a .jsonc's comments included — stays byte-identical.
function setArrayKeyInText(text: string, key: string, arr: string): string {
  const existing = new RegExp(`("${key}"\\s*:\\s*)\\[[^\\]]*\\]`).exec(text);
  if (existing)
    return (
      text.slice(0, existing.index) +
      existing[1] +
      arr +
      text.slice(existing.index + existing[0].length)
    );
  const open = text.indexOf("{");
  const empty =
    open === -1 ||
    text
      .slice(open + 1)
      .replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "")
      .trim()
      .replace(/^}$/, "")
      .trim() === "";
  if (empty) return `{\n  "${key}": ${arr}\n}`;
  return (
    text.slice(0, open + 1) +
    `\n  "${key}": ${arr},` +
    text.slice(open + 1)
  );
}

export function setDisabledProvidersInText(
  text: string,
  ids: string[],
): string {
  return setArrayKeyInText(text, "disabled_providers", JSON.stringify(ids));
}

// ids === null removes the key (allowlist mode off), swallowing the
// separating comma whichever side it sits on.
export function setEnabledProvidersInText(
  text: string,
  ids: string[] | null,
): string {
  if (ids === null) {
    const m = /"enabled_providers"\s*:\s*\[[^\]]*\]/.exec(text);
    if (!m) return text;
    let start = m.index;
    let end = m.index + m[0].length;
    while (start > 0 && /\s/.test(text[start - 1])) start--;
    if (text[start - 1] === ",") start--;
    else {
      while (end < text.length && /\s/.test(text[end])) end++;
      if (text[end] === ",") end++;
    }
    return text.slice(0, start) + text.slice(end);
  }
  return setArrayKeyInText(text, "enabled_providers", JSON.stringify(ids));
}
