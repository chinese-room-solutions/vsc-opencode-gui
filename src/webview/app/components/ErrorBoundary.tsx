// Last-resort recovery surface: any render/handler error unmounts the app
// onto this card — a dead tree renders as a permanently blank page. All
// crash paths funnel here (componentDidCatch and main.tsx's window
// handlers); only a host re-render (crash-reload → fresh page) returns.
import { Component, render } from "preact";
import type { ComponentChild } from "preact";
import { postToHost } from "../host";

let crashed = false;

export function showCrashCard(error: unknown): void {
  if (crashed) return;
  crashed = true;
  const root = document.getElementById("app");
  if (!root) return;
  const message = String(
    (error as { message?: unknown } | null | undefined)?.message ?? error,
  ).slice(0, 300);
  try {
    render(
      <div class="crash-card">
        <div class="crash-title">The view crashed</div>
        <div class="crash-message" title={message}>
          {message}
        </div>
        <button
          type="button"
          class="crash-reload"
          onClick={() => postToHost({ type: "crash-reload" })}
        >
          Reload
        </button>
      </div>,
      root,
    );
  } catch {
    // The card itself must never loop: dead-simple text instead.
    root.textContent = `The view crashed: ${message}`;
  }
}

export class ErrorBoundary extends Component<{ children?: ComponentChild }> {
  componentDidCatch(error: unknown) {
    showCrashCard(error);
  }

  render() {
    return this.props.children;
  }
}
