// Server events are host-fed: the extension host (AppHost) owns the SSE
// connection — the webview can't open one itself (opaque origin, so the
// server's CORS blocks it) — and forwards frames as {type:"sse-event"}
// messages, with the connection lifecycle as {type:"sse-state"}.
export interface ServerEvent {
  id: string;
  type: string;
  data: unknown;
}

export type SseState = "connecting" | "connected" | "offline";

export interface EventHandlers {
  onEvent: (event: ServerEvent) => void;
  onState?: (state: SseState) => void;
}

// Subscribes to the host's feed. The disposer only unsubscribes — the
// connection itself lives (and reconnects) host-side.
export function connectEvents(handlers: EventHandlers): () => void {
  const onMessage = (e: MessageEvent) => {
    const m = e.data as { type?: string; state?: SseState; event?: ServerEvent };
    if (m?.type === "sse-state" && m.state) handlers.onState?.(m.state);
    if (m?.type === "sse-event" && m.event) handlers.onEvent(m.event);
  };
  window.addEventListener("message", onMessage);
  return () => window.removeEventListener("message", onMessage);
}
