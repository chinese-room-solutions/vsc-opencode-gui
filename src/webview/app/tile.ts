// Letter tiles — project folders, session rows, open tabs. One place
// decides the letter and the color, so the same key renders the same tile
// everywhere. Projects carry a host-assigned color name (ServerManager's
// palette); everything else hashes the key into the same saturated set.
const TILE_COLORS: Record<string, string> = {
  orange: "#e8590c",
  yellow: "#f08c00",
  cyan: "#0c8599",
  green: "#2f9e44",
  red: "#e03131",
  pink: "#d6336c",
  blue: "#1971c2",
  purple: "#9c36b5",
  gray: "#868e96",
};
const VALUES = Object.values(TILE_COLORS);

export function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

// The folder a path lives in — the disambiguator when two projects share
// a display name.
export function parentName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 2] : p;
}

export function tileFor(
  key: string,
  colorName?: string,
): { letter: string; color: string } {
  let hash = 0;
  for (const ch of key.toLowerCase()) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return {
    letter: (baseName(key)[0] ?? "?").toUpperCase(),
    color:
      (colorName && TILE_COLORS[colorName]) ??
      VALUES[Math.abs(hash) % VALUES.length],
  };
}
