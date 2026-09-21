// Bridge to the extension host. main.tsx captures acquireVsCodeApi() here so
// any component can post without threading it through props.
type VsCodeApi = { postMessage(message: unknown): void };

let api: VsCodeApi | undefined;

export function captureApi(a: VsCodeApi): void {
  api = a;
}

export function postToHost(message: unknown): void {
  api?.postMessage(message);
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
