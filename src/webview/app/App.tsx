import { Navigator } from "./views/Navigator";
import { Session } from "./views/Session";
import { Lightbox } from "./components/Lightbox";
import { hostKind } from "./host";
import { route } from "./router";
import { status } from "./store";
import DOMPurify from "dompurify";

// Shell: one floating content panel on the backdrop color. A session
// host renders its conversation; the navigator host renders the session
// browser. The server connection state has no chrome — failures surface
// through the error view below.
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
  return (
    <div class="app">
      <main class="panel">
        {hostKind.value === "navigator" ? <Navigator /> : <SessionPanel />}
      </main>
      {hostKind.value === "session" && <Lightbox />}
    </div>
  );
}

// A session host's route: one conversation (child = sub-agent
// drill-down). "home" only follows a stale-id bounce — the session is
// gone, and the card says what to do next.
function SessionPanel() {
  const r = route.value;
  if (r.view !== "session") {
    return (
      <div class="notfound">
        <p class="notfound-title">This session is gone.</p>
        <p>Close the tab, or pick another from the Sessions side panel.</p>
      </div>
    );
  }
  return (
    <Session
      key={`${r.id}:${r.child ?? ""}`}
      sessionId={r.child ?? r.id}
      parent={r.child ? r.id : undefined}
    />
  );
}
