import { Navigator } from "./views/Navigator";
import { Session } from "./views/Session";
import { Lightbox } from "./components/Lightbox";
import { useEffect } from "preact/hooks";
import { hostKind, hostSessionId, postToHost } from "./host";
import { route } from "./router";
import { status, tabFacts } from "./store";
import DOMPurify from "dompurify";

// Shell: one content panel filling the host. A session
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
    <>
      {/* The tab's status prefix (spinner / yellow / green) is host-side
          (panel.iconPath): this poster reports the ROOT session's facts —
          the tab stays the root's even while drilled into a child. */}
      <TabSignalPoster root={r.id} />
      <Session
        key={`${r.id}:${r.child ?? ""}`}
        sessionId={r.child ?? r.id}
        parent={r.child ? r.id : undefined}
      />
    </>
  );
}

// Reports the root session's busy/attention to the host whenever they
// change (turnEnded posts separately from the store's setIdle). The
// meta gate keeps the navigator and mis-pinned pages silent.
function TabSignalPoster(props: { root: string }) {
  const facts = tabFacts(props.root);
  useEffect(() => {
    if (hostSessionId() !== props.root) return;
    postToHost({ type: "tab-signal", ...facts });
  }, [props.root, facts.busy, facts.attention]);
  return null;
}
