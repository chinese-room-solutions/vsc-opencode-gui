// Attention sounds: the opencode TUI's own samples (packages/ui/src/assets/
// audio, MIT) — bip-bop-01.mp3 rings when a session finishes its turn,
// bip-bop-03.mp3 (the TUI's question chime) when a session asks for a
// permission decision or asks a question. Embedded as data URIs — no
// separate assets to serve, and playback is client-side, so a remote (SSH)
// server still rings on the user's machine. 0.4 is the TUI's default
// attention volume.
import readySoundUrl from "./bip-bop-01.mp3";
import permissionSoundUrl from "./bip-bop-03.mp3";
import questionSoundUrl from "./bip-bop-03.mp3";

// bip-bop-01 is two blips 200 ms apart (the "bip" then the "bop"); the
// ready chime plays the first only — one attention glug, not a double
// beat. bip-bop-03's two notes are legato (the between-note dip never
// reaches zero), so its cut lands on residual amplitude and gets a short
// fade to stay click-free.
const TRIM_AFTER = new Map([
  [readySoundUrl, 0.12],
  [permissionSoundUrl, 0.185],
  [questionSoundUrl, 0.185],
]);

const metaOn = (name: string) =>
  document.querySelector(`meta[name="${name}"]`)?.getAttribute("content") === "1";

let readyEnabled = metaOn("opencode-ready-sound");
let permissionEnabled = metaOn("opencode-permission-sound");
let questionEnabled = metaOn("opencode-question-sound");

export function setReadySound(on: boolean): void {
  readyEnabled = on;
}

export function setPermissionSound(on: boolean): void {
  permissionEnabled = on;
}

export function setQuestionSound(on: boolean): void {
  questionEnabled = on;
}

// Web Audio, not <audio>: the AudioContext starts suspended (autoplay
// policy — a fresh document may not emit sound), but the first interaction
// resumes it and it then stays running for the document's lifetime, so
// every later ask rings immediately. resume() is idempotent; the listeners
// stay for good so a setting flipped on later still has a hot context.
let ctx: AudioContext | undefined;
function context(): AudioContext | undefined {
  try {
    return (ctx ??= new AudioContext());
  } catch {
    return undefined; // No audio support — the chime is best-effort.
  }
}
for (const type of ["pointerdown", "keydown"] as const) {
  document.addEventListener(type, () => context()?.resume().catch(() => {}), {
    capture: true,
    passive: true,
  });
}

const buffers = new Map<string, Promise<AudioBuffer | undefined>>();
function buffer(url: string): Promise<AudioBuffer | undefined> {
  let cached = buffers.get(url);
  if (!cached) {
    cached = (async () => {
      const audio = context();
      if (!audio) return undefined;
      try {
        const b64 = url.slice(url.indexOf(",") + 1);
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const decoded = await audio.decodeAudioData(bytes.buffer);
        const cut = TRIM_AFTER.get(url);
        if (cut === undefined || decoded.duration <= cut) return decoded;
        const len = Math.round(decoded.sampleRate * cut);
        const out = audio.createBuffer(decoded.numberOfChannels, len, decoded.sampleRate);
        const fade = Math.min(Math.round(decoded.sampleRate * 0.008), len);
        for (let c = 0; c < decoded.numberOfChannels; c++) {
          const ch = decoded.getChannelData(c).subarray(0, len);
          for (let i = 0; i < fade; i++) ch[len - fade + i] *= i / fade;
          out.copyToChannel(ch, c);
        }
        return out;
      } catch {
        return undefined; // Undecodable sample — the chime is best-effort.
      }
    })();
    buffers.set(url, cached);
  }
  return cached;
}

// The sidebar and the editor tab are separate apps on one origin: the
// localStorage gate keeps one chime per window, not one per panel. One key
// per sound — two events landing together must not silence each other.
const THROTTLE_MS = 1500;

function bell(url: string, enabled: boolean, throttleKey: string): void {
  if (!enabled) return;
  try {
    const now = Date.now();
    if (now - Number(localStorage.getItem(throttleKey) ?? 0) < THROTTLE_MS) return;
    void buffer(url).then((buf) => {
      // A context still suspended (no interaction since the document was
      // created) drops the chime without consuming the throttle — the next
      // ask rings as soon as the page has been touched once.
      const audio = context();
      if (!buf || !audio || audio.state !== "running") return;
      const src = audio.createBufferSource();
      src.buffer = buf;
      const gain = audio.createGain();
      gain.gain.value = 0.4;
      src.connect(gain).connect(audio.destination);
      src.start();
      localStorage.setItem(throttleKey, String(now));
    });
  } catch {
    // Storage denied — the chime is best-effort.
  }
}

export function playReadySound(): void {
  bell(readySoundUrl, readyEnabled, "opencode.bellAt.ready");
}

export function playPermissionSound(): void {
  bell(permissionSoundUrl, permissionEnabled, "opencode.bellAt.permission");
}

export function playQuestionSound(): void {
  bell(questionSoundUrl, questionEnabled, "opencode.bellAt.question");
}
