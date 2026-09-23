import { useEffect, useRef, useState } from "preact/hooks";
import type { Session } from "../api";
import { postToHost } from "../host";
import { RenameInput } from "../components/RenameInput";
import {
  CheckIcon,
  CloseIcon,
  CopyIcon,
  NewSessionIcon,
  PencilIcon,
  SearchIcon,
  TrashIcon,
} from "../icons";
import { navigate } from "../router";
import {
  baseLoaded,
  currentDir,
  deleteSession,
  formatSessionTimes,
  homeFilter,
  homeQuery,
  isEmptySession,
  isSubagentSession,
  loadMoreSessions,
  newSession,
  normPath,
  projects,
  projectDisplayName,
  purgeProject,
  purgeState,
  renameProject,
  renameSession,
   sessionTile,
   sessionTitle,
   sendError,
   sessions,
  sessionsNext,
  sessionStatus,
  tombstones,
} from "../store";
import { baseName, parentName, tileFor } from "../tile";
import { useArm } from "../useArm";

// "Today" / "Yesterday" / locale date for a session row's group header.
function dayLabel(ts: number): string {
  const d = new Date(ts);
  const same = (other: Date) => d.toDateString() === other.toDateString();
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (same(today)) return "Today";
  if (same(yesterday)) return "Yesterday";
  return d.toLocaleDateString();
}

// Home: every project (left) and every session of every project (right,
// grouped by day), side by side in the panel. Clicking a project filters the
// session list to it (click again for all); a foreign session opens its
// project's folder in a new VS Code window, deep-linking the session —
// never in-app.
export function Home() {
  // The filters live in the store (homeQuery/homeFilter), so they survive
  // leaving the view — project selection and search are still set when the
  // user comes back from a session tab.
  const query = homeQuery.value;
  const filter = homeFilter.value;
  const dead = new Set(tombstones.value);

  const rowsByDir = new Map<string, Session[]>();
  for (const s of sessions.value) {
    const dir = normPath(s.location?.directory ?? "");
    // Sub-agent sessions stay out of the lists: the spawning turn's chip
    // is their way in.
    if (!dir || dead.has(dir) || isSubagentSession(s) || isEmptySession(s))
      continue;
    const rows = rowsByDir.get(dir);
    if (rows) rows.push(s);
    else rowsByDir.set(dir, [s]);
  }

  // Left column: every directory that has sessions or a known project row.
  // The server's "global" project (worktree "/", which normalizes to "")
  // has no place here — same skip the session grouping applies.
  const dirs = new Set(rowsByDir.keys());
  for (const p of projects.value) {
    const dir = normPath(p.worktree);
    if (dir && !dead.has(dir)) dirs.add(dir);
  }
  const dirList = [...dirs].sort((a, b) => {
    if (a === currentDir.value) return -1;
    if (b === currentDir.value) return 1;
    const updated = (d: string) => rowsByDir.get(d)?.[0]?.time.updated ?? 0;
    return updated(b) - updated(a);
  });
  // Distinct projects can share a display name (two checkouts of one
  // repo); a second delete then reads as the first having failed. Dispute
  // the twins with their parent folder, in the row and the dialog.
  const nameCounts = new Map<string, number>();
  for (const d of dirList) {
    const b = projectDisplayName(d);
    nameCounts.set(b, (nameCounts.get(b) ?? 0) + 1);
  }
  const disambig = (d: string) =>
    (nameCounts.get(baseName(d)) ?? 0) > 1 ? parentName(d) : undefined;

  // Right column: live-filtered by title or project name, grouped by day.
  const q = query.trim().toLowerCase();
  const rows = sessions.value
    .filter(
      (s) =>
        !isSubagentSession(s) &&
        !isEmptySession(s) &&
        !dead.has(normPath(s.location?.directory ?? "")),
    )
    .sort((a, b) => b.time.updated - a.time.updated)
    .filter((s) => !filter || normPath(s.location?.directory ?? "") === filter)
    .filter(
      (s) =>
        !q ||
        (s.title || "").toLowerCase().includes(q) ||
        projectDisplayName(
          s.location?.directory ?? "",
        ).toLowerCase().includes(q),
    );
  const groups: { label: string; rows: Session[] }[] = [];
  for (const s of rows) {
    const label = dayLabel(s.time.updated);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.rows.push(s);
    else groups.push({ label, rows: [s] });
  }

  // A page can hold nothing listable (sub-agent and blank sessions never
  // show; a project filter hides the rest), while the project's real
  // sessions sit pages deep. Walk older pages while nothing is visible;
  // the walk stops at the first visible row or an exhausted cursor, and a
  // failed fetch leaves the button below as the manual retry.
  useEffect(() => {
    if (rows.length === 0 && sessionsNext.value) void loadMoreSessions();
  }, [rows.length, sessionsNext.value]);

  return (
    <div class="home">
      {/* Session-scoped errors render in their session; a for-less error
          (project purge) has no session — Home is its only surface, so a
          failed delete never reads as a silent no-op. */}
      {sendError.value !== undefined && sendError.value.for === undefined && (
        <div class="send-error home-error">{sendError.value.text}</div>
      )}
      <div class="home-grid">
        <div class="home-left">
          <h2 class="home-h">Projects</h2>
          {dirList.map((dir) => (
            <ProjectRow
              key={dir}
              dir={dir}
              count={rowsByDir.get(dir)?.length ?? 0}
              disambig={disambig(dir)}
              selected={filter === dir}
              onSelect={() =>
                (homeFilter.value = filter === dir ? undefined : dir)
              }
            />
           ))}
         </div>
        <div class="home-right">
          <div class="search">
            <SearchIcon />
            <input
              placeholder="Search sessions"
              value={query}
              onInput={(e) =>
                (homeQuery.value = (e.target as HTMLInputElement).value)
              }
            />
            {query && (
              <button
                class="search-clear"
                title="Clear"
                aria-label="Clear search"
                onClick={() => (homeQuery.value = "")}
              >
                <CloseIcon />
              </button>
            )}
          </div>
          {!baseLoaded.value ? (
            <div class="empty">Loading sessions…</div>
          ) : groups.length === 0 ? (
            <div class="empty">
              {sessionsNext.value
                ? "Loading older sessions…"
                : q
                  ? `No sessions match “${query.trim()}”.`
                  : filter
                    ? `No sessions in ${projectDisplayName(filter)} yet.`
                    : "No sessions yet. Start one above — it shows up under this folder."}
            </div>
          ) : (
            groups.map((g, i) => (
              <section key={g.label}>
                <div class="day-head">
                  <span class="day-label">{g.label}</span>
                  {i === 0 && (
                    <button class="tb-new" onClick={() => void newSession()}>
                      <NewSessionIcon />
                      New session
                    </button>
                  )}
                </div>
                {g.rows.map((s) => (
                  <SessionRow key={s.id} s={s} />
                ))}
              </section>
            ))
          )}
          {sessionsNext.value && (
            <button class="load-older" onClick={() => void loadMoreSessions()}>
              Load older sessions
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ProjectRow(props: {
  dir: string;
  count: number;
  disambig?: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const isCurrent = currentDir.value === props.dir;
  const [confirming, setConfirming] = useState(false);
  const [editing, setEditing] = useState(false);
  const row = projects.value.find(
    (p) => normPath(p.worktree) === props.dir,
  );
  const name = row?.name || baseName(props.dir);
  const tile = tileFor(props.dir, row?.icon?.color);
  const purge = purgeState.value;
  const commitRename = (title: string) => {
    setEditing(false);
    if (title && title !== name) void renameProject(props.dir, title);
  };

  return (
    <div class={props.selected ? "proj-row selected" : "proj-row"}>
      {editing ? (
        <RenameInput
          class="rename-input"
          title={name}
          onCommit={commitRename}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <>
          <button class="proj-open" title={props.dir} onClick={props.onSelect}>
            <span class="tile" style={{ background: tile.color }}>
              {tile.letter}
            </span>
            <span class="name">
              {name}
              {props.disambig && <span class="name-dim"> · {props.disambig}</span>}
            </span>
            {isCurrent && <span class="proj-here" title="This window" />}
          </button>
          {purge?.dir === props.dir ? (
            <span class="purge-note">
              deleting {purge.done}/{purge.total}…
            </span>
          ) : (
            <span class="row-acts">
              {/* Rename needs a project row to PATCH; session-only dirs
                  (a folder the server never booted in) have none. */}
              {row && (
                <button
                  class="row-act iconic"
                  title="Rename project"
                  onClick={() => setEditing(true)}
                >
                  <PencilIcon />
                </button>
              )}
              <button
                class="row-act iconic"
                title="Delete project"
                onClick={() => setConfirming(true)}
              >
                <TrashIcon />
              </button>
            </span>
          )}
        </>
      )}
      {confirming && (
        <div class="confirm-backdrop" onClick={() => setConfirming(false)}>
          <div class="confirm" role="dialog" onClick={(e) => e.stopPropagation()}>
            <div class="confirm-text">
              Delete project “{name}
              {props.disambig ? ` · ${props.disambig}` : ""}” and its{" "}
              {props.count} session{props.count === 1 ? "" : "s"}? The sessions
              cannot be recovered.
            </div>
            <div class="confirm-actions">
              <button
                class="confirm-danger"
                onClick={() => {
                  setConfirming(false);
                  void purgeProject(props.dir);
                }}
              >
                Delete project
              </button>
              <button onClick={() => setConfirming(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SessionRow(props: { s: Session }) {
  const [editing, setEditing] = useState(false);
  const [armed, arm, disarm] = useArm();
  // Copy feedback: the glyph flips to a green check for a beat (the
  // code-block copy control's pattern, markdown.ts copyButton).
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | undefined>(undefined);
  const copyId = () => {
    void navigator.clipboard.writeText(s.id).catch(() => {});
    setCopied(true);
    clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(false), 1200);
  };
  const s = props.s;
  const dir = normPath(s.location?.directory ?? "");
  const foreign = dir !== currentDir.value;
  const tile = sessionTile(s, s.id);
  const st = sessionStatus.value[s.id];

  // In-app for this window's sessions; a foreign session deep-links its
  // project open instead of loading it here.
  const open = () => {
    if (foreign) {
      postToHost({ type: "open-project", path: dir, session: s.id });
    } else {
      navigate({ view: "session", id: s.id });
    }
  };

  const commitRename = (title: string) => {
    setEditing(false);
    if (title && title !== s.title) void renameSession(s.id, title);
  };

  return (
    <div class="sess-row">
      {editing ? (
        <RenameInput
          class="rename-input"
          title={s.title}
          onCommit={commitRename}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <>
          <button
            class="sess-open"
            onClick={open}
            title={formatSessionTimes(s)}
          >
            <span class="tile" style={{ background: tile.color }}>
              {tile.letter}
            </span>
            <span class="texts">
              <span class="sess-title">{sessionTitle(s, s.id)}</span>
              {/* Filtered to one project, every row is that project — the
                  label is pure noise then. */}
              {!homeFilter.value && (
                <span class="sess-proj">{projectDisplayName(dir)}</span>
              )}
            </span>
            {st?.type === "busy" && <span class="spin" title="Running" />}
          </button>
          <span class="row-acts">
            <button
              class={copied ? "row-act iconic done" : "row-act iconic"}
              // The raw id (ses_…): what peer routing and the API want.
              title="Copy Session ID"
              onClick={copyId}
            >
              {copied ? <CheckIcon /> : <CopyIcon />}
            </button>
            <button
              class="row-act iconic"
              title="Rename"
              onClick={() => {
                disarm();
                setEditing(true);
              }}
            >
              <PencilIcon />
            </button>
            <button
              class={armed ? "row-act iconic armed" : "row-act iconic"}
              title={armed ? undefined : "Delete"}
              onClick={() => {
                if (armed) {
                  disarm();
                  void deleteSession(s.id);
                } else {
                  arm();
                }
              }}
            >
              <TrashIcon />
            </button>
          </span>
        </>
      )}
    </div>
  );
}
