import * as fs from "fs";
import * as vscode from "vscode";
import { deflateSync } from "zlib";
import { log } from "../log";

// The editor tab's status icon — the old in-app tab prefix (TabsBar.tsx,
// pre one-editor-tab-per-session) reborn as panel.iconPath. VS Code tabs
// show text only, so the animated prefix (opencode's pixel spinner, the
// yellow ask mark, the green turn-ended mark) renders as one
// self-animating APNG per state: the extension host generates the files
// and sets one per state change, the page only reports facts
// (store.ts tabFacts / turnEnded posts).

// --- The art, mirrored exactly from the webview's in-app pixel spinner
// (icons.tsx + styles.css keyframes): 4x4 grid of rounded cells, 3px
// cells with 1px gaps in a 15x15 box. Corners are dark; the outer ring
// pulses dimmer than the inner four; per-cell negative delays sweep the
// pulse clockwise. The marks are the same grid (corners dark) pulsing
// as one, in the tab signal colors (literal, not theme vars — some
// themes map warning green). Only the rendering differs: CSS animates
// at display refresh, the tab samples the same curves into APNG frames.
const SPIN_OUTER = new Set([1, 2, 4, 7, 8, 11, 13, 14]);
const SPIN_CORNER = new Set([0, 3, 12, 15]);
const CYCLE_MS = 1200;
// 72 frames over the 1.2s cycle = 60 fps, the smoothness of a CSS
// animation on a 60Hz display; coarser sampling reads as low FPS.
export const TAB_FRAMES = 72;

// CSS `ease-in-out` is cubic-bezier(0.42, 0, 0.58, 1). x(t) is
// monotonic, so invert by bisection and take y(t) — exact.
function cssEaseInOut(p: number): number {
  const x = (t: number) =>
    3 * (1 - t) ** 2 * t * 0.42 + 3 * (1 - t) * t ** 2 * 0.58 + t ** 3;
  const y = (t: number) => 3 * (1 - t) * t ** 2 + t ** 3;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (x(mid) < p) lo = mid;
    else hi = mid;
  }
  return y((lo + hi) / 2);
}
// Keyframe value min→max→min over one cycle, eased per half like CSS.
const tri = (p: number) =>
  p <= 0.5 ? cssEaseInOut(p * 2) : cssEaseInOut(2 - 2 * p);

function cellOpacity(i: number, tMs: number): number {
  const col = i % 4;
  const row = Math.floor(i / 4);
  const angle = Math.atan2(row * 4 + 1.5 - 7.5, col * 4 + 1.5 - 7.5);
  const delayMs = (((angle + Math.PI * 2.5) / (Math.PI * 2)) * 0.9 - 0.9) * 1000;
  const p = ((((tMs - delayMs) % CYCLE_MS) + CYCLE_MS) % CYCLE_MS) / CYCLE_MS;
  return SPIN_OUTER.has(i) ? 0.15 + 0.35 * tri(p) : 0.4 + 0.6 * tri(p);
}

// styles.css pulse-opacity: 0.4 → 1 → 0.4, one mark-wide cycle.
export function pulseAlpha(frame: number): number {
  return 0.4 + 0.6 * tri(frame / TAB_FRAMES);
}

// --- Minimal APNG encoder (RGBA, no filter, no interlace) ---
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

// Per-frame delay as the APNG ratio (num/den in SECONDS): 1/60 s is
// 16.67 ms — 60 fps exactly.
const DELAY_NUM = 1;
const DELAY_DEN = 60;

// Filter-0 scanlines of one full-canvas frame, deflated.
function deflateFrame(w: number, h: number, rgba: Uint8Array): Buffer {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(
      raw,
      y * (w * 4 + 1) + 1,
    );
  }
  return deflateSync(raw);
}

// One animated PNG per state: acTL right after IHDR, an fcTL before
// every frame (seq_number increments across ALL fcTL and fdAT chunks in
// stream order), frame 0's pixels in a plain IDAT, each later frame as
// fdAT (4-byte seq prefix + compressed data). Every frame is the full
// canvas, so dispose none / blend source is exact.
function encodeApng(
  w: number,
  h: number,
  frames: readonly Uint8Array[],
): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const actl = Buffer.alloc(8);
  actl.writeUInt32BE(frames.length, 0);
  actl.writeUInt32BE(0, 4); // plays: infinite
  const parts = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("acTL", actl),
  ];
  let seq = 0;
  for (const [i, rgba] of frames.entries()) {
    const fc = Buffer.alloc(26);
    fc.writeUInt32BE(seq++, 0);
    fc.writeUInt32BE(w, 4);
    fc.writeUInt32BE(h, 8);
    fc.writeUInt32BE(0, 12); // x offset
    fc.writeUInt32BE(0, 16); // y offset
    fc.writeUInt16BE(DELAY_NUM, 20); // delay_num
    fc.writeUInt16BE(DELAY_DEN, 22); // delay_den (ratio is seconds: 1/60)
    fc[24] = 0; // dispose: none
    fc[25] = 0; // blend: source
    parts.push(chunk("fcTL", fc));
    const data = deflateFrame(w, h, rgba);
    if (i === 0) parts.push(chunk("IDAT", data));
    else {
      const fd = Buffer.alloc(4 + data.length);
      fd.writeUInt32BE(seq++, 0);
      data.copy(fd, 4);
      parts.push(chunk("fdAT", fd));
    }
  }
  parts.push(chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}

// Art scale: the 15x15 grid at 8x, so the tab's ~16px render downsamples
// cleanly instead of aliasing.
const S = 8;
const SIZE = 15 * S;

function paintCells(
  rgb: readonly [number, number, number],
  alpha: (cell: number) => number,
): Uint8Array {
  const px = new Uint8Array(SIZE * SIZE * 4);
  for (let i = 0; i < 16; i++) {
    if (SPIN_CORNER.has(i)) continue;
    const a = Math.round(alpha(i) * 255);
    if (a === 0) continue;
    const cx = ((i % 4) * 4 + 1.5) * S; // cell center in canvas px
    const cy = (Math.floor(i / 4) * 4 + 1.5) * S;
    const half = 1.5 * S;
    const r = 1 * S; // rx=1 at art scale
    for (let y = Math.floor(cy - half); y < cy + half; y++) {
      for (let x = Math.floor(cx - half); x < cx + half; x++) {
        // Rounded-rect coverage: flat inside the cross, arc in corners.
        const dx = Math.abs(x + 0.5 - cx) - (half - r);
        const dy = Math.abs(y + 0.5 - cy) - (half - r);
        if (dx > 0 && dy > 0 && dx * dx + dy * dy > r * r) continue;
        const o = (y * SIZE + x) * 4;
        px[o] = rgb[0];
        px[o + 1] = rgb[1];
        px[o + 2] = rgb[2];
        px[o + 3] = a;
      }
    }
  }
  return px;
}

// Neutral cell color per theme (the webview spinner inherits the tab
// text's gray); the marks stay literal across themes, like styles.css.
const SPIN_RGB: Record<"light" | "dark", readonly [number, number, number]> = {
  light: [77, 77, 77],
  dark: [200, 200, 200],
};
const MARK_RGB: Record<"attention" | "ready", readonly [number, number, number]> = {
  attention: [0xff, 0xcc, 0x00],
  ready: [0x89, 0xd1, 0x85],
};

function spinnerApng(theme: "light" | "dark"): Buffer {
  const frames: Uint8Array[] = [];
  for (let f = 0; f < TAB_FRAMES; f++) {
    const t = (f / TAB_FRAMES) * CYCLE_MS;
    frames.push(paintCells(SPIN_RGB[theme], (i) => cellOpacity(i, t)));
  }
  return encodeApng(SIZE, SIZE, frames);
}

function markApng(tone: "attention" | "ready"): Buffer {
  const frames: Uint8Array[] = [];
  for (let f = 0; f < TAB_FRAMES; f++) {
    const a = pulseAlpha(f);
    frames.push(paintCells(MARK_RGB[tone], () => a));
  }
  return encodeApng(SIZE, SIZE, frames);
}

// Generated-icon cache: deterministic bytes in the extension install dir
// (the tab-icon loader serves only install-dir/workspace resources, not
// globalStorage), written on first use and reused for the window's
// lifetime. Writes fail soft — a read-only install dir yields undefined
// and callers keep the previous icon instead of a blank one.
let warnedWriteFail = false;

export class TabIconSet {
  private readonly _uris = new Map<string, vscode.Uri>();

  constructor(private readonly _dir: vscode.Uri) {}

  private _file(name: string, build: () => Buffer): vscode.Uri | undefined {
    const hit = this._uris.get(name);
    if (hit) return hit;
    const uri = vscode.Uri.joinPath(this._dir, name);
    try {
      fs.mkdirSync(this._dir.fsPath, { recursive: true });
      if (!fs.existsSync(uri.fsPath)) fs.writeFileSync(uri.fsPath, build());
    } catch (err) {
      // Files already on disk still serve; log once, not per icon.
      if (!fs.existsSync(uri.fsPath)) {
        if (!warnedWriteFail) {
          warnedWriteFail = true;
          log.warn("tab icons unwritable (read-only install dir?):", err);
        }
        return undefined;
      }
    }
    this._uris.set(name, uri);
    return uri;
  }

  spinner(theme: "light" | "dark"): vscode.Uri | undefined {
    return this._file(`spin-${theme}.png`, () => spinnerApng(theme));
  }

  mark(tone: "attention" | "ready"): vscode.Uri | undefined {
    return this._file(`mark-${tone}.png`, () => markApng(tone));
  }
}

export type TabSignalState = "idle" | "busy" | "attention" | "ready";

// Facts the page reports (AppHost "tab-signal"); all optional so one
// poster can't clobber another's fields.
export interface TabSignalFacts {
  busy?: boolean;
  attention?: boolean;
  turnEnded?: boolean;
}

// One panel's icon state machine: priority attention > busy > ready >
// idle (the old tab prefix order). Each animated state has one
// self-animating APNG; the icon is set exactly once per state change.
export class TabSignal<I> {
  private _busy = false;
  private _attention = false;
  private _ready = false;
  private _lastState: TabSignalState | undefined;

  constructor(
    private readonly _icons: { frame(state: TabSignalState): I | undefined; idle: I },
    private readonly _set: (icon: I) => void,
  ) {}

  /** Page facts landed; `turnEnded` only marks when the tab wasn't active. */
  apply(facts: TabSignalFacts, active: boolean): void {
    if (facts.busy !== undefined) this._busy = facts.busy;
    if (facts.attention !== undefined) this._attention = facts.attention;
    if (facts.turnEnded && !active) this._ready = true;
    this.refresh();
  }

  /** The tab became the active editor — the unread (green) mark clears. */
  activated(): void {
    this._ready = false;
    this.refresh();
  }

  private get _state(): TabSignalState {
    if (this._attention) return "attention";
    if (this._busy) return "busy";
    if (this._ready) return "ready";
    return "idle";
  }

  private refresh(): void {
    const state = this._state;
    if (state === this._lastState) return;
    this._lastState = state;
    if (state === "idle") {
      this._set(this._icons.idle);
      return;
    }
    const icon = this._icons.frame(state);
    // No icon (unwritable cache dir): keep the previous icon — an
    // empty iconPath would blank the tab's prefix entirely.
    if (icon !== undefined) this._set(icon);
  }
}
