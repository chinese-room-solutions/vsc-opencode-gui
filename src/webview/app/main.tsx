import { render } from "preact";
import { App } from "./App";
import { ErrorBoundary, showCrashCard } from "./components/ErrorBoundary";
import { captureApi, postToHost } from "./host";
import { restoreRoute } from "./router";
import { hostMessage, init, popover, setPopover } from "./store";
import "./styles.css";

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

captureApi(acquireVsCodeApi());

const root = document.getElementById("app");
if (root)
  render(
    <ErrorBoundary>
      <App />
    </ErrorBoundary>,
    root,
  );

// componentDidCatch covers render errors; these catch handler throws and
// async rejections — everything lands on the same crash card.
window.addEventListener("error", (e) => showCrashCard(e.error));
window.addEventListener("unhandledrejection", (e) => showCrashCard(e.reason));

// Liveness heartbeat: the host times these to notice a dead renderer
// process — Restart rebuilds the chat tab when they stop.
window.setInterval(() => postToHost({ type: "ping" }), 15_000);

// The route the host baked into the page wins over the default; validated
// against the server inside init().
restoreRoute();
init();

window.addEventListener("message", (e) => hostMessage(e.data));

// On macOS the webview never sees Cmd+C/X/V/A natively: VS Code's Edit menu
// owns them and its when-clauses don't cover webview iframes, so copy/paste
// silently die in every editable (rename fields, composer). Capture phase —
// RenameInput stops keydown propagation.
//
// Modern hosts relay the clipboard commands into the focused webview
// themselves; execCommand on top of that doubles every paste. So relay as a
// fallback only: if no native clipboard event lands shortly after the
// keystroke, the host dropped the key and we drive the command ourselves.
// Cmd+A stays direct — selecting all twice is the same selection.
if (navigator.userAgent.includes("Mac")) {
  const pending: Record<string, { native: boolean }> = {};
  window.addEventListener(
    "keydown",
    (e) => {
      // The host re-dispatches webview keydowns synthetically after its
      // keybinding service passes on them; only the real keystroke counts.
      if (!e.isTrusted) return;
      if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const el = e.target;
      const editable =
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLElement && el.isContentEditable);
      if (!editable) return;
      const k = e.key.toLowerCase();
      if (k === "a") {
        e.preventDefault();
        document.execCommand("selectAll");
        return;
      }
      const cmd = k === "c" ? "copy" : k === "x" ? "cut" : k === "v" ? "paste" : "";
      if (!cmd || pending[cmd]) return;
      e.preventDefault();
      const state = { native: false };
      const mark = () => {
        state.native = true;
      };
      document.addEventListener(cmd, mark, { once: true, capture: true });
      window.setTimeout(() => {
        delete pending[cmd];
        document.removeEventListener(cmd, mark, { capture: true });
        if (!state.native) document.execCommand(cmd);
      }, 300);
    },
    true,
  );
}

// Escape closes the open popover before anything else — capture phase,
// ahead of the composer's blur/stop handling, so one key does one thing.
window.addEventListener(
  "keydown",
  (e) => {
    if (e.key === "Escape" && popover.value) {
      e.preventDefault();
      e.stopPropagation();
      setPopover(undefined);
    }
  },
  true,
);

