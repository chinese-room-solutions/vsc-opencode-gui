import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { terminalText } from "../api";
import {
  OpenIcon,
  PixelMark,
  PixelSpinner,
  StopIcon,
  TerminalIcon,
} from "../icons";
import { route, navigate } from "../router";
import {
  type ActiveShell,
  activeShells,
  fmtDur,
  popover,
  readShellOutput,
  readShellStatus,
  setPopover,
  stopShellRow,
} from "../store";

// The head's background-command roster, next to the sub-agent roster. A
// command moved to the background outlives its turn — the session reads
// idle and the tab still spins (familyWorking), but the running command
// sits in a transcript row buried under follow-up turns, or in a child
// session the user never opened. This button keeps the live set one click
// away: what runs and for how long, its live output, and the stop that
// kills it (the same DELETE the buried row's stop issues).
export function ShellMenu(props: { sessionId: string }) {
  const entries = activeShells(props.sessionId);
  const open = popover.value === "shells";
  // One row shows its output at a time, which keeps the menu short.
  const [shownId, setShownId] = useState<string | undefined>(undefined);
  // A shown command that ends leaves runningShells but stays listed,
  // settled, in its place until the reader closes it or the menu: the
  // last-known facts and row order carry it.
  const seen = useRef(new Map<string, ActiveShell>());
  const order = useRef<string[]>([]);
  for (const id of seen.current.keys())
    if (id !== shownId) seen.current.delete(id);
  for (const e of entries) seen.current.set(e.id, e);
  const settled =
    shownId !== undefined && !entries.some((e) => e.id === shownId)
      ? seen.current.get(shownId)
      : undefined;
  const rows = [...entries];
  if (settled && open) {
    const at = order.current.indexOf(settled.id);
    rows.splice(at < 0 ? rows.length : Math.min(at, rows.length), 0, settled);
  }
  order.current = rows.map((r) => r.id);
  useEffect(() => {
    if (settled && !open) setShownId(undefined);
    // An emptied roster closes its menu: the next command must not pop
    // it open on its own.
    if (open && rows.length === 0) setPopover(undefined);
  });
  // Elapsed times tick while the open menu lists a running command.
  const [, tick] = useState(0);
  const ticking = open && entries.length > 0;
  useEffect(() => {
    if (!ticking) return;
    const t = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [ticking]);
  if (rows.length === 0) return null;
  const n = entries.length;
  return (
    <div class={["sjm", open && "open"].filter(Boolean).join(" ")}>
      <button
        type="button"
        class="sjm-btn"
        title={`${n} background command${n === 1 ? "" : "s"} running`}
        aria-label={`Background commands running: ${n}. Click to ${
          open ? "hide" : "list"
        }.`}
        aria-expanded={open}
        onClick={() => setPopover(open ? undefined : "shells")}
      >
        <TerminalIcon />
        <span class="sjm-count">{n}</span>
      </button>
      {open && (
        <>
          <div class="backdrop" onClick={() => setPopover(undefined)} />
          <div
            class={["menu", "sjm-menu", shownId !== undefined && "wide"]
              .filter(Boolean)
              .join(" ")}
            role="menu"
            aria-label="Background commands"
          >
            <div class="sjm-title">Background commands</div>
            {rows.map((run) => (
              <ShellRow
                key={run.id}
                run={run}
                running={run !== settled}
                expanded={run.id === shownId}
                drill={run.owner !== props.sessionId}
                onToggle={() =>
                  setShownId(run.id === shownId ? undefined : run.id)
                }
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// How a command ended: the server's final status and exit code, or gone
// (a stop removes the command, and the server evicts old ones).
type ShellEnd = { gone: true } | { status: string; exit?: number };

// The settled row's word, in the shell notice card's terms.
function endLabel(end: ShellEnd, stopped: boolean): {
  text: string;
  failed: boolean;
} {
  if ("gone" in end)
    return { text: stopped ? "Stopped" : "Ended", failed: false };
  if (end.status === "killed") return { text: "Stopped", failed: false };
  if (end.status === "timeout") return { text: "Timed out", failed: true };
  if (end.exit !== undefined && end.exit !== 0)
    return { text: `Exit ${end.exit}`, failed: true };
  return { text: "Finished", failed: false };
}

function ShellRow(props: {
  run: ActiveShell;
  running: boolean;
  expanded: boolean;
  drill: boolean;
  onToggle: () => void;
}) {
  const { run, running } = props;
  const tail = useShellTail(run.id, running, props.expanded);
  // This window's stop, in flight until the command leaves the running
  // set: one stop per command, and the removed command reads "Stopped".
  const [stopping, setStopping] = useState(false);
  const end = running ? undefined : tail.end;
  const label = end ? endLabel(end, stopping) : undefined;
  return (
    <div class="sjm-row">
      <div
        class="sjm-chip"
        role="button"
        tabIndex={0}
        aria-expanded={props.expanded}
        title={run.command}
        onClick={props.onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            props.onToggle();
          }
        }}
      >
        {running ? <PixelSpinner /> : <PixelMark failed={label?.failed} />}
        <span class="sjm-cmd">{run.command}</span>
        {running && stopping && <span class="sjm-time">Stopping…</span>}
        {running && !stopping && run.started !== undefined && (
          <span class="sjm-time">
            {fmtDur(Math.max(0, Math.floor((Date.now() - run.started) / 1000)))}
          </span>
        )}
        {label && (
          <span class={label.failed ? "sjm-time failed" : "sjm-time"}>
            {label.text}
          </span>
        )}
        {/* A sub-agent's command: the conversation around it is the child
            session, one click away like a sub-agent chip. */}
        {props.drill && (
          <button
            type="button"
            class="sjm-open"
            title="Open the session running this command"
            aria-label="Open the session running this command"
            onClick={(e) => {
              e.stopPropagation();
              setPopover(undefined);
              const r = route.value;
              if (r.view === "session")
                navigate({
                  view: "session",
                  id: r.child ?? r.id,
                  child: run.owner,
                });
              else navigate({ view: "session", id: run.owner });
            }}
          >
            <OpenIcon />
          </button>
        )}
        {running && !stopping && (
          <button
            type="button"
            class="sjm-stop"
            title="Stop the command"
            aria-label="Stop the command"
            onClick={(e) => {
              e.stopPropagation();
              setStopping(true);
              void stopShellRow(run.id).then((ok) => {
                if (!ok) setStopping(false);
              });
            }}
          >
            <StopIcon />
          </button>
        )}
      </div>
      {props.expanded && (
        <ShellPane
          text={tail.text}
          total={tail.total}
          empty={
            tail.end && "gone" in tail.end
              ? "Output is not available."
              : running
                ? "No output yet."
                : "No output."
          }
        />
      )}
    </div>
  );
}

function fmtBytes(n: number): string {
  return n < 1024 * 1024
    ? `${(n / 1024).toFixed(1)} KB`
    : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// The pane opens on the output's last 32 KB and keeps at most 64 KB: the
// live end is what a background command's reader is after.
const TAIL_BYTES = 32_768;
const KEEP_CHARS = 65_536;

// Poll one command's output while its pane is open: once a second while
// it runs, then a final drain and its exit status once it ends. `total`
// is the output's full size once the text is only its end.
function useShellTail(
  id: string,
  running: boolean,
  enabled: boolean,
): { text: string; total?: number; end?: ShellEnd } {
  const [text, setText] = useState("");
  const [total, setTotal] = useState<number | undefined>(undefined);
  const [end, setEnd] = useState<ShellEnd | undefined>(undefined);
  const runningNow = useRef(running);
  runningNow.current = running;
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let timer: number | undefined;
    let cursor: number | undefined;
    // Opening mid-file starts mid-line: drop up to the first newline.
    let trimHead = false;
    let cut = false;
    let buf = "";
    setText("");
    setTotal(undefined);
    setEnd(undefined);
    const later = (ms: number) => {
      timer = window.setTimeout(() => void step(), ms);
    };
    const step = async (): Promise<void> => {
      const ended = !runningNow.current;
      if (cursor === undefined) {
        // A cursor past the end reads nothing and reports the size.
        const probe = await readShellOutput(id, Number.MAX_SAFE_INTEGER);
        if (!alive) return;
        if (probe?.gone) return setEnd({ gone: true });
        if (probe?.size === undefined) return later(1000);
        cursor = Math.max(0, probe.size - TAIL_BYTES);
        trimHead = cut = cursor > 0;
      }
      const page = await readShellOutput(id, cursor);
      if (!alive) return;
      if (page?.gone) return setEnd({ gone: true });
      if (page === undefined) return later(1000);
      if (page.cursor !== undefined) cursor = page.cursor;
      let chunk = page.output ?? "";
      if (trimHead && chunk) {
        const nl = chunk.indexOf("\n");
        chunk = nl < 0 ? "" : chunk.slice(nl + 1);
        trimHead = nl < 0;
      }
      if (chunk) {
        buf += chunk;
        if (buf.length > KEEP_CHARS) {
          const kept = buf.slice(-KEEP_CHARS);
          buf = kept.slice(kept.indexOf("\n") + 1);
          cut = true;
        }
        setText(buf);
      }
      if (cut && page.size !== undefined) setTotal(page.size);
      // Pages cap at 64 KB: catch up before waiting.
      if (page.size !== undefined && cursor < page.size) return later(0);
      if (!ended) return later(1000);
      const status = await readShellStatus(id);
      if (!alive) return;
      if (status === undefined) return later(1000);
      if ("status" in status && status.status === "running") return later(1000);
      setEnd(status);
    };
    void step();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [id, enabled]);
  return { text, total, end };
}

// The live output as a terminal shows it, past any leading blank lines
// (ping opens with one), following the end while the reader stays at
// the bottom.
function ShellPane(props: { text: string; total?: number; empty: string }) {
  const pre = useRef<HTMLPreElement>(null);
  const follow = useRef(true);
  const text = terminalText(props.text).replace(/^\s*\n/, "");
  useLayoutEffect(() => {
    const el = pre.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [text]);
  if (!text) return <div class="sjm-out empty">{props.empty}</div>;
  return (
    <pre
      ref={pre}
      class="sjm-out"
      onScroll={(e) => {
        const el = e.currentTarget;
        follow.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
      }}
    >
      {props.total !== undefined && (
        <span class="sjm-cut">
          {`Showing the end of ${fmtBytes(props.total)} of output.\n`}
        </span>
      )}
      {text}
    </pre>
  );
}
