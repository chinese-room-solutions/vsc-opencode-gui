import { signal } from "@preact/signals";

// Bridge to the extension host. main.tsx captures acquireVsCodeApi() here so
// any component can post without threading it through props.
type VsCodeApi = { postMessage(message: unknown): void };

let api: VsCodeApi | undefined;

export function captureApi(a: VsCodeApi): void {
  api = a;
}

// Which host baked this page (the opencode-host meta): "navigator" is the
// sidebar session browser; anything else is a "session" host — one
// conversation's editor tab. Read once at boot; writable only so tests
// can stage the other host (the node test rig installs its document
// stub after this module loads — there, the default stands).
export type HostKind = "navigator" | "session";
function bootHostKind(): HostKind {
  if (typeof document === "undefined") return "session";
  return document
    .querySelector('meta[name="opencode-host"]')
    ?.getAttribute("content") === "navigator"
    ? "navigator"
    : "session";
}
export const hostKind = signal<HostKind>(bootHostKind());

export function postToHost(message: unknown): void {
  api?.postMessage(message);
}

// True when this page runs under the extension host (the vscode api was
// captured). False standalone (the ui rig's plain browser tab).
export function isHosted(): boolean {
  return api !== undefined;
}

// Open a file (relative paths resolved host-side) at an optional 1-based
// line range.
export function openFile(path: string, line?: string, endLine?: string): void {
  postToHost({ type: "open-file", path, line, endLine });
}

// Hand a file to the OS default tool for its extension.
export function openExternal(path: string): void {
  postToHost({ type: "open-external", path });
}

// Open a URL in the system browser (webfetch tool rows link their target).
export function openUrl(url: string): void {
  postToHost({ type: "open-url", url });
}
