import { signal } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import type { Session } from "../api";
import { postToHost } from "../host";
import { RenameInput } from "../components/RenameInput";
import { Swatches } from "../components/Swatches";
import {
  CheckIcon,
  ChevronIcon,
  CloseIcon,
  CopyIcon,
  DropletIcon,
  ForkIcon,
  NewSessionIcon,
  PencilIcon,
  SearchIcon,
  TrashIcon,
} from "../icons";
import {
  baseLoaded,
  sessionsStalled,
  currentDir,
  deleteSession,
  formatSessionTimes,
  forkSession,
  homeFilter,
  homeQuery,
  homeVisibleSessions,
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
  searchAllSessions,
  sessionTile,
  sessionTitle,
  sessionsSearching,
  sendError,
  sessions,
  sessionsNext,
  sessionsLoadingMore,
  sessionStatus,
  setProjectColor,
  setSendError,
  tombstones,
} from "../store";
import { baseName, parentName, tileFor } from "../tile";
import { useArm } from "../useArm";

// --- Navigator multiselect: pick many rows, delete many at once ---
// Ctrl+Click (or ⌘) toggles one row; Shift+Click works the span from
// the anchor row, its direction read off the anchor's own state: a
// picked anchor adds the span (adjacent blocks merge into one), an
// unpicked anchor removes it — one rule gives select-many and
// unselect-many, and repeating a click never flips anything. Plain
// clicks keep the row's own action (open the session / filter the
// project) and a click landing on no row drops the picks. Picks are
// exclusive: sessions or projects, never both. Module-level signals: a
// reload of this sidebar view keeps the picks.
const pickedSessions = signal<Set<string>>(new Set());
const pickedDirs = signal<Set<string>>(new Set());
let anchorSession: string | undefined;
let anchorDir: string | undefined;

// Section collapse state and the Projects section's search — module-level
// like the picks: leaving the view and coming back keeps them. Not
// persisted; a reload starts both open.
const projectsOpen = signal(true);
const sessionsOpen = signal(true);
const projQuery = signal("");
// The Projects/Sessions split: a fraction of the column's height — 50/50
// by default, remembered in localStorage so a reload keeps the user's
// proportion. A fixed height (flex: none, derived from the fraction)
// also pins the border: content changes in either section can't move it.
const SPLIT_KEY = "opencode-nav-split";
const splitFrac = signal<number>((() => {
  const v = Number(localStorage.getItem(SPLIT_KEY));
  return Number.isFinite(v) && v > 0 && v < 1 ? v : 0.5;
})());
// The column's measured height; 0 until the ResizeObserver's first tick.
const homeH = signal(0);
const splitPx = (): number => {
  const h = homeH.value;
  return Math.min(
    Math.max(Math.round(splitFrac.value * h), 40),
    Math.max(60, h - 160),
  );
};
// Live drag state; held here because pointer capture keeps the events on
// the divider, and Preact handlers close over the module scope.
let splitDrag:
  | { startY: number; startH: number; maxH: number; baseH: number }
  | undefined;
const isPickClick = (e: MouseEvent) =>
  e.ctrlKey || e.metaKey || e.shiftKey;

function pickToggle(
  order: readonly string[],
  picked: ReadonlySet<string>,
  anchor: string | undefined,
  id: string,
  range: boolean,
): { picked: Set<string>; anchor: string | undefined } {
  const next = new Set(picked);
  const to = order.indexOf(id);
  if (to < 0) return { picked: next, anchor };
  if (!range) {
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return { picked: next, anchor: id };
  }
  if (anchor === undefined || order.indexOf(anchor) < 0) {
    next.add(id);
    return { picked: next, anchor: id };
  }
  const from = order.indexOf(anchor);
  const add = next.has(anchor);
  for (let i = Math.min(from, to); i <= Math.max(from, to); i++) {
    const x = order[i];
    if (add) next.add(x);
    else next.delete(x);
  }
  return { picked: next, anchor };
}

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

// The sidebar's session browser, two collapsible sections stacked like
// Source Control's: Projects (the picker, bounded to its own scroll)
// above Sessions (every project's sessions, day-grouped, filling the
// rest). Clicking a project narrows Sessions to it (click again for
// all); this window's sessions open in their own editor tab via the
// host, and a foreign session opens its project's folder in a new VS
// Code window, deep-linking the session — never in-app.
export function Navigator() {
  // The filters live in the store (homeQuery/homeFilter), so they survive
  // leaving the view — project selection and search are still set when
  // the sidebar comes back.
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

  // Projects: every directory that has sessions or a known project row.
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

  // The Projects section's own search: a client filter over name, parent
  // folder, and path — the list is small, and the server has no project
  // search route.
  const pq = projQuery.value.trim().toLowerCase();
  const shownDirs = pq
    ? dirList.filter((d) => {
        const row = projects.value.find((p) => normPath(p.worktree) === d);
        return `${row?.name || baseName(d)} ${parentName(d)} ${d}`
          .toLowerCase()
          .includes(pq);
      })
    : dirList;

  // Sessions: live-filtered by title or project name, grouped by day.
  // The filter lives in the store (homeVisibleSessions): loadMoreSessions
  // pages until that list grows, so render and stop rule share one
  // definition.
  const q = query.trim().toLowerCase();
  const rows = homeVisibleSessions().sort(
    (a, b) => b.time.updated - a.time.updated,
  );
  const groups: { label: string; rows: Session[] }[] = [];
  for (const s of rows) {
    const label = dayLabel(s.time.updated);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.rows.push(s);
    else groups.push({ label, rows: [s] });
  }

  // Picks among the rows still listed — a pick whose row left the list
  // (deleted elsewhere, or filtered away by the search) reads as gone,
  // and every toggle rebuilds from this view so ghosts never resurrect.
  const rowIds = rows.map((s) => s.id);
  const rowIdSet = new Set(rowIds);
  const pickedSess = new Set(
    [...pickedSessions.value].filter((id) => rowIdSet.has(id)),
  );
  // Projects use the shown (search-filtered) rows for the same reason.
  const dirSet = new Set(shownDirs);
  const pickedProj = new Set(
    [...pickedDirs.value].filter((d) => dirSet.has(d)),
  );

  const [confirming, setConfirming] = useState<
    "sessions" | "projects" | undefined
  >(undefined);
  const [bulk, setBulk] = useState<
    { done: number; total: number } | undefined
  >(undefined);

  const pickSession = (id: string, e: MouseEvent) => {
    const r = pickToggle(rowIds, pickedSess, anchorSession, id, e.shiftKey);
    pickedSessions.value = r.picked;
    anchorSession = r.anchor;
    // Sessions or projects, never both: starting one drops the other.
    if (r.picked.size > 0) {
      pickedDirs.value = new Set();
      anchorDir = undefined;
    }
  };
  const pickProject = (dir: string, e: MouseEvent) => {
    const r = pickToggle(shownDirs, pickedProj, anchorDir, dir, e.shiftKey);
    pickedDirs.value = r.picked;
    anchorDir = r.anchor;
    if (r.picked.size > 0) {
      pickedSessions.value = new Set();
      anchorSession = undefined;
    }
  };
  const clearPicks = () => {
    pickedSessions.value = new Set();
    pickedDirs.value = new Set();
    anchorSession = anchorDir = undefined;
  };
  const deletePickedSessions = async () => {
    const ids = [...pickedSess];
    setConfirming(undefined);
    pickedSessions.value = new Set();
    anchorSession = undefined;
    setBulk({ done: 0, total: ids.length });
    let done = 0;
    for (const id of ids) if (await deleteSession(id)) done += 1;
    setBulk(undefined);
    if (done < ids.length)
      setSendError(
        `Deleted ${done} of ${ids.length} sessions — the rest were rejected by the server.`,
      );
  };
  const deletePickedProjects = async () => {
    const dirs = [...pickedProj];
    setConfirming(undefined);
    pickedDirs.value = new Set();
    anchorDir = undefined;
    // Sequential like the single purge: each row walks its own d/t note.
    for (const d of dirs) await purgeProject(d);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setConfirming(undefined);
      if (pickedSessions.value.size > 0 || pickedDirs.value.size > 0)
        clearPicks();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // A page can hold nothing listable (sub-agent and blank sessions never
  // show; a project filter hides the rest), while the project's real
  // sessions sit pages deep. Walk older pages while nothing is visible —
  // one loadMoreSessions call now walks to the first visible row or an
  // exhausted cursor, and a failed fetch leaves the button below as the
  // manual retry. The gate
  // is computed in the render and passed as the dep — rows.length read
  // live inside the effect raced the boot, where the mount render's
  // stale closure (0 rows) met the first page's fresh cursor and pulled
  // page 2 eagerly. An active query never walks: the server-side search
  // below has already answered for the whole history, and paging every
  // unloaded row to conclude "no match" is all cost.
  const walkOlder = rows.length === 0 && sessionsNext.value !== undefined && !q;
  useEffect(() => {
    if (walkOlder) void loadMoreSessions();
  }, [walkOlder]);

  // Auto-load: a sentinel at the list's end fires the next page as it
  // scrolls into view (clipped rows don't intersect the viewport, so only
  // the real end triggers). The gate reads live signals, so a double-fire
  // rides loadMoreSessions' own loading guard. The button stays as the
  // failed-fetch retry: an observer never re-fires without an
  // intersection change, and a failed fetch leaves the sentinel exactly
  // where it was.
  const sentinelEl = useRef<HTMLDivElement>(null);
  const sessionsOpenNow = sessionsOpen.value;
  useEffect(() => {
    const el = sentinelEl.current;
    if (!el) return;
    // One intersection pages while the sentinel stays in view: rows land
    // below and scroll anchoring pins the view to the end, so the observer
    // often never sees another crossing. Continuing is gated on growth -
    // a failed fetch stops the pump (no growth) and the button retries.
    const pump = async (): Promise<void> => {
      if (sessionsNext.value === undefined || sessionsLoadingMore.value)
        return;
      const r = el.getBoundingClientRect();
      if (r.bottom <= 0 || r.top >= innerHeight) return;
      const before = homeVisibleSessions().length;
      await loadMoreSessions();
      if (homeVisibleSessions().length > before) await pump();
    };
    const obs = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) void pump();
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, [sessionsOpenNow]);

  // Server-side search: typing hands the query to the server, which
  // matches titles across the whole history — the loaded pool alone
  // can't see past the newest pages. Debounced: one request per pause
  // in typing, not one per keystroke.
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) return;
    const t = window.setTimeout(
      () => void searchAllSessions(trimmed),
      250,
    );
    return () => clearTimeout(t);
  }, [query]);

  const homeEl = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = homeEl.current;
    if (!el) return;
    homeH.value = el.clientHeight;
    const ro = new ResizeObserver(() => (homeH.value = el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={homeEl} class="home"
      onClick={(e) => {
        // A click landing on no row, dock, or dialog drops the picks —
        // except the list's own controls (Load older sessions), which
        // grow the list the picks live in.
        if (
          !(e.target as Element).closest(
            ".sess-row, .proj-row, .pick-dock, .confirm-backdrop, .load-older, .nav-split",
          )
        )
          clearPicks();
      }}
    >
      {/* Session-scoped errors render in their session panel; a for-less
          error (project purge) has no session — the navigator is its
          only surface, so a failed delete never reads as a silent no-op. */}
      {sendError.value !== undefined && sendError.value.for === undefined && (
        <div class="send-error home-error">{sendError.value.text}</div>
      )}
      <section
        class="nav-sec proj-sec"
        style={
          projectsOpen.value && homeH.value > 0
            ? { height: `${splitPx()}px`, flex: "none" }
            : undefined
        }
      >
        <div class="sec-head">
          <button
            class={projectsOpen.value ? "sec-toggle" : "sec-toggle closed"}
            title={projectsOpen.value ? "Collapse Projects" : "Expand Projects"}
            onClick={() => (projectsOpen.value = !projectsOpen.value)}
          >
            <span class="chev">
              <ChevronIcon />
            </span>
            <span class="sec-title">Projects</span>
          </button>
        </div>
        {projectsOpen.value && (
          <div class="sec-body proj-body">
            <div class="search">
              <SearchIcon />
              <input
                placeholder="Search projects"
                value={projQuery.value}
                onInput={(e) =>
                  (projQuery.value = (e.target as HTMLInputElement).value)
                }
              />
              {projQuery.value && (
                <button
                  class="search-clear"
                  title="Clear"
                  aria-label="Clear search"
                  onClick={() => (projQuery.value = "")}
                >
                  <CloseIcon />
                </button>
              )}
            </div>
            {shownDirs.map((dir) => (
              <ProjectRow
                key={dir}
                dir={dir}
                count={rowsByDir.get(dir)?.length ?? 0}
                disambig={disambig(dir)}
                selected={filter === dir}
                picked={pickedProj.has(dir)}
                onPick={(e) => pickProject(dir, e)}
                onSelect={() =>
                  (homeFilter.value = filter === dir ? undefined : dir)
                }
              />
            ))}
            {shownDirs.length === 0 && (
              <div class="empty">
                {pq
                  ? `No projects match “${projQuery.value.trim()}”.`
                  : "No projects yet."}
              </div>
            )}
          </div>
        )}
      </section>
      {projectsOpen.value && (
        <div
          class="nav-split"
          role="separator"
          aria-orientation="horizontal"
          title="Drag to resize"
          onPointerDown={(e) => {
            const div = e.currentTarget as HTMLElement;
            const home = div.closest(".home");
            const proj = div.previousElementSibling as HTMLElement | null;
            if (!home || !proj) return;
            splitDrag = {
              startY: e.clientY,
              startH: splitPx(),
              // Keep a usable Sessions section below: header, search, a
              // few rows.
              maxH: Math.max(60, homeH.value - 160),
              baseH: Math.max(1, homeH.value),
            };
            div.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (!splitDrag) return;
            // The border follows the pointer: dragging up moves the split
            // up, shrinking Projects and growing Sessions. The fraction is
            // what's kept, so a later resize keeps the proportion.
            const h = Math.min(
              splitDrag.maxH,
              Math.max(40, splitDrag.startH + (e.clientY - splitDrag.startY)),
            );
            splitFrac.value = h / splitDrag.baseH;
          }}
          onPointerUp={() => {
            if (splitDrag)
              localStorage.setItem(SPLIT_KEY, String(splitFrac.value));
            splitDrag = undefined;
          }}
          onPointerCancel={() => (splitDrag = undefined)}
        />
      )}
      <section class="nav-sec sess-sec">
        <div class="sec-head">
          <button
            class={sessionsOpen.value ? "sec-toggle" : "sec-toggle closed"}
            title={sessionsOpen.value ? "Collapse Sessions" : "Expand Sessions"}
            onClick={() => (sessionsOpen.value = !sessionsOpen.value)}
          >
            <span class="chev">
              <ChevronIcon />
            </span>
            <span class="sec-title">Sessions</span>
          </button>
          <button
            class="tb-new nav-new"
            title="New session"
            aria-label="New session"
            onClick={() => void newSession()}
          >
            <NewSessionIcon />
          </button>
        </div>
        {sessionsOpen.value && (
          <div class="sec-body sess-body">
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
            {!baseLoaded.value || sessionsStalled.value ? (
              <div class="empty">Loading sessions…</div>
            ) : groups.length === 0 ? (
              <div class="empty">
                {sessionsSearching.value
                  ? "Searching…"
                  : sessionsNext.value && !q
                    ? "Loading older sessions…"
                    : q
                      ? `No sessions match “${query.trim()}”.`
                      : filter
                        ? `No sessions in ${projectDisplayName(filter)} yet.`
                        : "No sessions yet. Start one above — it shows up under this folder."}
              </div>
            ) : (
              groups.map((g) => (
                <section key={g.label}>
                  <div class="day-head">
                    <span class="day-label">{g.label}</span>
                  </div>
                  {g.rows.map((s) => (
                    <SessionRow
                      key={s.id}
                      s={s}
                      picked={pickedSess.has(s.id)}
                      onPick={(e) => pickSession(s.id, e)}
                    />
                  ))}
                </section>
              ))
            )}
            {sessionsNext.value && (
              <button
                class="load-older"
                disabled={sessionsLoadingMore.value}
                onClick={() => void loadMoreSessions()}
              >
                {sessionsLoadingMore.value
                  ? "Loading older sessions…"
                  : "Load older sessions"}
              </button>
            )}
            <div class="load-sentinel" ref={sentinelEl} />
          </div>
        )}
      </section>
      {(pickedSess.size > 0 || pickedProj.size > 0 || bulk !== undefined) && (
        <div class="pick-dock">
          {bulk ? (
            <span class="pick-note">
              Deleting {bulk.done} of {bulk.total}…
            </span>
          ) : (
            <button
              class="pick-delete"
              onClick={() =>
                setConfirming(pickedProj.size > 0 ? "projects" : "sessions")
              }
            >
              <TrashIcon />
              Delete{" "}
              {pickedProj.size > 0
                ? `${pickedProj.size} project${pickedProj.size === 1 ? "" : "s"}`
                : `${pickedSess.size} session${pickedSess.size === 1 ? "" : "s"}`}
            </button>
          )}
        </div>
      )}
      {confirming !== undefined && (
        <div class="confirm-backdrop" onClick={() => setConfirming(undefined)}>
          <div class="confirm" role="dialog" onClick={(e) => e.stopPropagation()}>
            <div class="confirm-text">
              {confirming === "sessions"
                ? `Delete ${pickedSess.size} session${pickedSess.size === 1 ? "" : "s"}? They cannot be recovered.`
                : `Delete ${pickedProj.size} project${pickedProj.size === 1 ? "" : "s"} and all their sessions? The sessions cannot be recovered.`}
            </div>
            <div class="confirm-actions">
              <button
                class="confirm-danger"
                onClick={() =>
                  void (confirming === "sessions"
                    ? deletePickedSessions()
                    : deletePickedProjects())
                }
              >
                Delete
              </button>
              <button onClick={() => setConfirming(undefined)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ProjectRow(props: {
  dir: string;
  count: number;
  disambig?: string;
  selected: boolean;
  picked?: boolean;
  onPick?: (e: MouseEvent) => void;
  onSelect: () => void;
}) {
  const isCurrent = currentDir.value === props.dir;
  const [confirming, setConfirming] = useState(false);
  const [editing, setEditing] = useState(false);
  const [coloring, setColoring] = useState(false);
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
  const commitColor = (color: string) => {
    setColoring(false);
    if (color !== row?.icon?.color) void setProjectColor(props.dir, color);
  };

  return (
    <div
      class={[
        "proj-row",
        props.selected && "selected",
        props.picked && "picked",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {editing ? (
        <RenameInput
          class="rename-input"
          title={name}
          onCommit={commitRename}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <>
          <button
            class="proj-open"
            title={props.dir}
            // Shift+Click extends the browser's text selection on
            // mousedown — click's preventDefault is too late for it.
            onMouseDown={(e) => {
              if (isPickClick(e)) e.preventDefault();
            }}
            onClick={(e) => {
              // A modified click picks instead of filtering.
              if (isPickClick(e)) {
                e.preventDefault();
                props.onPick?.(e);
                return;
              }
              props.onSelect();
            }}
          >
            <span class="tile" style={{ background: tile.color }}>
              {props.picked ? <CheckIcon /> : tile.letter}
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
          ) : coloring ? (
            <>
              {/* Click-away abandons the recolor (no PATCH until a pick);
                  the strip rides above the fixed backdrop. */}
              <div class="backdrop" onClick={() => setColoring(false)} />
              <span class="row-coloring">
                <Swatches value={row?.icon?.color} onPick={commitColor} />
              </span>
            </>
          ) : (
            <span class="row-acts">
              {/* Rename and recolor need a project row to PATCH;
                  session-only dirs (a folder the server never booted in)
                  have none. */}
              {row && (
                <>
                  <button
                    class="row-act iconic"
                    title="Rename project"
                    onClick={() => {
                      setColoring(false);
                      setEditing(true);
                    }}
                  >
                    <PencilIcon />
                  </button>
                  <button
                    class="row-act iconic"
                    title="Project color"
                    onClick={() => {
                      setEditing(false);
                      setColoring(true);
                    }}
                  >
                    <DropletIcon />
                  </button>
                </>
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

function SessionRow(props: {
  s: Session;
  picked?: boolean;
  onPick?: (e: MouseEvent) => void;
}) {
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

  // This window's sessions open in their own editor tab (the host
  // reveals or creates it); a foreign session deep-links its project
  // open in a new window instead.
  const open = () => {
    if (foreign) {
      postToHost({ type: "open-project", path: dir, session: s.id });
    } else {
      postToHost({ type: "open-session", id: s.id });
    }
  };

  const commitRename = (title: string) => {
    setEditing(false);
    if (title && title !== s.title) void renameSession(s.id, title);
  };

  return (
    <div class={props.picked ? "sess-row picked" : "sess-row"}>
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
            // Shift+Click extends the browser's text selection on
            // mousedown — click's preventDefault is too late for it.
            onMouseDown={(e) => {
              if (isPickClick(e)) e.preventDefault();
            }}
            onClick={(e) => {
              // A modified click picks instead of opening.
              if (isPickClick(e)) {
                e.preventDefault();
                props.onPick?.(e);
                return;
              }
              open();
            }}
            title={formatSessionTimes(s)}
          >
            <span class="tile" style={{ background: tile.color }}>
              {props.picked ? <CheckIcon /> : tile.letter}
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
              title="Fork session"
              onClick={() =>
                void forkSession(s.id).then((row) => {
                  if (!row) return;
                  // The row's own convention: another project's session
                  // opens in its window, deep-linked — so does its fork.
                  if (foreign)
                    postToHost({
                      type: "open-project",
                      path: dir,
                      session: row.id,
                    });
                  else postToHost({ type: "open-session", id: row.id });
                })
              }
            >
              <ForkIcon />
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
