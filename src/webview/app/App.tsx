import { Navigator } from "./views/Navigator";
import { Session } from "./views/Session";
import { Confirm } from "./components/Confirm";
import { Lightbox } from "./components/Lightbox";
import { useEffect } from "preact/hooks";
import { hostKind, hostSessionId, postToHost } from "./host";
import { route } from "./router";
import {
  confirmDeleteId,
  confirmDeleteProceed,
  sessionTitle,
  sessions,
  status,
  tabFacts,
  tabSignalRoot,
} from "./store";
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
      <DeleteConfirm />
    </div>
  );
}

// The tab menu's Delete lands here rather than in the Session view: the
// host may ask while this page shows another route (a sub-agent drill), so
// the dialog lives at the app level and names its target. Same component
// and wording as the session body's confirm.
function DeleteConfirm() {
  const id = confirmDeleteId.value;
  if (id === undefined) return null;
  const title = sessionTitle(sessions.value.find((s) => s.id === id), id);
  return (
    <Confirm
      text={<>Delete session “{title}”? This cannot be recovered.</>}
      dangerLabel="Delete session"
      onConfirm={() => void confirmDeleteProceed()}
      onCancel={() => (confirmDeleteId.value = undefined)}
    />
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
          (panel.iconPath): this poster reports the conversation on screen
          — the displayed chat, or its top ancestor while a sub-agent
          transcript is showing. */}
      <TabSignalPoster root={tabSignalRoot(r.child ?? r.id)} />
      <Session
        key={`${r.id}:${r.child ?? ""}`}
        sessionId={r.child ?? r.id}
        parent={r.child ? r.id : undefined}
      />
    </>
  );
}

// Reports the shown conversation's busy/attention to the host whenever
// they change (turnEnded posts separately from the store's setIdle). A
// session tab is any page with a session meta — the route need not match
// it, so a re-rooted drill still reports for its own tab; the navigator
// (no meta) stays silent. Posts re-fire on a beat so a dropped post (a
// hidden panel, a suspended renderer) self-heals instead of leaving the
// tab idle for the whole turn; the host's TabSignal dedupes unchanged
// facts.
const TAB_SIGNAL_BEAT_MS = 10_000;

function TabSignalPoster(props: { root: string }) {
  const facts = tabFacts(props.root);
  useEffect(() => {
    if (!hostSessionId()) return;
    const post = () =>
      postToHost({ type: "tab-signal", ...tabFacts(props.root) });
    post();
    const beat = window.setInterval(post, TAB_SIGNAL_BEAT_MS);
    return () => window.clearInterval(beat);
  }, [props.root, facts.busy, facts.attention]);
  return null;
}
