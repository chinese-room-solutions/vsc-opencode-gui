import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { Composer } from "../components/Composer";
import { ContextRing, foldFreedTokens } from "../components/ContextRing";
import { Docks } from "../components/Docks";
import {
  CompactedTurn,
  MessageView,
  StatusStats,
  TurnFooter,
} from "../components/MessageView";
import { RenameInput } from "../components/RenameInput";
import { StuckChip } from "../components/ToolCard";
import { DotsIcon, StopIcon, WordmarkIcon } from "../icons";
import { isText, isTool } from "../api";
import {
  deleteSession,
  interruptedPrompts,
  loadOlderMessages,
  hasOlder,
  markPromptStopped,
  messagesBySession,
  messagesFor,
  popover,
  hasQueued,
  queuedTurns,
  refreshMessages,
  refreshPermissions,
  refreshQuestions,
  refreshStatuses,
  renameSession,
  sendError,
  sessionStatus,
  sessionTitle,
  sessions,
  setPopover,
  stoppedPrompts,
} from "../store";
import { navigate } from "../router";
import { interruptStuck, stuckState } from "../stuck";
import { useArm } from "../useArm";
import type { ChatMessage } from "../store";

// A turn is one prompt plus everything answering it. The v2 rows are flat
// and SSE steps carry no parentID, so the prompt boundary is the grouping:
// assistant steps always join the open turn; a new prompt (a steer) starts
// a new one. The footer hangs off the whole turn, and the prompt sticks to
// the panel's top within the turn's box (styles.css).
type Group = { key: string; msgs: ChatMessage[] };

function groupTurns(list: ChatMessage[]): Group[] {
  const out: Group[] = [];
  for (const m of list) {
    const last = out[out.length - 1];
    if (m.info.role === "assistant" && last) last.msgs.push(m);
    else out.push({ key: m.info.id, msgs: [m] });
  }
  return out;
}

// Reader position per session, kept outside the component: App keys Session
// by session id, so switching sessions remounts it and plain refs would die.
// "bottom" — the session was read to its end; returning rejoins the tail
// (lines may have streamed in since) instead of a stale offset.
// Bounded by live sessions: entries outlive their transcripts otherwise.
const scrollMemo = new Map<string, number | "bottom">();
function pruneScrollMemo(): void {
  if (scrollMemo.size <= 16) return;
  for (const k of [...scrollMemo.keys()])
    if (!messagesBySession.value.has(k)) scrollMemo.delete(k);
}

// One chat view for an existing session (sessionId set) and the draft
// (undefined): the draft only gains a session when the first prompt is sent.
// `parent` marks a sub-agent session viewed inside its parent's tab: the
// breadcrumb leads back up. The composer rides along — a prompt onto the
// child's running turn steers it at the next step boundary, the same
// mid-run steer the relaying parent agent sends.
export function Session(props: { sessionId?: string; parent?: string }) {
  pruneScrollMemo();
  const id = props.sessionId;
  const list = id ? messagesFor(id).value : undefined;
  const session = id ? sessions.value.find((s) => s.id === id) : undefined;
  const title = id ? (session?.title ?? id) : "";
  const [renaming, setRenaming] = useState(false);
  const parentSession = props.parent
    ? sessions.value.find((s) => s.id === props.parent)
    : undefined;

  useEffect(() => {
    if (id) void refreshMessages(id);
    void refreshStatuses();
  }, [id]);

  // Follow new content only while the reader is already near the bottom.
  const scroller = useRef<HTMLDivElement>(null);
  // Leaving the session records the position here. Refs are nulled before
  // unmount cleanups run, so the element is kept past detach for that read.
  const kept = useRef<HTMLDivElement | null>(null);
  const setScroller = (el: HTMLDivElement | null) => {
    scroller.current = el;
    if (el) kept.current = el;
  };
  const stick = useRef(true);
  // scrollTop of the previous scroll event (see pinned).
  const lastTop = useRef(0);
  // Where to put the reader once this session's content first renders —
  // seeded from the memo at mount, before any scroll of this instance.
  const restore = useRef(id ? scrollMemo.get(id) : undefined);
  const st = id ? sessionStatus.value[id] : undefined;
  const busy = st?.type === "busy";

  // Backstop for events lost without the stream ever dropping (a
  // suspended webview's host messages can vanish): while this session
  // shows busy, pull truth on a timer. Status always pulls — it can't
  // discard an un-admitted prompt echo, and the idle it lands retires a
  // stale echo; the row/ask pulls wait for the echo to be gone.
  useEffect(() => {
    if (!id || !busy) return;
    const timer = window.setInterval(() => {
      void refreshStatuses();
      const echo = messagesBySession.value
        .get(id)
        ?.some((m) => m.info.id.startsWith("pending:"));
      if (echo) return;
      void refreshMessages(id);
      void refreshPermissions(id);
      void refreshQuestions(id);
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [id, busy]);
  // The newest pending row hasn't been taken yet: a prompt or command
  // held for the running turn's end — the "Queued" caption and the
  // no-pin rule below apply to both.
  const queuedNow = id !== undefined && hasQueued(id);
  // Prepend anchor: the scroller's height/offset captured when "Load older
  // messages" was clicked, so the layout effect can hold the viewport still.
  // The node is the content the reader was on; clamped user texts grow when
  // their toggles render after this commit, so the node re-pins it in rAF.
  const anchor = useRef<{
    height: number;
    top: number;
    node?: Element;
    nodeTop?: number;
  }>();
  const pinned = () => {
    const el = scroller.current;
    if (!el) return;
    const top = el.scrollTop;
    const rising = top < lastTop.current;
    lastTop.current = top;
    if (stick.current && rising) {
      // Leave-the-bottom intent — any input that scrolls up (wheel,
      // scrollbar drag, touch, keyboard). Latch the follow off at the first
      // rising event, or a delta landing mid-gesture snaps the reader back
      // while they are still inside the arming band: scrolling up during a
      // stream became a fight the follow always won.
      stick.current = false;
      return;
    }
    const dist = el.scrollHeight - top - el.clientHeight;
    // Disengaged, only the true bottom re-arms the follow: re-arming at the
    // 80px band re-armed inside the very gesture leaving it. A flick or
    // momentum carries to dist 0, so returning to the tail re-follows.
    // Armed, only a rising scroll (above) disengages: a non-rising event
    // past the band is the browser (scroll-anchoring after late layout
    // growth below the fold), not the reader — the next follow pass
    // re-bottoms.
    if (!stick.current) stick.current = dist < 4;
  };
  // Wheel intent precedes its first scroll event by up to a frame; latch
  // here too, so a delta committing in that gap finds the follow already
  // off.
  const wheel = (e: WheelEvent) => {
    if (e.deltaY < 0) stick.current = false;
  };
  // Leaving the session saves where the reader stopped, so coming back
  // resumes there. On unmount, not on scroll: programmatic moves (the
  // bottom-follow pins) may fire no scroll event at all.
  useEffect(() => {
    return () => {
      const el = kept.current;
      if (!id || !el) return;
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      scrollMemo.set(id, atBottom ? "bottom" : el.scrollTop);
    };
  }, [id]);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    // A re-entered session puts the reader back where they left it. Wait
    // for content: the effect fires on the empty pre-fetch list too. The
    // browser clamps a position beyond what's loaded (older pages fetch
    // only on demand), so a deep spot lands as far down as exists.
    if (restore.current !== undefined) {
      if (!list || list.length === 0) return;
      const top = restore.current;
      restore.current = undefined;
      stick.current = top === "bottom";
      el.scrollTop = top === "bottom" ? el.scrollHeight : top;
      if (top === "bottom") {
        // Late layout (the clearance RO, image decodes) grows the tail
        // after the assignment; re-assert the bottom while it settles so
        // the reader rejoins the tail they left. Guarded by stick — an
        // instant leave-the-bottom wins.
        const settle = () => {
          const s = scroller.current;
          if (stick.current && s) s.scrollTop = s.scrollHeight;
        };
        requestAnimationFrame(settle);
        window.setTimeout(settle, 350);
      }
      return;
    }
    // A prepend (older page) must not move the viewport: anchor it to the
    // content it was reading by re-adding the grown height. Set by the
    // button's onClick before the list lands.
    if (anchor.current) {
      const a = anchor.current;
      anchor.current = undefined;
      el.scrollTop = el.scrollHeight - a.height + a.top;
      if (a.node && a.nodeTop !== undefined) {
        const { node, nodeTop } = a;
        requestAnimationFrame(() => {
          const s = scroller.current;
          if (!s || !node.isConnected) return;
          s.scrollTop +=
            node.getBoundingClientRect().top -
            s.getBoundingClientRect().top -
            nodeTop;
        });
      }
      return;
    }
    if (!stick.current) return;
    // A just-sent prompt pins itself to the panel's top right away —
    // pushing the previous exchange off — instead of riding up from the
    // bottom while the reply streams (Claude Code). Browser clamping keeps
    // a short history as high as it can go. A prompt queued onto a running
    // turn only follows at the bottom; pinning would yank the turn still
    // working out of view. The pill is the last user row anywhere — the
    // turn holding it is never :last-child, the awaiting placeholder
    // always renders after it.
    const last = list?.[list.length - 1];
    const pill =
      !queuedNow &&
      last &&
      last.info.role === "user" &&
      last.info.id.startsWith("pending:")
        ? [...el.querySelectorAll<HTMLElement>(".turn .msg.user")].pop()
        : undefined;
    if (pill) {
      el.scrollTop += pill.getBoundingClientRect().top - el.getBoundingClientRect().top;
      // stick.current = false alone holds the pinned view across the
      // pending→real message swap: the bottom-follow branch below returns
      // early while the follow is off, so the echo can't scroll the
      // just-pushed-off turn straight back into view — the pushed message
      // jumping out and in. Streaming re-arms the follow at the bottom
      // (pinned) once the reply fills the viewport.
      stick.current = false;
    } else {
      el.scrollTop = el.scrollHeight;
    }
  }, [list]);

  // The floating bottom chrome covers the transcript's last stretch, so the
  // scroller pads itself clear of it (the var feeds .msgs padding-bottom);
  // otherwise the resting last line would hide behind the composer.
  const bottom = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const b = bottom.current;
    const el = scroller.current;
    if (!b || !el) return;
    const ro = new ResizeObserver(() => {
      el.style.setProperty("--oc-clearance", `${b.offsetHeight + 12}px`);
    });
    ro.observe(b);
    return () => ro.disconnect();
  }, []);

  // Empty steps: assistant rows with no content and no tokens. The zhipuai
  // endpoint emits them in loops and never marks most completed, so
  // time.completed can't tell streaming from dead — the session's step
  // boundary state can. While busy, only an assistant row past the newest
  // prompt is live: the previous turn's tail must not animate just because
  // the next request was admitted but has no step yet. Dead ones render
  // nothing anywhere (no dot, no thinking line, no footer).
  const emptyStep = (m: ChatMessage) =>
    !m.info.error &&
    !m.parts.some((p) => isTool(p) || (isText(p) && p.text)) &&
    !m.info.tokens?.total;
  const liveId = (() => {
    if (!busy || !list) return undefined;
    // A queued steer holds until the running turn reaches a boundary: it
    // must not blind the turn's live markers (Thinking..., the footer).
    const queued =
      id !== undefined &&
      queuedTurns.value.some((q) => q.id === id && q.kind === "prompt");
    // Newest assistant row past the newest prompt: each prompt resets the
    // candidate, each assistant row takes it.
    let live: string | undefined;
    for (const m of list) {
      if (m.info.role === "user") {
        if (!queued) live = undefined;
      } else if (m.info.role === "assistant") live = m.info.id;
    }
    return live;
  })();
  // The abort receipt: the server answers a stopped turn with an
  // error-only assistant row ("Aborted"). The stop marker tells that
  // story in the user's words — the receipt would add a red line and
  // make the footer parade a turn that never ran. Matched by message,
  // so a reload reads the same.
  const abortReceipt = (m: ChatMessage) =>
    m.info.error?.data?.message === "Aborted" &&
    !m.info.tokens?.total &&
    !m.parts.some((p) => isTool(p) || (isText(p) && p.text));
  const visible = list?.filter(
    (m) =>
      m.info.role === "user" ||
      m.info.id === liveId ||
      (!abortReceipt(m) && !emptyStep(m)),
  );
  // Reload seeding: the stop marks die with the view, but the server's
  // abort record is durable — an assistant row errored "Aborted", with or
  // without content. Re-mark its prompt so the awaiting gate holds and
  // the Interrupted marker survives the remount.
  useEffect(() => {
    if (!list) return;
    let owner: string | undefined;
    for (const m of list) {
      if (m.info.role === "user") owner = m.info.id;
      else if (owner && m.info.error?.data?.message === "Aborted")
        markPromptStopped(owner);
    }
  }, [list]);
  // A /compact whose trigger row is the newest message: the fold itself
  // speaks for the turn, so no awaiting placeholder goes up over it.
  const lastVisible = visible?.[visible.length - 1];
  const compacting =
    lastVisible?.info.role === "user" &&
    lastVisible.parts.some((p) => p.type === "compaction");
  // A compaction in flight: the newest turn is a compact fold and the session
  // is busy. Covers the latency before the summary row exists and the tail
  // after its text closes; the beacon clears only when the session idles.
  const groups = visible ? groupTurns(visible) : [];
  const lastGroup = groups[groups.length - 1];
  const compactLive =
    busy === true &&
    lastGroup !== undefined &&
    lastGroup.msgs[0].info.role === "user" &&
    lastGroup.msgs[0].parts.some((p) => p.type === "compaction");
  // Request admitted, no step yet: activity shows in the answer slot (Claude
  // Code), not on the previous turn's last message. The first step's row
  // replaces it. Not gated on busy: the endpoint's spurious empty steps idle
  // the session mid-turn, and the indicator must not flicker off then — a
  // failed turn still breaks out because the error row becomes visible.
  // An interrupted prompt is answered by nothing — the user ended the turn.
  const awaiting =
    visible?.[visible.length - 1]?.info.role === "user" &&
    !compacting &&
    !interruptedPrompts.value.has(visible[visible.length - 1].info.id);
  // A queued prompt reads differently: the server holds it until the
  // current work reaches a step boundary. No clock — nothing is processing
  // it yet, and a ticking timer would claim otherwise.
  const queued = awaiting && queuedNow;
  // The turn is working but nothing shows it: every text part closed and no
  // tool row is running — a running tool pulses in its own row, and a second
  // pulsing indicator under the footer reads as a duplicate. The residue is
  // also what a just-finished turn looks like for the idle grace's seconds,
  // so the line holds off and only appears for sustained silence.
  const gap = (() => {
    // The compaction fold carries its own beacon; a second line below the
    // footer would read as a duplicate.
    if (!busy || awaiting || compactLive) return false;
    const liveMsg = visible?.find((m) => m.info.id === liveId);
    if (!liveMsg) return false;
    if (!liveMsg.parts.some((p) => isText(p) && p.text)) return false;
    if (liveMsg.parts.some((p) => isTool(p) && p.state?.status === "running"))
      return false;
    return !liveMsg.parts.some(
      (p) => isText(p) && p.text && p.time?.end === undefined,
    );
  })();
  const [gapHold, setGapHold] = useState(false);
  useEffect(() => {
    if (!gap) {
      setGapHold(false);
      return;
    }
    const t = window.setTimeout(() => setGapHold(true), 4000);
    return () => window.clearTimeout(t);
  }, [gap]);
  const working = gap && gapHold;

  // Turn-level stuck: the same mark the tool rows use, for the session as a
  // whole (busy, nothing running, no events). Renders under the wait
  // indicators; the chip ticks itself.
  const stuckEntry = id ? stuckState.value[id] : undefined;
  const turnMark =
    stuckEntry && !stuckEntry.escalated && id
      ? stuckEntry.turn
      : undefined;
  const turnChip = turnMark && id && (
    <StuckChip
      since={turnMark.since}
      kind="turn"
      onInterrupt={() =>
        void interruptStuck(id, {
          kind: "turn",
          minutes: Math.max(
            1,
            Math.round((Date.now() - turnMark.since) / 60_000),
          ),
        })
      }
    />
  );

  // The "Waiting for the model..." placeholder holds through short idles —
  // the endpoint's spurious empty steps idle mid-turn, and a hard flicker
  // off would read as a dead turn. Once the idle is sustained (reload of a
  // session whose last prompt died with the old server: nothing will ever
  // answer it) the hold breaks and the phantom wait retires.
  const [waitHold, setWaitHold] = useState(false);
  useEffect(() => {
    if (busy || st?.type === "retry") {
      setWaitHold(false);
      return;
    }
    const t = window.setTimeout(() => setWaitHold(true), 4000);
    return () => window.clearTimeout(t);
  }, [busy, st?.type]);

  // The untouched session reads as a launch screen (opencode's new session):
  // the wordmark and the composer sit mid-panel instead of docked bottom.
  // Only a session known to be empty — the draft, or one whose messages have
  // resolved to nothing; an unloaded list stays docked so switching to a
  // busy session never flashes the centered view on its way in.
  const empty =
    !props.parent && (!id || (list !== undefined && visible?.length === 0));

  return (
    <div class={empty ? "chat empty" : "chat"}>
      {id && (
        <div class="chat-head">
          {props.parent && (
            <nav class="crumb" aria-label="Sub-session path">
              <button
                class="crumb-parent"
                title="Back to the parent session"
                onClick={() => navigate({ view: "session", id: props.parent! })}
              >
                {sessionTitle(parentSession, props.parent)}
              </button>
              <span class="crumb-sep" aria-hidden="true">
                /
              </span>
              <span class="crumb-here">{sessionTitle(session, id)}</span>
            </nav>
          )}
          {renaming && (
            <HeadRename
              id={id}
              title={title}
              onDone={() => setRenaming(false)}
            />
          )}
          <ContextRing sessionId={id} />
          <HeadMenu
            id={id}
            onRename={() => setRenaming(true)}
          />
        </div>
      )}
      {/* The fade overlay hangs off the wrap, not the scroller: inside it
          would scroll away with the content (Claude Code's .messageGradient). */}
      <div class="msgs-wrap">
        <div class="msgs" ref={setScroller} onScroll={pinned} onWheel={wheel}>
          {id && hasOlder(id) && (
            <button
              class="load-older"
              onClick={async () => {
                const el = scroller.current;
                if (el) {
                  const node = el.querySelector(".turn") ?? undefined;
                  anchor.current = {
                    height: el.scrollHeight,
                    top: el.scrollTop,
                    node,
                    nodeTop: node
                      ? node.getBoundingClientRect().top -
                        el.getBoundingClientRect().top
                      : undefined,
                  };
                }
                // Nothing came back: the cursor was exhausted, the anchor
                // has no prepend to survive and must not fire on the next
                // unrelated list change.
                if (!(await loadOlderMessages(id))) anchor.current = undefined;
              }}
            >
              Load older messages
            </button>
          )}
          {visible &&
            groups.map((g) => {
              // The compaction turn renders as one fold (Claude Code): the
              // trigger row and the summary answer that follows it. The
              // freed number is the context the fold dropped — the last
              // real turn's usage, the same total the ring shows.
              const first = g.msgs[0];
              if (
                first.info.role === "user" &&
                first.parts.some((p) => p.type === "compaction")
              ) {
                const idx = visible.indexOf(first);
                const freed = id
                  ? foldFreedTokens(id, visible.slice(0, idx), g.msgs)
                  : undefined;
                // Live while the session works the compaction turn itself:
                // busy and nothing but queued prompts after the fold. A
                // message sent mid-compaction must not settle the label —
                // its first step row is the proof the turn really ended.
                const foldIds = new Set(g.msgs.map((m) => m.info.id));
                const laterTurn = visible
                  .slice(idx + 1)
                  .some(
                    (m) =>
                      m.info.role === "assistant" && !foldIds.has(m.info.id),
                  );
                return (
                  <CompactedTurn
                    key={g.key}
                    msgs={g.msgs}
                    live={busy === true && !laterTurn}
                    freedK={freed ? Math.round(freed / 1000) : undefined}
                  />
                );
              }
              return (
                <div class="turn" key={g.key}>
                  {g.msgs.map((m) => (
                    <MessageView
                      key={m.info.id}
                      m={m}
                      live={m.info.id === liveId}
                    />
                  ))}
                  {/* Only a turn that ran gets a footer: a queued prompt
                      sits alone in its group, and its user row carries
                      agent/model the footer would parade as if a turn
                      had already answered it. */}
                  {g.msgs.some((m) => m.info.role === "assistant") && (
                    <TurnFooter
                      msgs={g.msgs}
                      live={g.msgs.some((m) => m.info.id === liveId)}
                    />
                  )}
                  {/* The user stopped this turn: a quiet marker where the
                      reply would have continued — the server announces an
                      abort with nothing on the stream. */}
                  {stoppedPrompts.value.has(g.key) && (
                    <div class="interrupted">
                      <StopIcon />
                      <span>Interrupted</span>
                    </div>
                  )}
                </div>
              );
            })}
          {awaiting && (busy || !waitHold) && (
            <div class="turn">
              <div class="msg assistant dot-running">
                <div class="status-line">
                  <span class="dot" aria-hidden="true" />
                  <div class="thinking-line">
                    {queued
                      ? "Queued for the running turn"
                      : "Waiting for the model..."}
                    {/* Nothing is streamed yet — the clock is all there
                        is until the first step lands. */}
                    {!queued && (
                      <StatusStats
                        start={visible?.[visible.length - 1]?.info.time.created}
                        gen={0}
                      />
                    )}
                  </div>
                </div>
                {turnChip}
              </div>
            </div>
          )}
          {working && (
            <div class="turn">
              <div class="msg assistant dot-running">
                <div class="status-line">
                  <span class="dot" aria-hidden="true" />
                  <div class="thinking-line">Working...</div>
                </div>
                {turnChip}
              </div>
            </div>
          )}
          {/* In the scroller, not the floating chrome: an error is part of
              the session's story and reflows with the content above it —
              and only THIS session's story: failures are keyed to the
              session they fired in, so nothing leaks across tabs. */}
          {sendError.value !== undefined && sendError.value.for === id && (
            <div class="send-error">{sendError.value.text}</div>
          )}
        </div>
        <div class="msgs-fade" />
      </div>
      {/* The bottom chrome floats over the transcript (Claude Code's absolute
          inputContainer): content runs underneath it and dissolves at the
          panel's edge, so the transcript reserves its height through the
          --oc-clearance padding on .msgs, measured off this stack. */}
      <div class="chat-bottom" ref={bottom}>
        {empty && <WordmarkIcon />}
        <Docks sessionId={id} />
        <Composer sessionId={id} status={st} />
      </div>
    </div>
  );
}

// The session head's "…": rename and delete, the actions the tab's
// right-click menu also offers. Delete arms on the first click. It shares
// the app's one-open-popover rule (closing the ring and the composer
// pickers when it opens, and vice versa).
function HeadMenu(props: { id: string; onRename: () => void }) {
  const open = popover.value === "headmenu";
  const [armed, arm, disarm] = useArm();

  const close = () => {
    setPopover(undefined);
    disarm();
  };

  const del = () => {
    if (!armed) {
      arm();
      return;
    }
    close();
    void deleteSession(props.id);
  };

  return (
    <div class="headmenu">
      {open && <div class="backdrop" onClick={close} />}
      <button
        type="button"
        class="headmenu-btn"
        title="Session actions"
        aria-label="Session actions"
        aria-expanded={open}
        onClick={() => setPopover(open ? undefined : "headmenu")}
      >
        <DotsIcon />
      </button>
      {open && (
        <div class="menu headmenu-pop">
          <button
            class="menu-item"
            onClick={() => {
              close();
              props.onRename();
            }}
          >
            <span class="menu-texts">
              <span class="menu-label">Rename</span>
            </span>
          </button>
          <div class="menu-sep" />
          <button
            class={armed ? "menu-item armed" : "menu-item"}
            onClick={del}
          >
            <span class="menu-texts">
              <span class="menu-label">
                {armed ? "Confirm Deletion" : "Delete…"}
              </span>
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

function HeadRename(props: { id: string; title: string; onDone: () => void }) {
  return (
    <RenameInput
      class="rename-input head-rename"
      title={props.title}
      onCommit={(t) => void renameSession(props.id, t)}
      onCancel={props.onDone}
    />
  );
}
