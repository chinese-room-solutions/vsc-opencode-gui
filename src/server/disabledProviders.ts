// Server-side provider disabling — both dialects speak the same config
// keys: `disabled_providers` is a denylist of provider ids in
// opencode.json/jsonc. v1 exposes PATCH /config (deep-merges into the
// global file, applies immediately); v2 has NO write route, so the
// extension edits the global config file itself — the server watches it
// and hot-reloads (verified ≤3s on 2.0.18; POST /api/location/reload is
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

// Surgical edit: only the disabled_providers element changes, so the
// rest of the file — a .jsonc's comments included — stays byte-identical.
export function setDisabledProvidersInText(
  text: string,
  ids: string[],
): string {
  const arr = JSON.stringify(ids);
  const existing = /("disabled_providers"\s*:\s*)\[[^\]]*\]/.exec(text);
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
  if (empty) return `{\n  "disabled_providers": ${arr}\n}`;
  return (
    text.slice(0, open + 1) +
    `\n  "disabled_providers": ${arr},` +
    text.slice(open + 1)
  );
}
