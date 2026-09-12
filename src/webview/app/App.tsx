import { Home } from "./views/Home";
import { Session } from "./views/Session";
import { TabsBar } from "./components/TabsBar";
import { Lightbox } from "./components/Lightbox";
import { route } from "./router";
import { status } from "./store";
import DOMPurify from "dompurify";

// Shell: toolbar row (all routes) above the floating content panel, the
// whole thing on the backdrop color. The server connection state has no
// chrome — failures surface through the error view below.
export function App() {
  const s = status.value;
  if (s.kind === "loading") {
    return <div class="status">Starting opencode server...</div>;
  }
  if (s.kind === "error") {
    // Host-authored message, sanitized to <code>-only markup — the text
    // interpolates opencode process output and must not inject tags.
    const html = DOMPurify.sanitize(s.message, {
      ALLOWED_TAGS: ["code"],
      ALLOWED_ATTR: [],
    });
    return (
      <div class="error">
        <div dangerouslySetInnerHTML={{ __html: html }} />
        {s.showInstallHint && (
          <p>
            Make sure <code>opencode</code> is installed and available in your
            PATH.
          </p>
        )}
      </div>
    );
  }
  const r = route.value;
  return (
    <div class="app">
      <TabsBar />
      <main class="panel">
        {r.view === "home" && <Home />}
        {r.view === "session" && (
          <Session
            key={`${r.id}:${r.child ?? ""}`}
            sessionId={r.child ?? r.id}
            parent={r.child ? r.id : undefined}
          />
        )}
        {r.view === "draft" && <Session key="draft" />}
      </main>
      <Lightbox />
    </div>
  );
}
