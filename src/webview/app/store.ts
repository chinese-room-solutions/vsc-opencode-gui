import { computed, effect, signal } from "@preact/signals";
import type { ReadonlySignal } from "@preact/signals";
import {
  attachmentParts,
  attachMime,
  createSession,
  compactSession,
  deleteSession as deleteSessionApi,
  fetchAgents,
  fetchCommands,
  fetchConfig,
  fetchCurrentProject,
  fetchLegacyMessages,
  fetchMessages,
  fetchPendingPermissions,
  fetchSessionPermissions,
  fetchProjectSessions,
  fetchProviders,
  fetchSessionQuestions,
  fetchSession,
  fetchSessions,
  fetchSessionStatus,
  fetchProjects,
  findFiles,
  interruptSession,
  normalizePermission,
  normalizeSession,
  promptSession,
  rejectQuestion,
  renameProject as renameProjectApi,
  renameSession as renameSessionApi,
  revertSession as revertSessionApi,
  replyPermission,
  replyPermissionV1,
  replyQuestion,
  runCommand,
  switchSessionAgent,
  switchSessionModel,
  type Agent,
  type Command,
  type Message,
  type MessageTokens,
  type MessageWithParts,
  type ModelSelection,
  type Part,
  type PermissionRequest,
  type Project,
  type Providers,
  type QuestionRequest,
  type Session,
  type SessionStatus,
  type ToolPart,
  isText,
  isTool,
  clampPartText,
  clampToolOutput,
  PART_TEXT_CAP,
  forgetTruncatedParts,
  isTruncatedPart,
  stringifyError,
  tokensTotal,
} from "./api";
import { connectEvents, type ServerEvent } from "./events";
import { postToHost } from "./host";
import { parseMentions } from "./mentions";
import { setCopyModifier } from "./markdown";
import {
  activeTab,
  closeTab,
  navigate,
  openTabs,
  route,
  unreadTabs,
} from "./router";
import {
  playPermissionSound,
  playQuestionSound,
  playReadySound,
  setPermissionSound,
  setQuestionSound,
  setReadySound,
} from "./sound";
import { tileFor, baseName } from "./tile";

export type Status =
  | { kind: "loading" }
  | { kind: "error"; message: string; showInstallHint: boolean }
  | { kind: "ready"; origin: string };

// Meta contents baked into chat.html by AppHost.
const meta = (name: string) =>
  document.querySelector(`meta[name="${name}"]`)?.getAttribute("content") ?? "";

// Boot state is baked into chat.html as <meta> tags by AppHost — a host
// postMessage right after render can race the first load, so the initial
// status never relies on one.
function bootStatus(): Status {
  const error = meta("opencode-error");
  if (error) {
    return {
      kind: "error",
      message: error,
      showInstallHint: meta("opencode-install-hint") === "1",
    };
  }
  const origin = meta("opencode-origin");
  if (origin) return { kind: "ready", origin };
  return { kind: "loading" };
}

export const status = signal<Status>(bootStatus());

// Path normalization matching the host's (ServerManager `normWorktree`):
// fold separators (session rows arrive backslash-form, project rows
// forward-slash), the Windows drive letter's case, and trailing
// separators. Every directory compare (current project, tombstones,
// grouping, tile colors) goes through this — a mismatch falls back to
// hash colors that drift on rename.
export function normPath(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/^([a-z]):\//i, (m) => m.toUpperCase())
    .replace(/\/+$/, "");
}

// Known session rows, newest-updated first.
export const sessions = signal<Session[]>([]);
// Cursor to the next (older) page of sessions, when more exist.
export const sessionsNext = signal<string | undefined>(undefined);
export const sessionStatus = signal<Record<string, SessionStatus>>({});
// Prompts the user interrupted before any step answered them: the awaiting
// placeholder ("Processing...") must not resurrect a prompt the user killed.
export const interruptedPrompts = signal<Set<string>>(new Set());
// Prompts whose turn the user stopped outright (Esc / the stop button): the
// transcript marks that turn "Interrupted". Distinct from the reject paths
// that also retire a turn — a failed permission ask narrates itself through
// its tool part. Client-side like the set above: a reload shows the bare
// pill again.
export const stoppedPrompts = signal<Set<string>>(new Set());
// Turns fired onto a running session, held client-side in publish order
// and run one at a time as the session idles. Both kinds queue together so
// application order == publish order — the server queues prompts but not
// commands, and its queue applies entries even after an abort (observed:
// a stop fired what was queued behind the turn). Client-side only: a
// reload drops them.
export type QueuedTurn = {
  id: string;
  kind: "prompt" | "command";
  text: string;
  files?: ComposerFile[];
};
export const queuedTurns = signal<QueuedTurn[]>([]);

function dropQueued(id: string): void {
  if (queuedTurns.value.some((q) => q.id === id))
    queuedTurns.value = queuedTurns.value.filter((q) => q.id !== id);
}

export function hasQueued(id: string): boolean {
  return queuedTurns.value.some((q) => q.id === id);
}

// A stopped session's server queue can still hold a steered prompt: the
// server runs it as a fresh turn right after the abort (observed). For a
// short window after a stop, a user row this client never submitted is
// that ghost — the message.updated handler stops the turn it started.
// postedRows counts POSTs whose user row hasn't landed yet: an echo-less
// row with a POST outstanding is ours (a fast double-submit after a
// submit whose clearPending wiped both echoes), not a ghost. It also
// spares a steered POST's echo the boundary turn's idle — the row lands
// with the next turn.
const ghostWatch = new Map<string, number>();
const GHOST_WATCH_MS = 10_000;
const postedRows = new Map<string, number>();

function armGhostWatch(id: string): void {
  const prev = ghostWatch.get(id);
  if (prev !== undefined) clearTimeout(prev);
  ghostWatch.set(
    id,
    window.setTimeout(() => ghostWatch.delete(id), GHOST_WATCH_MS),
  );
}

function disarmGhostWatch(id: string): void {
  const t = ghostWatch.get(id);
  if (t !== undefined) {
    clearTimeout(t);
    ghostWatch.delete(id);
  }
}

export function queueCommand(target: string, text: string): void {
  const line = text.trim();
  const name = /^\/(\S+)/.exec(line)?.[1];
  if (name !== "compact" && !commands.value.some((c) => c.name === name)) {
    setSendError(`Unknown command /${name}.`);
    return;
  }
  queuedTurns.value = [
    ...queuedTurns.value,
    { id: target, kind: "command", text: line },
  ];
  appendCommandEcho(target, line);
}
export const providers = signal<Providers | undefined>(undefined);
export const agents = signal<Agent[]>([]);
export const commands = signal<Command[]>([]);
export const pendingPermissions = signal<PermissionRequest[]>([]);
export const pendingQuestions = signal<QuestionRequest[]>([]);

// Home: known projects (avatar colors), this window's folder, and the
// tombstoned (deleted) project folders — baked in by AppHost from
// globalState, mutated locally on tombstone (the host persists).
export const projects = signal<Project[]>([]);
export const currentDir = signal<string | undefined>(undefined);
export const tombstones = signal<string[]>(
  readStringList("opencode-tombstones").map(normPath),
);
// False until the first base refresh resolved — Home shows a loading line
// instead of a wrong "no sessions" empty state.
export const baseLoaded = signal(false);
// Progress of a running project purge (Home renders it in place).
export const purgeState = signal<
  | { dir: string; done: number; total: number }
  | undefined
>(undefined);
// Home's working filters — the selected project and the search box. Signals,
// not component state: resetting on every remount (Home → session tab → back)
// threw the selection away, so it could not serve as a working context.
export const homeQuery = signal("");
export const homeFilter = signal<string | undefined>(undefined);

// Model rows the composer's picker hides ("providerID/modelID"). Baked in
// by AppHost (globalState host-side); the Manage Models QuickPick pushes
// changes live as "hidden-models" messages.
export const hiddenModels = signal<string[]>(
  readStringList("opencode-hidden-models"),
);

// Live peer registry (opencode-plugin-peers): endpoint id → display name
// and current session title. The host polls the plugin's registry and
// pushes "peers" messages; peer-card headers resolve senders through it.
export const peerNames = signal<Record<string, { name: string; title: string }>>(
  {},
);

// A baked-in meta's JSON string array ([] when absent or malformed).
function readStringList(name: string): string[] {
  const raw =
    document.querySelector(`meta[name="${name}"]`)?.getAttribute("content") ??
    "[]";
  try {
    const list: unknown = JSON.parse(raw);
    return Array.isArray(list)
      ? list.filter((p): p is string => typeof p === "string")
      : [];
  } catch {
    return [];
  }
}

// Picker selection held for the draft; applied to the session at creation.
export const draftAgent = signal<string | undefined>(undefined);
export const draftModel = signal<ModelSelection | undefined>(undefined);
// The server config's default model — what a draft with no explicit pick
// runs on (display only, so the chip never shows a bare "Model").
export const serverDefaultModel = signal<ModelSelection | undefined>(
  undefined,
);

// Chat transcript per session, oldest first. "pending:" message ids are
// optimistic appends awaiting their server echo.
export type ChatMessage = MessageWithParts;
export const messagesBySession = signal<Map<string, ChatMessage[]>>(new Map());

// Per-session view of the transcript store. Reading
// messagesBySession.value.get(sid) in a component subscribes it to every
// session's mutations — events from background turns re-rendered the open
// transcript at their combined rate, and parallel compactions (deltas at
// token rate into the largest transcripts there are) starved the shared
// renderer until the window hung. The computed's value only changes when
// this session's own list is replaced (mutateMessages swaps just the
// touched session's entry), so each reader hears only its session.
const listViews = new Map<string, ReadonlySignal<ChatMessage[] | undefined>>();
export function messagesFor(
  sid: string,
): ReadonlySignal<ChatMessage[] | undefined> {
  let view = listViews.get(sid);
  if (!view) {
    view = computed(() => messagesBySession.value.get(sid));
    listViews.set(sid, view);
  }
  return view;
}
// A command or turn failure, shown in the transcript flow of the session it
// belongs to — the one that was open when it fired (a turn's session.error
// carries its own id, so it lands right even if another tab is front).
// Keyed: nothing leaks into another session's transcript. Cleared on the
// next attempt in the same session.
export const sendError = signal<{ for?: string; text: string } | undefined>(
  undefined,
);
export function setSendError(
  text: string | undefined,
  forSession?: string,
): void {
  sendError.value =
    text === undefined
      ? undefined
      : {
          for:
            forSession ??
            (route.value.view === "session" ? route.value.id : undefined),
          text,
        };
}

// Context/cost ring. stepUsage holds the freshest streaming step's usage
// (session.next.step.ended carries the step's own numbers; the session row
// keeps their running sum).
export const stepUsage = signal<
  Record<string, { timestamp: number; tokens: MessageTokens }>
>({});

// Chars-per-token learned from boundary feedback: whenever a step's usage
// lands, the chars streamed since the previous boundary measure the
// endpoint's true ratio (GLM measures ~4.3-4.7, not the 5 the tail
// estimate assumed — a fixed 5 reads the live rate ~13% low). Lifetime
// sums: no tuning, and a single row already lands within a few percent.
let calibChars = 0;
let calibTokens = 0;
function calibrateTokens(chars: number, tokens: number): void {
  if (chars > 0 && tokens > 0) {
    calibChars += chars;
    calibTokens += tokens;
  }
}
export function charsPerToken(): number {
  return calibTokens > 0 ? calibChars / calibTokens : 5;
}

// Compact duration for the live counters: 95 → "1m35s", 104552 → "1d5h2m32s".
export function fmtDur(secs: number): string {
  if (secs < 60) return `${secs}s`;
  let out = "";
  for (const [div, unit] of [[86400, "d"], [3600, "h"], [60, "m"], [1, "s"]] as const) {
    const v = Math.floor(secs / div);
    if (v) {
      out += `${v}${unit}`;
      secs %= div;
    }
  }
  return out;
}

// The one popover/menu currently open — composer pickers, the session head's
// "…" menu, and the ring's context panel ("ctx"). Mutually exclusive:
// opening one dismisses the others instead of stacking panels. The panel is
// also toggled from the host command.
export type Popover = "model" | "variant" | "agent" | "headmenu" | "ctx";
export const popover = signal<Popover | undefined>(undefined);

export function setPopover(p: Popover | undefined): void {
  popover.value = p;
}

// The model's context-window size (ring fill denominator), looked up from
// the providers list by the ids on the assistant message that ran. Falls
// back to 200k when the providers list doesn't know the model.
export function contextLimit(model?: {
  providerID?: string;
  modelID?: string;
}): number {
  if (model?.providerID && model?.modelID) {
    const limit = providers.value?.all.find(
      (x) => x.id === model.providerID,
    )?.models[model.modelID]?.limit?.context;
    if (limit && limit > 0) return limit;
  }
  return 200_000;
}

// Catalog lookups for display. `modelLabel` is the models.dev name
// ("GLM-5.3-Flash"), falling back to the bare id with any vendor prefix
// stripped; `modelVariants` lists the reasoning-effort keys a model offers.
function catalogModel(providerID?: string, modelID?: string) {
  return providerID && modelID
    ? providers.value?.all.find((p) => p.id === providerID)?.models[modelID]
    : undefined;
}

export function modelLabel(model?: ModelSelection): string {
  if (!model?.id) return "";
  return (
    catalogModel(model.providerID, model.id)?.name ??
    model.id.split("/").pop() ??
    model.id
  );
}

export function modelVariants(model?: ModelSelection): string[] {
  const variants = catalogModel(model?.providerID, model?.id)?.variants;
  return variants ? Object.keys(variants) : [];
}

// What a chip should display. The same model id can be served under two
// provider ids (e.g. the config default "zhipuai/glm-5.3" vs the connected
// "zai-coding-plan" the picker lists it under), and hashing the raw id for
// the tile color made the chip change color on the first pick. Display the
// provider the picker would list the model under — the first connected
// provider whose catalog offers the id, which is also the group order the
// picker builds; sends keep the literal ids.
export function displayModel(
  model?: ModelSelection,
): ModelSelection | undefined {
  if (!model) return undefined;
  const pid = providers.value?.connected.find(
    (c) => providers.value?.all.find((p) => p.id === c)?.models[model.id],
  );
  return pid ? { providerID: pid, id: model.id } : model;
}

// Zero input+output cost in the catalog = a free-tier model; the model
// popover badges those. Absent cost data simply reads as "not free".
export function modelFree(model?: ModelSelection): boolean {
  const m = catalogModel(model?.providerID, model?.id) as unknown as
    | { cost?: { input?: number; output?: number } }
    | undefined;
  return m?.cost?.input === 0 && m?.cost?.output === 0;
}

// /provider marks every catalog provider whose env var exists as
// "connected" — one ZHIPU_API_KEY lights up four z.ai-family storefronts the
// user never configured. The picker (and the host's Manage Models) list only
// providers the config names: provider blocks plus the default model's
// provider. Nothing named (no config) keeps every connected provider.
function curateProviders(
  list: Providers | undefined,
  config: { model?: string; provider?: Record<string, unknown> } | undefined,
): Providers | undefined {
  if (!list) return undefined;
  const named = new Set(Object.keys(config?.provider ?? {}));
  const def = config?.model?.split("/")[0];
  if (def) named.add(def);
  if (named.size === 0) return list;
  return { ...list, connected: list.connected.filter((c) => named.has(c)) };
}

// Monotonic token so a stale refresh (slow response racing a
// server.connected-triggered one) can't clobber fresher data.
let generation = 0;

async function refreshBase(): Promise<void> {
  const gen = ++generation;
  const [statuses, page, providerList, agentList, commandList, projectList, current, config] =
    await Promise.all([
      fetchSessionStatus(),
      fetchSessions(),
      fetchProviders(),
      fetchAgents(),
      fetchCommands(),
      fetchProjects(),
      fetchCurrentProject(),
      fetchConfig(),
    ]);
  if (gen !== generation) return;
  if (statuses) sessionStatus.value = statuses;
  if (page) {
    // Merge, not replace: the fetch is a snapshot that can predate a
    // session created while it was in flight (a "+" clicked during boot) —
    // replacing would drop that row from under its open tab. Fetched rows
    // win for ids both sides have; locally known rows the snapshot missed
    // (a fresh create, older pages loadMoreSessions appended) stay.
    const fetched = new Set(page.sessions.map((s) => s.id));
    sessions.value = [
      ...page.sessions,
      ...sessions.value.filter((s) => !fetched.has(s.id)),
    ].sort((a, b) => b.time.updated - a.time.updated);
    for (const s of page.sessions) guardVariant(s.id, s.model);
    sessionsNext.value = page.next;
  }
  if (providerList) providers.value = curateProviders(providerList, config);
  if (agentList) agents.value = agentList;
  if (commandList) commands.value = commandList;
  if (projectList) projects.value = projectList;
  // The window's folder: the host knows it exactly (it spawned the server
  // there). /project/current is the fallback (the rig) — a non-git folder
  // reports the "global" project (worktree "/"), which matches nothing.
  const here = meta("opencode-workspace");
  currentDir.value = normPath(here || current?.worktree || "");
  // "providerID/modelID" — the provider is the first segment.
  const m = config?.model?.match(/^([^/]+)\/(.+)$/);
  if (m) serverDefaultModel.value = { providerID: m[1], id: m[2] };
  baseLoaded.value = true;
  void resolveBlankSessions();
}

// First agent a fresh session runs on (first visible primary).
export function defaultAgent(): string {
  return (
    agents.value.find((a) => a.mode === "primary" && !a.hidden)?.name ?? "build"
  );
}

// What the composer footer shows for a draft (undefined id) or a session.
export function currentSelection(id: string | undefined): {
  agent: string;
  model?: ModelSelection;
} {
  if (!id) {
    return {
      agent: draftAgent.value ?? defaultAgent(),
      model: draftModel.value ?? serverDefaultModel.value,
    };
  }
  const s = sessions.value.find((x) => x.id === id);
  // A session never switched still runs on the server's default model.
  return {
    agent: s?.agent ?? defaultAgent(),
    model: s?.model ?? serverDefaultModel.value,
  };
}

// Picker switch. On a draft it just updates the held selection; on a session
// it hits the switch endpoints and patches the row (the SSE switched events
// carry the same truth).
export async function setSelection(
  id: string | undefined,
  sel: { agent?: string; model?: ModelSelection },
): Promise<void> {
  if (!id) {
    if (sel.agent) draftAgent.value = sel.agent;
    if (sel.model) draftModel.value = sel.model;
    return;
  }
  const ok =
    sel.agent !== undefined
      ? await switchSessionAgent(id, sel.agent)
      : sel.model !== undefined
        ? await switchSessionModel(
            id,
            sel.model.providerID,
            sel.model.id,
            sel.model.variant,
          )
        : true;
  if (!ok) {
    setSendError("The switch was rejected by the server.");
    return;
  }
  // The picker's model/effort choice: the session row itself is corruptible
  // (see guardVariant), so the user's intent lives here too.
  if (id && sel.model) {
    if (sel.model.variant) pickedVariants.set(id, sel.model);
    else pickedVariants.delete(id);
    savePickedVariants();
  }
  patchSession(id, (s) =>
    sel.agent !== undefined
      ? { ...s, agent: sel.agent }
      : { ...s, model: sel.model },
  );
}

// The summarize endpoint takes no variant, and the server rewrites the
// session row from every turn — so each compaction (manual /compact or the
// server's auto-compact) resets a picked reasoning effort to "default".
// When a row arrives back on the same model without the remembered pick,
// re-assert it. A different model means another surface switched: adopt.
// A bare model switch writes the literal "default" into the row, so that
// value is not an intent to guard — only real variants are.
const pickedVariants = new Map<string, ModelSelection>(
  Object.entries(
    ((): Record<string, unknown> => {
      try {
        const parsed: unknown = JSON.parse(
          localStorage.getItem("opencode-variant-picks") ?? "{}",
        );
        return typeof parsed === "object" && parsed !== null
          ? (parsed as Record<string, unknown>)
          : {};
      } catch {
        return {};
      }
    })(),
  ).filter(
    ([, v]) =>
      typeof (v as ModelSelection)?.providerID === "string" &&
      typeof (v as ModelSelection)?.id === "string" &&
      typeof (v as ModelSelection)?.variant === "string",
  ) as [string, ModelSelection][],
);
// Picks outlive the webview: a restart must not disarm the guard above.
function savePickedVariants(): void {
  try {
    localStorage.setItem(
      "opencode-variant-picks",
      JSON.stringify(Object.fromEntries(pickedVariants)),
    );
  } catch {
    // Quota or privacy mode — the picks stay in-memory only.
  }
}
const restoringVariants = new Set<string>();

function guardVariant(id: string, model: Session["model"] | undefined): void {
  if (!model) return;
  const pick = pickedVariants.get(id);
  if (!pick?.variant) {
    // A row arriving with the variant still set IS the standing pick —
    // adopt it, so a restart (the map starts empty, and a compaction may
    // land any moment after) re-arms the guard from the server's own row.
    if (model.variant && model.variant.toLowerCase() !== "default") {
      pickedVariants.set(id, {
        providerID: model.providerID,
        id: model.id,
        variant: model.variant,
      });
      savePickedVariants();
    }
    return;
  }
  if (model.providerID !== pick.providerID || model.id !== pick.id) {
    pickedVariants.delete(id);
    savePickedVariants();
    return;
  }
  if (model.variant === pick.variant || restoringVariants.has(id)) return;
  restoringVariants.add(id);
  void (async () => {
    const ok = await switchSessionModel(
      id,
      pick.providerID,
      pick.id,
      pick.variant,
    );
    restoringVariants.delete(id);
    if (!ok) {
      pickedVariants.delete(id);
      savePickedVariants();
      return;
    }
    patchSession(id, (s) => ({ ...s, model: pick }));
  })();
}

function patchSession(
  id: string,
  fn: (s: Session) => Session,
): void {
  sessions.value = sessions.value.map((s) => (s.id === id ? fn(s) : s));
}

// Append the next page of sessions. No-op while a page is in flight or no
// cursor remains.
let loadingMore = false;
export async function loadMoreSessions(): Promise<void> {
  const cursor = sessionsNext.value;
  if (!cursor || loadingMore) return;
  loadingMore = true;
  try {
    const page = await fetchSessions(cursor);
    if (!page) return;
    const seen = new Set(sessions.value.map((s) => s.id));
    sessions.value = [
      ...sessions.value,
      ...page.sessions.filter((s) => !seen.has(s.id)),
    ];
    sessionsNext.value = page.next;
  } finally {
    loadingMore = false;
  }
}

// --- Home: rename, delete, project purge/tombstones ---

export async function renameSession(id: string, title: string): Promise<boolean> {
  const directory = sessions.value.find((s) => s.id === id)?.location?.directory;
  if (!(await renameSessionApi(id, title, directory))) {
    setSendError("The rename was rejected by the server.");
    return false;
  }
  patchSession(id, (s) => ({ ...s, title }));
  return true;
}

// A project's label: the user-set name when present, the folder name
// otherwise.
export function projectDisplayName(dir: string): string {
  const row = projects.value.find(
    (p) => normPath(p.worktree) === normPath(dir),
  );
  return row?.name || baseName(dir);
}

// Rename a project's display name; the worktree is untouched.
export async function renameProject(
  dir: string,
  name: string,
): Promise<boolean> {
  const row = projects.value.find(
    (p) => normPath(p.worktree) === normPath(dir),
  );
  if (!row) {
    setSendError("That project is not in the server's project list.");
    return false;
  }
  if (!(await renameProjectApi(row.id, name, row.worktree))) {
    setSendError("The rename was rejected by the server.");
    return false;
  }
  projects.value = projects.value.map((p) =>
    p === row ? { ...p, name } : p,
  );
  return true;
}

// Close a tab and drop its cached transcript — reopening refetches. The
// router stays free of store imports; this is the tab-close entry point.
export function closeSessionTab(id: string): void {
  forgetTruncatedParts(
    (messagesBySession.value.get(id) ?? []).flatMap((m) =>
      m.parts.map((p) => p.id),
    ),
  );
  closeTab(id);
  // The computed view dies with the transcript; a future open builds a
  // fresh one.
  listViews.delete(id);
  const map = new Map(messagesBySession.value);
  map.delete(id);
  messagesBySession.value = map;
  const cursors = new Map(messagesCursor.value);
  cursors.delete(id);
  messagesCursor.value = cursors;
  olderPool.delete(id);
}

// Drop a session from every local store; its tab (if any) closes, and a
// closed active tab goes home.
function dropSessionLocal(id: string): void {
  // Every per-session store, or deletes leak state.
  cancelIdle(id);
  cancelRing(id);
  forgetTruncatedParts(
    (messagesBySession.value.get(id) ?? []).flatMap((m) =>
      m.parts.map((p) => p.id),
    ),
  );
  sessions.value = sessions.value.filter((s) => s.id !== id);
  if (pickedVariants.delete(id)) savePickedVariants();
  restoringVariants.delete(id);
  const map = new Map(messagesBySession.value);
  map.delete(id);
  messagesBySession.value = map;
  const statuses = { ...sessionStatus.value };
  delete statuses[id];
  sessionStatus.value = statuses;
  const steps = { ...stepUsage.value };
  delete steps[id];
  stepUsage.value = steps;
  blankSessions.value = new Set(
    [...blankSessions.value].filter((s) => s !== id),
  );
  blankChecked.delete(id);
  dropQueued(id);
  disarmGhostWatch(id);
  interruptedPrompts.value = new Set(
    [...interruptedPrompts.value].filter((s) => s !== id),
  );
  stoppedPrompts.value = new Set(
    [...stoppedPrompts.value].filter((s) => s !== id),
  );
  const cursors = new Map(messagesCursor.value);
  cursors.delete(id);
  messagesCursor.value = cursors;
  olderPool.delete(id);
  loadingMessages.delete(id);
  loadingOlder.delete(id);
  postedRows.delete(id);
  dropDraft(id);
  if (composerFiles.value[id]) {
    const files = { ...composerFiles.value };
    delete files[id];
    composerFiles.value = files;
  }
  try {
    localStorage.removeItem(cmdStoreKey(id));
  } catch {
    // Ignore — a leaked key is harmless next to a crashing delete.
  }
  closeSessionTab(id);
}

export async function deleteSession(id: string): Promise<boolean> {
  const directory = sessions.value.find((s) => s.id === id)?.location?.directory;
  if (!(await deleteSessionApi(id, directory))) {
    setSendError("The delete was rejected by the server.");
    return false;
  }
  dropSessionLocal(id);
  return true;
}

// Rewind the session to before a user prompt: it, its reply, and everything
// after fold out (unrevert would restore). The server only MARKS the cut on
// the session row — it keeps serving the rows until the next prompt commits
// the truncation — so the marker is stored and refreshMessages folds at it.
export async function revertSession(id: string, messageID: string): Promise<boolean> {
  const directory = sessions.value.find((s) => s.id === id)?.location?.directory;
  const row = await revertSessionApi(id, messageID, directory);
  if (!row) {
    setSendError("The revert was rejected by the server.");
    return false;
  }
  patchSession(id, () => row);
  await refreshMessages(id);
  return true;
}

// Turn a model citation into a path that opens. `client.go:322` is prose —
// the model writes the basename it last had in context, and the real file
// usually sits deeper — so a bare basename resolves to a real file: first
// among the paths this session's tool calls actually touched (read/edit/
// write inputs carry filePath), then the server's file index (the
// @-mention finder, exact basename, shallowest wins). Absolutized against
// the session's own directory, so a worktree session opens its worktree's
// copy. A ref that already has a directory part is trusted as-is. Total:
// resolves to something or returns its input.
export async function resolveFileRef(path: string): Promise<string> {
  if (path.includes("/")) return path;
  const base = (p: string) => p.replace(/\\/g, "/").split("/").pop() ?? "";
  const sid =
    route.value.view === "session"
      ? (route.value.child ?? route.value.id)
      : undefined;
  // Most recently touched wins — the model cites what it just read.
  let touched: string | undefined;
  const list = sid ? messagesBySession.value.get(sid) : undefined;
  for (const m of list ?? []) {
    for (const p of m.parts) {
      if (!isTool(p)) continue;
      const fp = p.state?.input?.filePath;
      if (typeof fp === "string" && base(fp) === path) touched = fp;
    }
  }
  let rel = touched?.replace(/\\/g, "/");
  if (!rel) {
    const rows = (await findFiles(path)).filter((r) => base(r) === path);
    rel = rows.sort((a, b) => a.length - b.length)[0];
  }
  if (!rel || /^(?:[a-z]:)?\//i.test(rel)) return rel ?? path;
  const dir = sessions.value.find((s) => s.id === sid)?.location?.directory;
  return dir ? `${normPath(dir)}/${rel}` : rel;
}

// Project delete: purge every session of the worktree, then tombstone the
// folder (host persists; Home filters it out immediately). Only tombstones
// when the purge fully succeeded.
export async function purgeProject(dir: string): Promise<boolean> {
  // The next attempt replaces the last attempt's error, success included.
  setSendError(undefined);
  const rows = await fetchProjectSessions(dir);
  if (!rows) {
    setSendError("Could not list the project's sessions.");
    return false;
  }
  const key = normPath(dir);
  purgeState.value = { dir: key, done: 0, total: rows.length };
  let done = 0;
  for (const row of rows) {
    if (await deleteSessionApi(row.id, dir)) {
      done += 1;
      dropSessionLocal(row.id);
    }
    purgeState.value = { dir: key, done, total: rows.length };
  }
  purgeState.value = undefined;
  if (done < rows.length) {
    setSendError(`Deleted ${done} of ${rows.length} sessions — the project was not removed.`);
    return false;
  }
  tombstoneProject(dir);
  return true;
}

export function tombstoneProject(dir: string): void {
  const p = normPath(dir);
  tombstones.value = [p, ...tombstones.value.filter((t) => t !== p)].slice(0, 50);
  // A purged project can be the one the session list was filtered to — drop
  // the filter with it, or Home's right column stays empty with no row to
  // click out of it.
  if (homeFilter.value === p) homeFilter.value = undefined;
  postToHost({ type: "project-tombstoned", path: p });
}

// --- Messages ---

// Sessions nothing ever happened in — Home hides them: a "+" never typed
// into is not a session worth listing. Suspicion is the server never
// touching the row (time.updated still equals created); a bare timestamp
// would also suspect messages injected without a server touch (fixtures),
// so hiding waits for confirmation — a resolved messages fetch, or the
// newSession path that knows its own creation is blank. A touched row is
// always listed, so a stale flag can't bury a live session.
const blankSessions = signal<Set<string>>(new Set());
const blankChecked = new Set<string>();

export function isEmptySession(s: Session): boolean {
  return s.time.updated === s.time.created && blankSessions.value.has(s.id);
}

// Resolve every suspect once: no message rows confirms blank. Run after a
// base refresh — the suspect set only grows on new rows.
function resolveBlankSessions(): Promise<void> {
  const suspects = sessions.value.filter(
    (s) => s.time.updated === s.time.created && !blankChecked.has(s.id),
  );
  return Promise.all(
    suspects.map(async (s) => {
      blankChecked.add(s.id);
      const msgs = await fetchMessages(s.id);
      if (msgs && msgs.messages.length === 0) {
        blankSessions.value = new Set([...blankSessions.value, s.id]);
      }
    }),
  ).then();
}

// Display title. The server names fresh sessions "New session - <ISO
// timestamp>"; the timestamp is noise on screen — display drops it, and the
// row's time.created keeps the moment for the sessions-list hover. Sub-agent
// sessions are titled "<description> (@agent subagent)" — the parenthetical
// is bookkeeping, the description is the task.
export function sessionTitle(s: Session | undefined, id: string): string {
  const raw = s?.title || id;
  if (/^(?:New|Child) session - /.test(raw)) return raw.replace(/ - .*/, "");
  return raw.replace(/\s+\(@\S+ subagent\)$/, "");
}

// Sub-agent sessions: task-tool spawns carry parentID; the title suffix
// ("… (@agent subagent)") also catches the async-era spawns without one.
export function isSubagentSession(s: Session): boolean {
  return Boolean(s.parentID) || / \(@\S+ subagent\)$/.test(s.title);
}

// Absolute local date/time, fixed ISO order ("2026-09-03 14:35:29") so the
// shape never depends on the system locale (de-DE gives "03.09.2026").
export function formatDateTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    ` ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

// Hover text for a session row or tab: both moments, one per line.
export function formatSessionTimes(s: Session): string {
  return `Created ${formatDateTime(s.time.created)}
Last activity ${formatDateTime(s.time.updated)}`;
}

// A session's letter tile. The letter follows the title; the color binds to
// the folder — the project's host-assigned color when the folder is a known
// project, else the folder's hash — so a rename can never change it, and a
// folder without a project row (non-git folders register none) still colors
// its sessions like its Home project tile, which hashes the same directory.
// Sessions without a directory (task-stub sub-agents) belong to this
// window's folder — hashing the title instead would pick an arbitrary color.
export function sessionTile(s: Session | undefined, id: string) {
  const title = sessionTitle(s, id);
  const dir = normPath(s?.location?.directory ?? "") || currentDir.value || "";
  const color = projects.value.find((p) => normPath(p.worktree) === dir)?.icon
    ?.color;
  // The icon color is a palette NAME ("pink") — tileFor maps it to the hex;
  // fed raw into a style it becomes the CSS keyword instead (#ffc0cb).
  return color ? tileFor(title, color) : tileFor(dir || title);
}

// A session counts as working on busy OR retry: the server's retry backoff
// keeps the turn alive (the composer treats retry as working too), and a
// chip/stop button that drops out for the whole backoff window reads as a
// finished sub-agent that is anything but.
export function sessionWorking(id: string | undefined): boolean {
  if (id === undefined) return false;
  const t = sessionStatus.value[id]?.type;
  return t === "busy" || t === "retry";
}

// Copy-on-write so signal subscribers see each change. Events only touch
// sessions already opened; the rest are fetched wholesale on open.
function mutateMessages(
  id: string,
  fn: (list: ChatMessage[]) => ChatMessage[],
): void {
  const map = new Map(messagesBySession.value);
  map.set(id, fn(map.get(id) ?? []));
  messagesBySession.value = map;
}

function byCreated(a: ChatMessage, b: ChatMessage): number {
  return a.info.time.created - b.info.time.created;
}

function upsertMessage(sessionID: string, info: Message): void {
  mutateMessages(sessionID, (list) => {
    // Merge over the stored info: a step.started re-announces a message the
    // fetch already loaded with its usage, and replacing outright would
    // blank the thinking header's token count until the step ends.
    const next = list.some((m) => m.info.id === info.id)
      ? list.map((m) =>
          m.info.id === info.id
            ? { info: { ...m.info, ...info }, parts: m.parts }
            : m,
        )
      : [...list, { info, parts: [] }];
    return next.sort(byCreated);
  });
}

// Patch one stored message's info in place (completion time, usage, error).
function patchMessage(
  sessionID: string,
  messageID: string,
  fn: (info: Message) => Message,
): void {
  mutateMessages(sessionID, (list) =>
    list.map((m) => (m.info.id === messageID ? { ...m, info: fn(m.info) } : m)),
  );
}

function upsertPart(sessionID: string, part: Part): void {
  // Display-only text clamps before it enters state (see clampPartText).
  if (isText(part) && typeof part.text === "string")
    part = { ...part, text: clampPartText(part.id, part.text) };
  if (
    isTool(part) &&
    part.state &&
    typeof part.state.output === "string" &&
    part.state.output.length > PART_TEXT_CAP
  )
    part = {
      ...part,
      state: { ...part.state, output: clampToolOutput(part.id, part.state.output) },
    };
  mutateMessages(sessionID, (list) =>
    list.map((m) => {
      if (m.info.id !== part.messageID) return m;
      if (m.parts.some((p) => p.id === part.id)) {
        return { ...m, parts: m.parts.map((p) => (p.id === part.id ? part : p)) };
      }
      // A local stand-in for the same slot (`{messageID}:text`, seeded from
      // an echo) yields to the server part, whose id differs.
      const standIn = `${part.messageID}:${part.type}`;
      if (m.parts.some((p) => p.id === standIn)) {
        return {
          ...m,
          parts: m.parts.map((p) => (p.id === standIn ? part : p)),
        };
      }
      return { ...m, parts: [...m.parts, part] };
    }),
  );
}

// Append one streaming chunk to a text/reasoning part, creating it on the
// first delta (text.started carries only the id). Once a part clamped, its
// deltas are dropped — re-slicing a cap-sized text per token and re-ticking
// the marker's total would only burn the renderer for nothing.
function appendPartText(
  sessionID: string,
  messageID: string,
  partID: string,
  type: "text" | "reasoning",
  delta: string,
): void {
  if (isTruncatedPart(partID)) return;
  mutateMessages(sessionID, (list) =>
    list.map((m) => {
      if (m.info.id !== messageID) return m;
      const known = m.parts.some((p) => p.id === partID);
      const parts = known
        ? m.parts.map((p) =>
            p.id === partID && isText(p)
              ? {
                  ...p,
                  text: clampPartText(partID, (p.text ?? "") + delta),
                  // A delta after the ended stamp means the window reopened
                  // (post-tool thinking reuses the part): drop the end so
                  // the block reads "Thinking..." until the next ended.
                  time:
                    p.time?.end !== undefined
                      ? { start: p.time.start }
                      : p.time,
                }
              : p,
          )
        : [
            ...m.parts,
            // The start stamp seeds the reasoning block's duration; the
            // ended event supplies the end.
            {
              id: partID,
              messageID,
              sessionID,
              type,
              text: clampPartText(partID, delta),
              time: { start: Date.now() },
            },
          ];
      return { ...m, parts };
    }),
  );
}

// The server echo of our optimistic send supersedes every pending entry.
function clearPending(sessionID: string): void {
  mutateMessages(sessionID, (list) =>
    list.filter((m) => !m.info.id.startsWith("pending:")),
  );
}

// A step ending is only PROBABLY the turn ending: a thinking step closes
// and the answer step follows seconds later, and idling on the boundary
// freezes a live turn dead (static dot, stopped counter). The server sends
// no turn-end signal, so an ambiguous step end schedules the idle a beat
// out — a step.started within the grace re-busies without a flicker; real
// silence lets it fire.
const idleTimers: Record<string, number> = {};

function scheduleIdle(sessionID: string): void {
  clearTimeout(idleTimers[sessionID]);
  idleTimers[sessionID] = window.setTimeout(() => {
    delete idleTimers[sessionID];
    dropQueued(sessionID);
    setIdle(sessionID);
  }, 3000);
}

function cancelIdle(sessionID: string): void {
  clearTimeout(idleTimers[sessionID]);
  delete idleTimers[sessionID];
}

// A streaming token is proof the turn is alive: the zhipuai endpoint's
// spurious empty steps idle the session mid-turn, and a v1 turn has no
// step events to re-busy it — every live marker (the Thinking label, the
// footer counter) would freeze settled while the model still talks.
function markStreaming(sessionID: string): void {
  cancelIdle(sessionID);
  cancelRing(sessionID);
  if (sessionStatus.value[sessionID]?.type === "busy") return;
  sessionStatus.value = {
    ...sessionStatus.value,
    [sessionID]: { type: "busy" },
  };
}

// The ready ring lags the idle by a grace beat: an idle that a follow-up
// message resumes within a second is a seam, not standby, and must not
// chime. Resumed work cancels; the ring fires only from a standstill.
const RING_GRACE_MS = 1500;
const ringTimers: Record<string, number> = {};

function cancelRing(sessionID: string): void {
  clearTimeout(ringTimers[sessionID]);
  delete ringTimers[sessionID];
}

function scheduleRing(sessionID: string): void {
  cancelRing(sessionID);
  ringTimers[sessionID] = window.setTimeout(() => {
    delete ringTimers[sessionID];
    // Absence from the map is idle truth — a status adoption landing
    // mid-grace replaces the map wholesale with the busy-only payload
    // /session/status serves, and the just-written idle vanishes with it.
    const nowType = sessionStatus.value[sessionID]?.type ?? "idle";
    if (nowType !== "idle") return;
    playReadySound();
  }, RING_GRACE_MS);
}

// Idle write that rings the ready sound: a session seen busy (or retrying)
// that lands idle finished its turn — the opencode TUI's bell
// (packages/tui feature-plugins/system/notifications.ts). Only observed
// transitions ring (a page loaded mid-turn stays silent), subagent
// children never ring (the parent turn rings when it lands), and the
// user-initiated retire paths bypass this on purpose.
// The assistant row that was the transcript's tail when the session last
// went idle — the live-marker sweep's anti-pulse guard: while the next
// turn warms up (busy again, no assistant row past the new prompt yet),
// the settled tail must not re-animate (dot, Thinking label, footer).
const idleTails: Record<string, string> = {};

function setIdle(sessionID: string): void {
  const tail = [...(messagesBySession.value.get(sessionID) ?? [])]
    .reverse()
    .find((m) => m.info.role === "assistant")?.info.id;
  if (tail) idleTails[sessionID] = tail;
  const prev = sessionStatus.value[sessionID]?.type ?? "idle";
  sessionStatus.value = {
    ...sessionStatus.value,
    [sessionID]: { type: "idle" },
  };
  if (prev !== "busy" && prev !== "retry") return;
  const s = sessions.value.find((x) => x.id === sessionID);
  if (s && isSubagentSession(s)) return;
  // A queued turn takes the session back into a turn within a beat —
  // this idle is a seam in the queue, not readiness. The green tab and
  // the sound land when the last one drains.
  if (hasQueued(sessionID)) return;
  // Turn landed in a tab the user isn't looking at — green until they
  // open it (navigate clears).
  if (openTabs.value.includes(sessionID) && activeTab.value !== sessionID) {
    unreadTabs.value = new Set(unreadTabs.value).add(sessionID);
  }
  scheduleRing(sessionID);
}

// The row whose live markers animate (the Thinking label, the footer): the
// newest assistant row past the newest prompt. A prompt admitted mid-turn
// (a steer) lands its user row while the turn still streams — treating it
// as the boundary freezes the streaming row's "Thinking..." into "Thought"
// until the turn's next row lands seconds later. While no assistant row
// follows the newest prompt, the streaming turn's tail stays live instead,
// unless that tail already settled through an idle: then the busy turn is
// a newer one warming up and must not re-animate the old tail.
export function liveAssistantId(
  sessionID: string,
  list: readonly ChatMessage[],
): string | undefined {
  let past: string | undefined;
  let tail: string | undefined;
  for (const m of list) {
    if (m.info.role === "user") past = undefined;
    else if (m.info.role === "assistant") {
      past = m.info.id;
      tail = m.info.id;
    }
  }
  return past ?? (tail !== undefined && tail !== idleTails[sessionID] ? tail : undefined);
}

function upsertSession(info: Session): void {
  sessions.value = [info, ...sessions.value.filter((s) => s.id !== info.id)].sort(
    (a, b) => b.time.updated - a.time.updated,
  );
  guardVariant(info.id, info.model);
}

function applyEvent(event: ServerEvent): void {
  const data = event.data as {
    sessionID?: string;
    messageID?: string;
    info?: Session & Message;
    part?: Part;
    status?: SessionStatus;
    agent?: string;
    model?: Session["model"];
    // session.next.step.ended carries the finished step's own usage.
    timestamp?: number;
    cost?: number;
    tokens?: MessageTokens;
    // permission.v2.asked / question.v2.asked carry the request itself; the
    // replied/rejected events carry {requestID, reply, ...}.
    id?: string;
    requestID?: string;
    reply?: string;
    // session.error / session.next.step.failed carry the failed turn's
    // error (same shape as Message.error).
    error?: Message["error"];
    // Turn-stream fields (session.next.*): the prompt row, text/reasoning
    // part ids and their deltas, tool calls keyed by callID.
    assistantMessageID?: string;
    textID?: string;
    reasoningID?: string;
    callID?: string;
    prompt?: { text?: string };
    delta?: string;
    text?: string;
    name?: string;
    input?: Record<string, unknown>;
    result?: unknown;
    // tool.success's machine-readable result (patches, todo rows).
    structured?: unknown;
    content?: unknown;
    // session.next.step.ended's step finish reason ("stop", "tool-calls", …).
    finish?: string;
    // message.part.delta (v1): the part id and which field the chunk appends
    // to ("text", "reasoning").
    partID?: string;
    field?: string;
  };
  switch (event.type) {
    // Both carry the full session row; "created" is the only signal for a
    // session made outside this window (the local send path upserts itself).
    // Normalize: the event's info carries `directory`, not `location` —
    // upserting it raw would clobber the row the create path stored and
    // unbind the tab's project color.
    case "session.created":
    case "session.updated":
      if (data.info) upsertSession(normalizeSession(data.info));
      break;
    // The v1 stream's authoritative busy/idle (v1 turns have no step events
    // to derive from; the v2 fallback below stays for v2-prompted sessions).
    case "session.idle":
      if (data.sessionID) {
        cancelIdle(data.sessionID);
        // A queued turn's echo must survive the boundary turn's idle — it
        // is delivered as the next turn: a locally held turn (hasQueued)
        // or a steered POST whose user row hasn't landed yet
        // (postedRows). Any other echo is stale (its ask never happened
        // or already ended).
        if (!hasQueued(data.sessionID) && !postedRows.has(data.sessionID))
          dropPending(data.sessionID);
        setIdle(data.sessionID);
      }
      break;
    case "session.status":
      if (data.sessionID && data.status) {
        if (data.status.type === "idle") setIdle(data.sessionID);
        else {
          // A live status (busy, retry — backoffs run minutes) keeps the
          // turn going: a pending step-failed grace must not idle over it.
          cancelIdle(data.sessionID);
          sessionStatus.value = {
            ...sessionStatus.value,
            [data.sessionID]: data.status,
          };
        }
      }
      break;
    // A turn that dies after the prompt was admitted (e.g. the model is
    // unavailable) surfaces only here — without it the pending bubble and
    // the busy composer stick forever with no explanation.
      case "session.error":
      if (data.sessionID) {
        cancelIdle(data.sessionID);
        dropQueued(data.sessionID);
        postedRows.delete(data.sessionID);
        dropPending(data.sessionID);
        setIdle(data.sessionID);
        // The abort of a user-stopped turn arrives as this event
        // ("Aborted") — the transcript's Interrupted marker tells that
        // story; a red line under the turn would only double it.
        const stoppedLast = lastUserPrompt(data.sessionID)?.info.id;
        if (!stoppedLast || !stoppedPrompts.value.has(stoppedLast)) {
          setSendError(
            data.error?.data?.message ??
              (data.error?.name
                ? `${data.error.name} — the turn failed.`
                : "The turn failed."),
            data.sessionID,
          );
        }
      }
      break;
    case "session.next.step.ended":
      if (data.sessionID && data.tokens) {
        const t = data.tokens;
        stepUsage.value = {
          ...stepUsage.value,
          [data.sessionID]: {
            timestamp: data.timestamp ?? Date.now(),
            tokens: t,
          },
        };
        // The step's numbers are a delta: the session row keeps the running
        // sum (server truth returns with the next full refresh).
        patchSession(data.sessionID, (s) => ({
          ...s,
          cost: s.cost + (data.cost ?? 0),
          tokens: {
            input: s.tokens.input + t.input,
            output: s.tokens.output + t.output,
            reasoning: s.tokens.reasoning + t.reasoning,
            cache: {
              read: s.tokens.cache.read + t.cache.read,
              write: s.tokens.cache.write + t.cache.write,
            },
          },
        }));
      }
      break;
    case "session.next.agent.switched":
      if (data.sessionID && data.agent) {
        patchSession(data.sessionID, (s) => ({ ...s, agent: data.agent }));
      }
      break;
    case "session.next.model.switched":
      if (data.sessionID && data.model) {
        patchSession(data.sessionID, (s) => ({ ...s, model: data.model }));
        guardVariant(data.sessionID, data.model);
      }
      break;
    case "permission.v2.asked":
      // The TUI's permission bell: live asks ring once — a repeated event
      // for a docked ask, and asks re-docked by refreshPermissions on
      // session open, stay silent.
      if (data.id) {
        if (!pendingPermissions.value.some((p) => p.id === data.id)) {
          playPermissionSound();
        }
        pendingPermissions.value = [
          ...pendingPermissions.value.filter((p) => p.id !== data.id),
          normalizePermission(data as unknown as PermissionRequest, false),
        ];
      }
      break;
    case "permission.v2.replied":
      if (data.requestID) {
        pendingPermissions.value = pendingPermissions.value.filter(
          (p) => p.id !== data.requestID,
        );
      }
      // A rejected permission aborts the turn: the stream carries the tool
      // failure, then goes quiet — no step.ended ever fires, so without
      // this the busy composer sticks over a dead turn.
      if (data.reply === "reject" && data.sessionID) {
        retireTurn(data.sessionID);
      }
      break;
    // Same facts on the v1 stream, under the un-suffixed names (the v2
    // turn never emits these): without this dock a v1 bash ask pends
    // forever — the server holds the turn busy and runs nothing.
    case "permission.asked":
      if (data.id) {
        if (!pendingPermissions.value.some((p) => p.id === data.id)) {
          playPermissionSound();
        }
        pendingPermissions.value = [
          ...pendingPermissions.value.filter((p) => p.id !== data.id),
          normalizePermission(data as unknown as PermissionRequest, true),
        ];
      }
      break;
    case "permission.replied":
      if (data.requestID) {
        pendingPermissions.value = pendingPermissions.value.filter(
          (p) => p.id !== data.requestID,
        );
      }
      if (data.reply === "reject" && data.sessionID) {
        retireTurn(data.sessionID);
      }
      break;
    // One question tool, two event names: a v2-prompted turn emits the
    // v2-suffixed names on /api/event, a v1-prompted turn the bare ones on
    // /event — same payload shape (id, sessionID, questions) either way.
    // Without the bare pair a v1 ask never docks: the turn just sits busy
    // while the model waits on an answer that can't be given.
    case "question.v2.asked":
    case "question.asked":
      if (data.id) {
        // Live asks ring once — a repeated event for a docked ask, and
        // asks re-docked by refreshQuestions on session open, stay silent.
        if (!pendingQuestions.value.some((q) => q.id === data.id)) {
          playQuestionSound();
        }
        const q = data as unknown as QuestionRequest;
        pendingQuestions.value = [
          ...pendingQuestions.value.filter((x) => x.id !== data.id),
          // The bare name rides the v1 stream: its reply must go to the v1
          // route (see QuestionRequest.v1).
          event.type === "question.asked" ? { ...q, v1: true } : q,
        ];
      }
      break;
    case "question.v2.replied":
    case "question.v2.rejected":
    case "question.replied":
    case "question.rejected":
      if (data.requestID) {
        markSettled(settledQuestions, data.requestID);
        pendingQuestions.value = pendingQuestions.value.filter(
          (q) => q.id !== data.requestID,
        );
      }
      // A rejected question aborts the turn: the stream carries the reject
      // plus tool.failed, then goes quiet — no step.ended ever fires, so
      // without this the busy composer sticks over a dead turn.
      if (
        (event.type === "question.v2.rejected" ||
          event.type === "question.rejected") &&
        data.sessionID
      ) {
        retireTurn(data.sessionID);
      }
      break;
  }
  // Busy/idle is derived from step boundaries for EVERY session, opened or
  // not (there is no session.status event on /api/event): chips, Home rows
  // and the composer must pulse for background work too — a sub-agent
  // relaying into a session this window never opened, another window's
  // turn. Message projection stays gated below.
  if (data.sessionID) {
    const sid = data.sessionID;
    // Streaming evidence, in both wire dialects: a delta token, or a
    // full-part write that grows an open text/reasoning part. The turn is
    // alive even when the server just idled it (spurious empty step) —
    // re-busy before the per-session handling below. The growth check
    // keeps a final-state rewrite (e.g. a post-abort flush) from raising
    // a dead turn.
    if (deltaKey(event) !== undefined) markStreaming(sid);
    else if (event.type === "message.part.updated") {
      const p = (data as { part?: Part }).part;
      if (p !== undefined && isText(p) && p.time?.end === undefined) {
        const known = messagesBySession.value
          .get(sid)
          ?.find((m) => m.info.id === p.messageID)
          ?.parts.find((q) => q.id === p.id);
        if (
          !(
            known &&
            isText(known) &&
            (known.text ?? "").length >= (p.text ?? "").length
          )
        )
          markStreaming(sid);
      }
    }
    if (event.type === "session.next.step.started") {
      cancelIdle(sid);
      cancelRing(sid);
      sessionStatus.value = { ...sessionStatus.value, [sid]: { type: "busy" } };
    } else if (event.type === "session.next.step.failed") {
      // A failed step retries under the server's policy (status "retry"
      // follows on the stream) — only the server's own idle truth ends the
      // turn, so this is a grace, not an immediate idle.
      cancelIdle(sid);
      scheduleIdle(sid);
    } else if (
      event.type === "session.next.step.ended" &&
      data.finish !== "tool-calls" &&
      (data.tokens?.output ?? 0) > 0
    ) {
      scheduleIdle(sid);
    }
  }
  // Turn events only touch sessions already opened; others are fetched
  // wholesale when opened.
  if (!data.sessionID || !messagesBySession.value.has(data.sessionID)) return;
  const sid = data.sessionID;
  switch (event.type) {
    // --- v1 turn dialect (GET /event): rows and parts address the legacy
    // store this extension's sessions live in (see promptSession). ---
    case "message.updated": {
      const raw = data.info as
        | (Message & { model?: { providerID?: string; modelID?: string } })
        | undefined;
      if (!raw) break;
      // An unseen row resumes the session — a pending ready ring from the
      // last idle was a premature standby call. Seen rows must not cancel:
      // the turn-end summary write re-emits the turn's own user row
      // (summary.diffs) right after session.idle and used to silence every
      // completion chime.
      if (
        !messagesBySession.value.get(sid)?.some((m) => m.info.id === raw.id)
      )
        cancelRing(sid);
      // The real user row retires the optimistic echo. Its text part trails
      // by a beat (row first, part second), so seed it from the echo's text
      // and the bubble swaps without a blank flash.
      const seed =
        raw.role === "user"
          ? [...(messagesBySession.value.get(sid) ?? [])]
              .reverse()
              .find((m) => m.info.id.startsWith("pending:"))
              ?.parts.find(isText)?.text
          : undefined;
      if (raw.role === "user") {
        const echo = (messagesBySession.value.get(sid) ?? []).some((m) =>
          m.info.id.startsWith("pending:"),
        );
        const unseen = !messagesBySession.value
          .get(sid)
          ?.some((m) => m.info.id === raw.id);
        if (echo) {
          clearPending(sid);
          const left = (postedRows.get(sid) ?? 1) - 1;
          if (left > 0) postedRows.set(sid, left);
          else postedRows.delete(sid);
        } else if (
          unseen &&
          ghostWatch.has(sid) &&
          !postedRows.has(sid)
        ) {
          // A user row nobody here submitted, right after a stop, is the
          // server's queued steer firing as a ghost turn — abort it (after
          // the row lands below, so the stop marker finds it).
          queueMicrotask(() => void stopSession(sid));
        }
      }
      // Only known fields ride along: absent tokens/cost must not clobber
      // what a step-finish already patched onto the row — and a zeroed
      // announcement must not land either (tokensTotal).
      const prevRow = raw.role === "assistant"
        ? messagesBySession.value.get(sid)?.find((m) => m.info.id === raw.id)
        : undefined;
      upsertMessage(sid, {
        id: raw.id,
        role: raw.role,
        time: raw.time,
        ...(raw.agent ? { agent: raw.agent } : {}),
        ...(raw.model?.providerID || raw.providerID
          ? { providerID: raw.model?.providerID ?? raw.providerID }
          : {}),
        ...(raw.model?.modelID || raw.modelID
          ? { modelID: raw.model?.modelID ?? raw.modelID }
          : {}),
        ...(raw.cost !== undefined ? { cost: raw.cost } : {}),
        ...(tokensTotal(raw.tokens) ? { tokens: raw.tokens } : {}),
        ...(raw.error ? { error: raw.error } : {}),
      });
      // A v1 row's first usage often arrives here, not via step-finish —
      // without a chars stamp the tail estimate dies and the counter
      // freezes at that number for the rest of the stream (measured on a
      // real GLM turn: "85" held for 40s, then jumped to the true total).
      // Stamp like step-finish does; tool-carrying rows skip calibration
      // for the same reason.
      if (raw.role === "assistant" && tokensTotal(raw.tokens) && prevRow && !prevRow.info.tokens) {
        const chars = prevRow.parts.reduce(
          (k, p) => k + (isText(p) ? p.text?.length ?? 0 : 0),
          0,
        );
        if (!prevRow.parts.some((p) => isTool(p)))
          calibrateTokens(
            chars,
            (raw.tokens?.output ?? 0) + (raw.tokens?.reasoning ?? 0),
          );
        patchMessage(sid, raw.id, (info) => ({ ...info, reportedChars: chars }));
      }
      if (seed) {
        upsertPart(sid, {
          id: `${raw.id}:text`,
          messageID: raw.id,
          sessionID: sid,
          type: "text",
          text: seed,
        });
      }
      break;
    }
    case "message.part.updated": {
      const part = data.part as Part | undefined;
      if (!part) break;
      // Step bookkeeping: step-start is noise; step-finish is the step's
      // usage — the ring's freshest number, and the row's tokens until the
      // next full refresh. The compaction summary's step measures the
      // summary turn, not session context (the ring skips its row too).
      if (part.type === "step-start") break;
      if (part.type === "step-finish") {
        const tokens = (part as unknown as { tokens?: MessageTokens }).tokens;
        const cost = (part as unknown as { cost?: number }).cost;
        // Zeroed usage is a step announcement, not a measurement — taking
        // it would pin the ring at 0 until the next real step-finish.
        if (!tokens || !tokensTotal(tokens)) break;
        const row = messagesBySession.value
          .get(sid)
          ?.find((m) => m.info.id === part.messageID);
        if (row?.info.agent !== "compaction") {
          stepUsage.value = {
            ...stepUsage.value,
            [sid]: { timestamp: data.timestamp ?? Date.now(), tokens },
          };
          // The step's usage is a delta and the row keeps streaming past
          // the boundary: accumulate (not replace) and stamp the chars the
          // usage covers, so the tail estimate and the rate counter keep
          // running for the rest of the row — and the chars/tokens pair
          // feeds the tail estimator's calibration.
          const chars = row
            ? row.parts.reduce(
                (k, p) => k + (isText(p) ? p.text?.length ?? 0 : 0),
                0,
              )
            : 0;
          const fresh = Math.max(0, chars - (row?.info.reportedChars ?? 0));
          // A step that emitted a tool call bills the call's tokens against
          // almost no chars — the pair would skew the text ratio the tail
          // estimate and the live rate ride. Only tool-free rows calibrate.
          if (row && !row.parts.some((p) => isTool(p)))
            calibrateTokens(
              fresh,
              (tokens.output ?? 0) + (tokens.reasoning ?? 0),
            );
          patchMessage(sid, part.messageID, (info) => ({
            ...info,
            ...(cost !== undefined ? { cost: (info.cost ?? 0) + cost } : {}),
            tokens: {
              input: (info.tokens?.input ?? 0) + (tokens.input ?? 0),
              output: (info.tokens?.output ?? 0) + (tokens.output ?? 0),
              reasoning: (info.tokens?.reasoning ?? 0) + (tokens.reasoning ?? 0),
              cache: {
                read: (info.tokens?.cache?.read ?? 0) + (tokens.cache?.read ?? 0),
                write: (info.tokens?.cache?.write ?? 0) + (tokens.cache?.write ?? 0),
              },
            },
            reportedChars: chars,
          }));
        }
        break;
      }
      upsertPart(sid, part);
      break;
    }
    case "message.part.delta":
      if (data.messageID && data.partID && typeof data.delta === "string") {
        appendPartText(
          sid,
          data.messageID,
          data.partID,
          data.field === "reasoning" ? "reasoning" : "text",
          data.delta,
        );
      }
      break;
    // The turn stream's dialect (verified against 1.18.25's durable replay —
    // message.updated does not exist on /api/event): the admitted prompt is
    // the user row; steps/text/reasoning/tools address rows and parts by id.
    case "session.next.prompt.admitted":
    case "session.next.prompted":
      if (data.messageID) {
        clearPending(sid);
        upsertMessage(sid, {
          id: data.messageID,
          role: "user",
          time: { created: data.timestamp ?? Date.now() },
        });
        if (data.prompt?.text) {
          upsertPart(sid, {
            id: `${data.messageID}:text`,
            messageID: data.messageID,
            sessionID: sid,
            type: "text",
            text: data.prompt.text,
          });
        }
      }
      break;
    case "session.next.step.started":
      if (data.assistantMessageID) {
        upsertMessage(sid, {
          id: data.assistantMessageID,
          role: "assistant",
          time: { created: data.timestamp ?? Date.now() },
          ...(data.agent ? { agent: data.agent } : {}),
          ...(data.model
            ? { providerID: data.model.providerID, modelID: data.model.id }
            : {}),
        });
      }
      break;
    case "session.next.text.delta":
      if (data.assistantMessageID && data.textID && data.delta) {
        appendPartText(sid, data.assistantMessageID, data.textID, "text", data.delta);
      }
      break;
    case "session.next.text.ended":
      if (data.assistantMessageID && data.textID) {
        const prev = messagesBySession.value
          .get(sid)
          ?.find((m) => m.info.id === data.assistantMessageID)
          ?.parts.find((p) => p.id === data.textID);
        upsertPart(sid, {
          id: data.textID,
          messageID: data.assistantMessageID,
          sessionID: sid,
          type: "text",
          text: data.text ?? "",
          time: {
            ...(prev && isText(prev) && prev.time?.start
              ? { start: prev.time.start }
              : {}),
            end: data.timestamp ?? Date.now(),
          },
        });
      }
      break;
    case "session.next.reasoning.delta":
      if (data.assistantMessageID && data.reasoningID && data.delta) {
        appendPartText(
          sid,
          data.assistantMessageID,
          data.reasoningID,
          "reasoning",
          data.delta,
        );
      }
      break;
    case "session.next.reasoning.ended":
      if (data.assistantMessageID && data.reasoningID) {
        const prev = messagesBySession.value
          .get(sid)
          ?.find((m) => m.info.id === data.assistantMessageID)
          ?.parts.find((p) => p.id === data.reasoningID);
        upsertPart(sid, {
          id: data.reasoningID,
          messageID: data.assistantMessageID,
          sessionID: sid,
          type: "reasoning",
          text: data.text ?? "",
          time: {
            ...(prev && isText(prev) && prev.time?.start
              ? { start: prev.time.start }
              : {}),
            end: data.timestamp ?? Date.now(),
          },
        });
      }
      break;
    case "session.next.tool.input.started":
      if (data.assistantMessageID && data.callID) {
        upsertPart(sid, {
          id: data.callID,
          messageID: data.assistantMessageID,
          sessionID: sid,
          type: "tool",
          tool: data.name ?? "",
          state: { status: "pending" },
        });
      }
      break;
    case "session.next.tool.called":
      if (data.assistantMessageID && data.callID) {
        patchToolState(sid, data.assistantMessageID, data.callID, (s) => ({
          ...s,
          status: "running",
          ...(data.input ? { input: data.input } : {}),
          time: { ...s.time, start: data.timestamp },
        }));
      }
      break;
    case "session.next.tool.success":
      if (data.assistantMessageID && data.callID) {
        patchToolState(sid, data.assistantMessageID, data.callID, (s) => ({
          ...s,
          status: "completed",
          output: typeof data.result === "string" ? data.result : s.output,
          // edit/apply_patch/todowrite return no result string — their
          // readable result rides `content` text items (the durable fetch
          // folds the same way), their machine result in `structured`.
          ...(Array.isArray(data.content) && !s.output
            ? {
                output: (data.content as { text?: unknown }[])
                  .map((c) => (typeof c?.text === "string" ? c.text : ""))
                  .filter(Boolean)
                  .join("\n"),
              }
            : {}),
          ...(data.structured !== undefined &&
          data.structured !== null &&
          typeof data.structured === "object"
            ? { structured: data.structured as Record<string, unknown> }
            : {}),
          time: { ...s.time, end: data.timestamp },
        }));
      }
      break;
    case "session.next.tool.failed":
      if (data.assistantMessageID && data.callID) {
        patchToolState(sid, data.assistantMessageID, data.callID, (s) => ({
          ...s,
          status: "error",
          error: stringifyError(data.error),
          time: { ...s.time, end: data.timestamp },
        }));
      }
      break;
    case "session.next.step.ended":
      if (data.assistantMessageID) {
        // The event's usage is the finished step's delta, so the message
        // accumulates it across its steps — overwriting would leave a
        // multi-step turn holding only the last step's numbers until the
        // next full refresh brings the server's total.
        const row = messagesBySession.value
          .get(sid)
          ?.find((m) => m.info.id === data.assistantMessageID);
        const chars = row
          ? row.parts.reduce(
              (k, p) => k + (isText(p) ? p.text?.length ?? 0 : 0),
              0,
            )
          : 0;
        if (data.tokens && tokensTotal(data.tokens))
          calibrateTokens(
            Math.max(0, chars - (row?.info.reportedChars ?? 0)),
            (data.tokens.output ?? 0) + (data.tokens.reasoning ?? 0),
          );
        patchMessage(sid, data.assistantMessageID, (info) => {
          const t = info.tokens;
          const d = data.tokens;
          const total = (t?.total ?? 0) + (d?.total ?? 0);
          return {
            ...info,
            time: { ...info.time, completed: data.timestamp },
            ...(data.cost !== undefined
              ? { cost: (info.cost ?? 0) + data.cost }
              : {}),
            ...(d && tokensTotal(d)
              ? {
                  tokens: {
                    input: (t?.input ?? 0) + (d.input ?? 0),
                    output: (t?.output ?? 0) + (d.output ?? 0),
                    reasoning: (t?.reasoning ?? 0) + (d.reasoning ?? 0),
                    cache: {
                      read: (t?.cache?.read ?? 0) + (d.cache?.read ?? 0),
                      write: (t?.cache?.write ?? 0) + (d.cache?.write ?? 0),
                    },
                    ...(total > 0 ? { total } : {}),
                  },
                  // Boundary stamp: chars streamed past this point are the
                  // unreported tail the turn footer keeps estimating.
                  reportedChars: chars,
                }
              : {}),
          };
        });
        // A step with no output tokens is the zhipuai endpoint's spurious
        // empty step, not a turn end: idling on it blanks the transcript
        // between the wait line and the first real token.
      }
      break;
    case "session.next.step.failed":
      if (data.assistantMessageID) {
        patchMessage(sid, data.assistantMessageID, (info) => ({
          ...info,
          time: { ...info.time, completed: data.timestamp },
          error: data.error ?? { name: "StepFailed" },
        }));
      }
      break;
  }
}

function patchToolState(
  sessionID: string,
  messageID: string,
  callID: string,
  fn: (state: NonNullable<ToolPart["state"]>) => NonNullable<ToolPart["state"]>,
): void {
  mutateMessages(sessionID, (list) =>
    list.map((m) =>
      m.info.id !== messageID
        ? m
        : {
            ...m,
            parts: m.parts.map((p) =>
              p.id === callID && isTool(p) && p.state
                ? { ...p, state: fn(p.state) }
                : p,
            ),
          },
    ),
  );
}

let disconnectEvents: (() => void) | undefined;

// Frames queue and a short timer drains them in order. Applied one per
// arrival, every frame paid a full store mutation plus a render pass —
// three parallel compactions stream deltas faster than the renderer could
// redraw, and the shared thread starved until the window hung. One pass
// per tick caps the work no matter how fast the streams arrive.
const eventQueue: ServerEvent[] = [];
let drainTimer: number | undefined;

// A delta event appending to one part; the key names the part (and field).
// Consecutive events with equal keys coalesce in the drain below.
function deltaKey(event: ServerEvent): string | undefined {
  if (typeof (event.data as { delta?: unknown })?.delta !== "string") return;
  const d = event.data as Record<string, string>;
  switch (event.type) {
    case "message.part.delta":
      return `p ${d.sessionID} ${d.messageID} ${d.partID} ${d.field}`;
    case "session.next.text.delta":
      return `t ${d.sessionID} ${d.assistantMessageID} ${d.textID}`;
    case "session.next.reasoning.delta":
      return `r ${d.sessionID} ${d.assistantMessageID} ${d.reasoningID}`;
  }
}

function queueEvent(event: ServerEvent): void {
  eventQueue.push(event);
  drainTimer ??= window.setTimeout(() => {
    drainTimer = undefined;
    const events = eventQueue.splice(0);
    for (let i = 0; i < events.length; i++) {
      let e = events[i];
      const key = deltaKey(e);
      if (key !== undefined) {
        let text = (e.data as { delta: string }).delta;
        while (i + 1 < events.length && deltaKey(events[i + 1]) === key) {
          text += (events[i + 1].data as { delta: string }).delta;
          i++;
        }
        e = { ...e, data: { ...(e.data as object), delta: text } };
      }
      try {
        if (e.type === "server.connected") void refreshBase();
        else applyEvent(e);
      } catch (err) {
        // The webview console is invisible to anyone debugging from the
        // outside — forward to the host's log channel.
        postToHost({
          type: "app-log",
          level: "error",
          text: `event apply failed: ${e.type}: ${
            err instanceof Error ? err.stack ?? err.message : String(err)
          }`,
        });
      }
    }
  }, 33);
}

// Wire the app to the server: prime the base state, then follow the event
// stream — `server.connected` (fired at boot and after a server restart)
// re-syncs the base state.
export function init(): void {
  // Only once the page carries a server origin (the ready flag) — a
  // loading/error page has no server to talk to yet.
  if (!meta("opencode-origin") || disconnectEvents) return;
  void refreshBase();
  void validateRestored();
  // A reconnect silently skips whatever streamed during the gap — a
  // turn's end can be missed, wedging the view on "Waiting for the
  // model…". Pull truth again after any drop→connect cycle (either
  // stream dropping alone counts): the status map heals stale busy, the
  // message pulls heal dropped rows. The same pull runs when the host
  // reports the webview visible again (resyncFromServer).
  let sawDrop = false;
  disconnectEvents = connectEvents({
    onEvent: queueEvent,
    onState: (state) => {
      if (state === "offline" || state === "connecting") {
        sawDrop = true;
        return;
      }
      if (state !== "connected" || !sawDrop) return;
      sawDrop = false;
      resyncFromServer();
    },
  });
}

// Pull server truth after an event gap — a dropped stream or a suspended
// webview whose host messages were lost. Statuses heal stale busy,
// message pulls heal dropped rows, ask pulls re-dock undisplayed asks.
// The server closes a /api/event subscriber when a /event one connects
// (another client attaching), so reconnect-resyncs can arrive in a burst;
// one pull per window is plenty, with a trailing pull to heal whatever
// the last gap dropped.
const RESYNC_MIN_MS = 5_000;
let resyncAt = 0;
let resyncTimer: number | undefined;
export function resyncFromServer(): void {
  const now = Date.now();
  const since = now - resyncAt;
  if (since < RESYNC_MIN_MS) {
    if (resyncTimer === undefined) {
      resyncTimer = window.setTimeout(() => {
        resyncTimer = undefined;
        resyncAt = Date.now();
        pullServerTruth();
      }, RESYNC_MIN_MS - since);
    }
    return;
  }
  resyncAt = now;
  pullServerTruth();
}

function pullServerTruth(): void {
  void refreshBase();
  void refreshStatuses();
  for (const id of messagesBySession.value.keys()) {
    void refreshMessages(id);
    void refreshPermissions(id);
    void refreshQuestions(id);
  }
}

// A restored route (opencode-route meta) or tab may point at a session that
// no longer exists. The paginated list can't judge that, so each is checked
// directly; dead ones bounce home / drop out of the bar. A live one whose
// row sits beyond the list's first page gets its row upserted — that row is
// the tab's title and color, and no event will ever deliver it.
let restoredCheck: Promise<void> | undefined;
function validateRestored(): Promise<void> {
  return (restoredCheck ??= (async () => {
    const r = route.value;
    if (r.view === "session") {
      const row = await fetchSession(r.id);
      if (!row) navigate({ view: "home" });
      else upsertSession(row);
    }
    for (const t of openTabs.value) {
      const row = await fetchSession(t);
      if (!row) closeSessionTab(t);
      else upsertSession(row);
    }
  })());
}

// A new session, now (the toolbar "+", Home's button, the host command):
// the tab is a real one from the click, like a browser's — no reserved
// draft slot. Created untitled so the server names it and re-titles from
// the first prompt. The flag keeps a double-click from making two.
let creatingSession = false;
export async function newSession(): Promise<void> {
  if (creatingSession) return;
  creatingSession = true;
  try {
    const session = await createSession();
    if (!session) {
      setSendError("Could not create the session.");
      return;
    }
    upsertSession(session);
    // Born blank — Home hides it until the first admitted prompt (the
    // server's touch flips time.updated, which alone un-hides).
    blankSessions.value = new Set([...blankSessions.value, session.id]);
    blankChecked.add(session.id);
    navigate({ view: "session", id: session.id });
  } finally {
    creatingSession = false;
  }
}

// Host→app text insertion. The seq bump makes repeated inserts of the same
// text re-fire the composer effect; the app routes home→draft first so the
// composer exists to receive it.
let insertSeq = 0;
export const composerInsert = signal<
  { text: string; seq: number; replace?: boolean } | undefined
>(undefined);

// Files attached via the composer ("+" dialog, paste, drop), sent as file
// parts with the next prompt. Keyed like text drafts (session id, "draft"
// for the home composer) so attachments don't follow you into another tab;
// kept outside the Composer so a draft's attachments survive the session
// it becomes.
interface ComposerFile {
  uri: string;
  name: string;
}

// Composer text drafts, keyed like attachments (session id, "draft" for
// the home composer). They survive the disruptions of panel life: the
// session view remounting on tab switches (the module-level map) and the
// webview itself reloading (localStorage, same-origin — a server port
// change resets it). Lives here so a deleted session's draft can be
// pruned with the rest of its local state.
const DRAFTS_KEY = "opencode.drafts";
const drafts = new Map<string, string>();
try {
  for (const [k, v] of Object.entries(
    JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? "{}") as Record<string, unknown>,
  ))
    if (typeof v === "string") drafts.set(k, v);
} catch {
  drafts.clear();
}
const persistDrafts = () => {
  try {
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(Object.fromEntries(drafts)));
  } catch {}
};
export const getDraft = (k: string): string => drafts.get(k) ?? "";
export const putDraft = (k: string, text: string) => {
  drafts.set(k, text);
  persistDrafts();
};
export const dropDraft = (k: string) => {
  drafts.delete(k);
  persistDrafts();
};

export const composerFiles = signal<Record<string, ComposerFile[]>>({});
export const composerFilesFor = (key: string): ComposerFile[] =>
  composerFiles.value[key] ?? [];
export function addComposerFiles(key: string, files: ComposerFile[]): void {
  composerFiles.value = {
    ...composerFiles.value,
    [key]: [...(composerFiles.value[key] ?? []), ...files],
  };
}
function moveComposerFiles(from: string, to: string): void {
  const src = composerFiles.value[from];
  if (!src?.length) return;
  composerFiles.value = {
    ...composerFiles.value,
    [to]: [...(composerFiles.value[to] ?? []), ...src],
    [from]: [],
  };
}
function clearComposerFiles(key: string): void {
  if (!composerFiles.value[key]?.length) return;
  composerFiles.value = { ...composerFiles.value, [key]: [] };
}

// Hand text to the composer: appended to the draft by default, or swapping
// it whole with `replace` (a revert hands the message back for editing).
export function insertComposerText(text: string, replace = false): void {
  if (route.value.view === "home") navigate({ view: "draft" });
  composerInsert.value = { text, seq: ++insertSeq, replace };
}

// Messages posted from the extension host (AppHost.postMessage).
export function hostMessage(msg: unknown) {
  const m = msg as {
    type?: string;
    text?: string;
    path?: string;
    ids?: unknown;
    files?: unknown;
    modifier?: string;
    enabled?: boolean;
    peers?: unknown;
  };
  // The webview became visible again: events streamed while VS Code had
  // it suspended were lost — pull truth.
  if (m.type === "resync") {
    resyncFromServer();
  }
  if (m.type === "insert-text" && typeof m.text === "string") {
    insertComposerText(m.text);
  }
  // Manage Models ran host-side; the picker re-filters from the new list.
  if (m.type === "hidden-models" && Array.isArray(m.ids)) {
    hiddenModels.value = m.ids.filter((x): x is string => typeof x === "string");
  }
  // Peer registry snapshot (PeerRegistry poll). Replaces the map whole:
  // renames and departures both land as a fresh snapshot.
  if (m.type === "peers" && Array.isArray(m.peers)) {
    const rows: Record<string, { name: string; title: string }> = {};
    for (const p of m.peers) {
      const e = p as { id?: unknown; name?: unknown; title?: unknown };
      if (typeof e.id === "string" && typeof e.name === "string" && e.name)
        rows[e.id] = {
          name: e.name,
          title: typeof e.title === "string" ? e.title : "",
        };
    }
    peerNames.value = rows;
  }
  // The codeCopyModifier setting changed host-side.
  if (m.type === "copy-modifier" && typeof m.modifier === "string") {
    setCopyModifier(m.modifier);
  }
  // The readySound setting changed host-side.
  if (m.type === "ready-sound" && typeof m.enabled === "boolean") {
    setReadySound(m.enabled);
  }
  // The permissionSound setting changed host-side.
  if (m.type === "permission-sound" && typeof m.enabled === "boolean") {
    setPermissionSound(m.enabled);
  }
  // The questionSound setting changed host-side.
  if (m.type === "question-sound" && typeof m.enabled === "boolean") {
    setQuestionSound(m.enabled);
  }
  // Composer "+" (attach): the host open dialog answered. The dialog can't
  // filter by type, so the paste gate applies here — a refused pick is
  // surfaced once rather than sent as a binary blob the endpoint would
  // "read" into the context as raw bytes. The pick lands on whichever
  // composer is on screen (home has none, so anything but a session is
  // the draft).
  if (m.type === "files-picked" && Array.isArray(m.files)) {
    const rows = (m.files as ComposerFile[]).filter(
      (f) => !!f && typeof f.uri === "string",
    );
    const ok = rows.filter((f) => attachMime(f.name ?? "", ""));
    if (ok.length < rows.length)
      setSendError(
        `${rows.length - ok.length} file${
          rows.length - ok.length > 1 ? "s" : ""
        } not attached (unsupported type).`,
      );
    addComposerFiles(
      route.value.view === "session" ? route.value.id : "draft",
      ok,
    );
  }
  if (m.type === "new-session") {
    void newSession();
  }
  // Host command (openContextSummary): toggle the ring's context panel.
  if (m.type === "toggle-context") {
    setPopover(popover.value === "ctx" ? undefined : "ctx");
  }
  // Host navigation targets "/session/{id}"; an id the server doesn't know
  // (when the list is loaded) falls back to Home instead of a dead view.
  if (m.type === "navigate" && typeof m.path === "string") {
    const id = /^\/session\/(.+)$/.exec(m.path)?.[1];
    const known =
      sessions.value.length === 0 || sessions.value.some((s) => s.id === id);
    if (id && known) navigate({ view: "session", id });
    else navigate({ view: "home" });
  }
}

// Fetch the transcript for an opened session, replacing whatever is stored
// (optimistic pending entries included) with server truth. Only the newest
// window renders — the older-page cursor lands in messagesCursor and the
// pre-window remainder in olderPool, both behind "Load older messages".
const loadingMessages = new Set<string>();

// Adopt the server's status map. It is maintained by both prompt paths, so
// it is truth for every session; a stale busy (stream events missed while
// the connection looked healthy) survives tab switches because only
// messages re-pull on mount — this reconciles the map on every remount.
// Mid-turn races are safe: the server publishes session.status on every
// change, so the stream re-establishes busy within one event.
export async function refreshStatuses(): Promise<void> {
  const statuses = await fetchSessionStatus();
  if (!statuses) return;
  sessionStatus.value = statuses;
  // Idle truth retires every echo but a queued turn's (it rides the next
  // turn) and a steered POST's (its row lands with the next turn): a
  // stale echo would pin the session's busy backstop off its row pulls
  // and read as a session frozen until reload.
  for (const [sid, st] of Object.entries(statuses)) {
    if (st.type === "idle" && !hasQueued(sid) && !postedRows.has(sid))
      dropPending(sid);
  }
}

export async function refreshMessages(id: string): Promise<void> {
  if (loadingMessages.has(id)) return;
  loadingMessages.add(id);
  try {
    // The v2 page plus the legacy rows compaction writes (fetchLegacyMessages
    // for why the v2 feed never carries them); the v1 store is unpaged and
    // disjoint, so a merge by id is the whole transcript.
    const [page, legacy] = await Promise.all([
      fetchMessages(id),
      fetchLegacyMessages(id),
    ]);
    // Both failing (server blip) keeps whatever is stored; one failing must
    // not discard the other's rows — the ring and footer read usage off
    // these rows, and a blank map leaves the session showing 0 until the
    // next turn's step-finish.
    if (!page && !legacy) return;
    const merged = new Map((page?.messages ?? []).map((m) => [m.info.id, m]));
    for (const m of legacy ?? []) {
      if (!merged.has(m.info.id)) merged.set(m.info.id, m);
    }
    const sorted = [...merged.values()].sort(byCreated);
    // Local-only rows spliced back in by time: command echoes ("cmd:") have
    // no server row to merge from, and a queued turn's echo ("pending:")
    // outlives the running turn — the remount refresh during it must not
    // drop the message. The pending-retire paths own its removal; the
    // revert fold below applies to them too, so rewinding past a command
    // folds its line.
    const inMemory = messagesBySession.value.get(id) ?? [];
    const knownCmd = new Set(
      inMemory.filter((m) => m.info.id.startsWith("cmd:")).map((m) => m.info.id),
    );
    sorted.push(
      ...inMemory.filter((m) =>
        m.info.id.startsWith("cmd:") || m.info.id.startsWith("pending:"),
      ),
      ...storedCommandRows(id).filter((m) => !knownCmd.has(m.info.id)),
    );
    sorted.sort(byCreated);
    // A pending revert folds the transcript at its marker: the message and
    // everything after hide (the server still serves them until the next
    // prompt commits the cut). A marker pointing nowhere folds nothing.
    const revertID = sessions.value.find((s) => s.id === id)?.revert?.messageID;
    const cut = revertID ? sorted.findIndex((m) => m.info.id === revertID) : -1;
    const all = cut >= 0 ? sorted.slice(0, cut) : sorted;
    // Chunked display: the legacy store is unpaged, so a cold open (VS
    // Code restart, F5) would otherwise render the whole transcript even
    // though the v2 page keeps its cursor. Show only the newest window;
    // rows already on screen stay on screen (the 30s busy refresh must
    // not collapse a view the reader expanded), and the boundary snaps to
    // a turn head so no group renders without its prompt.
    const shownIds = new Set(
      (messagesBySession.value.get(id) ?? []).map((m) => m.info.id),
    );
    let from = Math.max(0, all.length - VIEW_WINDOW);
    while (from > 0 && shownIds.has(all[from - 1].info.id)) from--;
    while (from > 0 && all[from].info.role !== "user") from--;
    const visible = all.slice(from);
    if (from > 0) olderPool.set(id, all.slice(0, from));
    else olderPool.delete(id);
    // The durable copy of an in-flight part lags the stream — the server
    // persists text at part end, so a refresh mid-turn reverts the part to
    // empty and the next deltas rebuild it from the current stream position
    // (fence opener lost, formatting gone until the part lands). Keep
    // whichever copy of each text part carries more.
    const stored = new Map(
      messagesBySession.value.get(id)?.map((m) => [m.info.id, m]) ?? [],
    );
    mutateMessages(id, () =>
      visible.map((m) => {
        const old = stored.get(m.info.id);
        if (!old) return m;
        let merged = false;
        const parts = m.parts.map((p) => {
          const was = old.parts.find((q) => q.id === p.id);
          if (!was || !isText(p) || !isText(was)) return p;
          const longer = (was.text?.length ?? 0) > (p.text?.length ?? 0) ? was : p;
          // The durable copy's type is authoritative; only its text lags.
          // A type disagreement is a live copy created by deltas whose
          // typed full write was lost in an event gap (reconnect): it
          // rendered as answer text — keep the fresher text, take the
          // server's type.
          const keep =
            longer.type === p.type ? longer : { ...longer, type: p.type };
          if (keep !== p) merged = true;
          return keep;
        });
        // Identity survives an unchanged row: MessageView's memo holds and
        // a refresh renders nothing that didn't actually change.
        return merged ? { ...m, parts } : m;
      }),
    );
    const cursors = new Map(messagesCursor.value);
    cursors.set(id, page?.next);
    messagesCursor.value = cursors;
  } finally {
    loadingMessages.delete(id);
  }
}

// The older-page cursor per session (fetchMessages pages newest-first);
// undefined means the transcript is complete. olderPool holds the legacy
// rows held back below the display window (the legacy store is unpaged —
// its whole bulk arrives on every refresh). hasOlder gates the control.
export const messagesCursor = signal<Map<string, string | undefined>>(
  new Map(),
);
const olderPool = new Map<string, ChatMessage[]>();

export function hasOlder(id: string): boolean {
  return (
    messagesCursor.value.get(id) !== undefined ||
    (olderPool.get(id)?.length ?? 0) > 0
  );
}

// Prepend the next older page. Deduped: a live turn can land rows between
// pages, and the cursor may overlap a concurrent refresh. Returns false when
// nothing was added (empty page). A partial page already cleared the cursor
// in fetchMessages — the walk ends there, "Load older messages" with it.
const loadingOlder = new Set<string>();
// Per click. The server caps this between 200 and 400 (limit=400 → 400);
// the default page is 50, too small to walk back through a long session.
const OLDER_PAGE = 100;
// Rows rendered on a cold open, parity with the server's page size.
const VIEW_WINDOW = 50;
export async function loadOlderMessages(id: string): Promise<boolean> {
  if (loadingOlder.has(id)) return false;
  loadingOlder.add(id);
  try {
    const cursor = messagesCursor.value.get(id);
    if (cursor) {
      const page = await fetchMessages(id, cursor, OLDER_PAGE);
      if (page) {
        if (page.messages.length > 0) {
          mutateMessages(id, (list) => {
            const have = new Set(list.map((m) => m.info.id));
            return [
              ...page.messages.filter((m) => !have.has(m.info.id)),
              ...list,
            ];
          });
        }
        const cursors = new Map(messagesCursor.value);
        cursors.set(id, page.next);
        messagesCursor.value = cursors;
        if (page.messages.length > 0) return true;
        // An exhausted cursor can sit over a stocked pool (the endpoint
        // hands out a next cursor past its last v2 row): fall through.
      }
    }
    const pool = olderPool.get(id);
    if (pool && pool.length > 0) {
      const take = pool.splice(Math.max(0, pool.length - OLDER_PAGE));
      if (pool.length === 0) olderPool.delete(id);
      mutateMessages(id, (list) => {
        const have = new Set(list.map((m) => m.info.id));
        return [...take.filter((m) => !have.has(m.info.id)), ...list];
      });
      return true;
    }
    return false;
  } finally {
    loadingOlder.delete(id);
  }
}

let pendingSeq = 0;

// Optimistic user bubble; replaced when the echo event or the next fetch
// lands (by then the server list carries the real message).
function appendPending(id: string, text: string): void {
  const pid = `pending:${++pendingSeq}`;
  const part: Part = {
    id: `${pid}:text`,
    messageID: pid,
    sessionID: id,
    type: "text",
    text,
  };
  mutateMessages(id, (list) => [
    ...list,
    { info: { id: pid, role: "user", time: { created: Date.now() } }, parts: [part] },
  ]);
}

function dropPending(id: string): void {
  const list = messagesBySession.value.get(id);
  if (list?.some((m) => m.info.id.startsWith("pending:"))) {
    mutateMessages(id, (l) => l.filter((m) => !m.info.id.startsWith("pending:")));
  }
}

// A command line's durable echo. The server persists no user row for a
// command run, so this local row IS the transcript's record: never swept
// by the pending-retire paths, spliced back in by refreshMessages, and
// kept in localStorage so it survives a reload. Webview-local by nature:
// another window or machine shows no line.
const cmdStoreKey = (id: string): string => `opencode-cmd-${id}`;

interface StoredCommand {
  cid: string;
  text: string;
  created: number;
}

function storedCommands(id: string): StoredCommand[] {
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(cmdStoreKey(id)) ?? "[]",
    );
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (c): c is StoredCommand =>
        typeof (c as StoredCommand)?.cid === "string" &&
        typeof (c as StoredCommand)?.text === "string" &&
        typeof (c as StoredCommand)?.created === "number",
    );
  } catch {
    return [];
  }
}

function rememberCommand(id: string, row: StoredCommand): void {
  try {
    const all = [...storedCommands(id), row].slice(-50);
    localStorage.setItem(cmdStoreKey(id), JSON.stringify(all));
  } catch {
    // Quota or privacy mode — the echo stays in-memory only.
  }
}

function storedCommandRows(id: string): ChatMessage[] {
  return storedCommands(id).map((c) => ({
    info: { id: c.cid, role: "user", time: { created: c.created } },
    parts: [
      {
        id: `${c.cid}:text`,
        messageID: c.cid,
        sessionID: id,
        type: "text",
        text: c.text,
      },
    ],
  }));
}

function appendCommandEcho(id: string, text: string): void {
  const cid = `cmd:${Date.now()}:${++pendingSeq}`;
  const created = Date.now();
  const part: Part = {
    id: `${cid}:text`,
    messageID: cid,
    sessionID: id,
    type: "text",
    text,
  };
  rememberCommand(id, { cid, text, created });
  mutateMessages(id, (list) => [
    ...list,
    { info: { id: cid, role: "user", time: { created } }, parts: [part] },
  ]);
}

function titleFrom(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= 40 ? flat : flat.slice(0, 40);
}

// Send a prompt. `target` "draft" creates the session first (title from the
// prompt, picker selection riding along) and navigates to it; no draft
// sessions pile up. Composer file attachments ride along as file parts and
// clear once the prompt is accepted.
export async function sendPrompt(
  target: string | "draft",
  text: string,
  files: ComposerFile[] = [],
): Promise<void> {
  const body = text.trim();
  if (!body) return;
  let id: string;
  if (target === "draft") {
    const session = await createSession(titleFrom(body), {
      agent: draftAgent.value,
      model: draftModel.value,
    });
    if (!session) {
      setSendError("Could not create the session.");
      return;
    }
    id = session.id;
    upsertSession(session);
    draftAgent.value = undefined;
    draftModel.value = undefined;
  } else {
    id = target;
  }
  setSendError(undefined);
  // The pending echo shows either way: a held turn's runs when the flush
  // watcher below picks it up, a steered one swaps for the server's row.
  appendPending(id, body);
  if (target === "draft") {
    moveComposerFiles("draft", id);
    navigate({ view: "session", id });
  }
  const wasBusy = (sessionStatus.value[id]?.type ?? "idle") !== "idle";
  if (wasBusy && hasQueued(id)) {
    queuedTurns.value = [
      ...queuedTurns.value,
      { id, kind: "prompt", text: body, files },
    ];
    return;
  }
  // Busy with nothing held ahead: the prompt POSTs now and the server
  // hands it to the model at the next step boundary — ongoing work stays
  // steerable. Behind held turns it must wait above, or it would jump
  // the queue.
  await postPrompt(id, body, files);
}

// POST a prompt and adopt its turn: optimistic busy, the model/agent
// riding along explicitly (prompt_async's own default resolution can land
// on a model the account can't run), and the 2.5s status adoption for a
// turn that dies before its first step. The pending echo is already on
// screen — appended at submit.
async function postPrompt(
  id: string,
  body: string,
  files: ComposerFile[],
): Promise<void> {
  sessionStatus.value = { ...sessionStatus.value, [id]: { type: "busy" } };
  // Mention tokens resolve against the session's directory (the server-side
  // file host of the parts); a draft has only the workspace folder.
  const base =
    sessions.value.find((s) => s.id === id)?.location?.directory ||
    currentDir.value ||
    "";
  const parts = [
    { type: "text" as const, text: body },
    ...attachmentParts(files),
    ...parseMentions(
      body,
      base,
      agents.value
        .filter((a) => !a.hidden && a.mode !== "primary")
        .map((a) => a.name),
    ),
  ];
  const sel = currentSelection(id);
  if (!(await promptSession(id, parts, sel.agent, sel.model))) {
    dropPending(id);
    sessionStatus.value = { ...sessionStatus.value, [id]: { type: "idle" } };
    setSendError("The message could not be sent.");
  } else {
    clearComposerFiles(id);
    // Its user row hasn't landed yet — the ghost watch must not mistake
    // it for a ghost once a stop wipes the echo (see postedRows).
    postedRows.set(id, (postedRows.get(id) ?? 0) + 1);
    // The send commits a pending revert: the server truncates the store at
    // the marker and clears it — drop the local copy so the fold lifts.
    patchSession(id, (s) => ({ ...s, revert: undefined }));
    // prompt_async returns before any row exists — the user row arrives on
    // the v1 stream (message.updated) and swaps out the optimistic echo.
    // A turn that dies before its first step (e.g. an unavailable model)
    // emits nothing but session.error — adopt the server's status map and
    // pull rows once anyway, so optimistic state can't stick.
    setTimeout(() => {
      void fetchSessionStatus().then((map) => {
        if (map) {
          sessionStatus.value = {
            ...sessionStatus.value,
            [id]: map[id] ?? { type: "idle" },
          };
        }
      });
      if (messagesBySession.value.get(id)?.some((m) => m.info.id.startsWith("pending:")))
        void refreshMessages(id);
    }, 2500);
  }
}

// /compact — intercepted here, not sent to the server: there is no compact
// command behind /command; compaction is a direct call to the summarize
// endpoint, what the TUI's /compact runs. It folds the history into an AI
// summary written by the session's current model, freeing the context.
// Needs a session with turns, and an idle one — it runs a turn of its own.
async function runCompact(target: string | "draft", echoed = false): Promise<void> {
  if (target === "draft") {
    setSendError("Nothing to compact yet — send a message first.");
    return;
  }
  // A session with no real turn has nothing to keep, and summarizing it
  // anyway writes an all-"(none)" summary the next turns choke on — gate on
  // an actual assistant answer (compaction rows don't count).
  if (
    !(messagesBySession.value.get(target) ?? []).some(
      (m) => m.info.role === "assistant" && m.info.agent !== "compaction",
    )
  ) {
    setSendError("Nothing to compact yet — send a message first.");
    return;
  }
  if ((sessionStatus.value[target]?.type ?? "idle") !== "idle") {
    setSendError("Wait for the running turn to finish.");
    return;
  }
  // The model that writes the summary: the session's pick, else the model
  // of its last turn (the context ring's chain).
  const session = sessions.value.find((s) => s.id === target);
  const last = [...(messagesBySession.value.get(target) ?? [])]
    .reverse()
    .find((m) => m.info.providerID && m.info.modelID);
  const model =
    session?.model ??
    (last
      ? { providerID: last.info.providerID!, id: last.info.modelID! }
      : undefined);
  if (!model?.providerID || !model.id) {
    setSendError("No model set to compact with.");
    return;
  }
  setSendError(undefined);
  sessionStatus.value = { ...sessionStatus.value, [target]: { type: "busy" } };
  // The command shows as a sent message (Claude Code); the compaction
  // trigger row the server creates retires it on the stream. A queued
  // /compact already appended its echo when it was queued.
  if (!echoed) appendPending(target, "/compact");
  const ok = await compactSession(target, model.providerID, model.id);
  sessionStatus.value = { ...sessionStatus.value, [target]: { type: "idle" } };
  if (!ok) {
    dropPending(target);
    setSendError("The session could not be compacted.");
    return;
  }
  // The summarize POST resolves once the summary turn is done (the server
  // awaits its loop) — the summary itself already streamed over /event.
  // This refresh picks up the trigger + summary rows' durable truth.
  await refreshMessages(target);
}

// Run a "/name args..." composer line. A draft is created first — commands
// need a session to run in. `echoed` marks a queued command whose pending
// bubble was appended when it was queued; appending again would show the
// line twice until the refresh retires both.
export async function runSlashCommand(
  target: string | "draft",
  text: string,
  echoed = false,
): Promise<void> {
  const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  const name = m?.[1];
  if (!name) return;
  if (name === "compact") {
    await runCompact(target, echoed);
    return;
  }
  if (!commands.value.some((c) => c.name === name)) {
    setSendError(`Unknown command /${name}.`);
    return;
  }
  let id = target;
  if (target === "draft") {
    const session = await createSession(`/${name}`, {
      agent: draftAgent.value,
      model: draftModel.value,
    });
    if (!session) {
      setSendError("Could not create the session.");
      return;
    }
    id = session.id;
    upsertSession(session);
    draftAgent.value = undefined;
    draftModel.value = undefined;
    navigate({ view: "session", id });
  }
  setSendError(undefined);
  // Every command shows as a sent message (Claude Code) — /compact's echo
  // is appended inside runCompact, the rest here (durable: the server
  // writes no user row for a command run).
  if (name !== "compact" && !echoed) appendCommandEcho(id, text.trim());
  // The command must run on what the session is on — a bare command turn
  // would otherwise rewrite the row (agent back to build, effort to
  // default). The draft just became a session carrying its preset.
  if (!(await runCommand(id, name, m?.[2] ?? "", currentSelection(id)))) {
    // The call can fail while the command's turn still runs server-side
    // (relay abort, server churn): status decides. Busy keeps the echo —
    // idle truth retires it and the stream delivers the rows — instead of
    // reporting a failure the running turn would contradict.
    const map = await fetchSessionStatus();
    if (map?.[id]?.type === "busy") return;
    // The failure read idle truth — retire the optimistic busy the flush
    // (or the draft create's) path left behind.
    sessionStatus.value = { ...sessionStatus.value, [id]: { type: "idle" } };
    dropPending(id);
    setSendError(`The command /${name} could not be run.`);
  } else {
    // The command turn's rows land in the legacy store; pull the durable
    // truth (the stream already projected the live parts), then retire the
    // echo if the command wrote no user row of its own.
    await refreshMessages(id);
    dropPending(id);
  }
}

// Fire queued turns head-first as their sessions idle. Tracks both
// signals, so any writer lands here — stream events, setIdle, a wholesale
// refreshStatuses adoption, or the queue itself. The optimistic busy flip
// holds the next entry back: its turn takes a beat to surface on the
// stream, and the gap would fire it into the same idle window.
effect(() => {
  const hit = queuedTurns.value.find(
    (q) => (sessionStatus.value[q.id]?.type ?? "idle") === "idle",
  );
  if (!hit) return;
  queuedTurns.value = queuedTurns.value.filter((q) => q !== hit);
  sessionStatus.value = {
    ...sessionStatus.value,
    [hit.id]: { type: "busy" },
  };
  if (hit.kind === "command") void runSlashCommand(hit.id, hit.text, true);
  else void postPrompt(hit.id, hit.text, hit.files ?? []);
});

// Permission docks. Request ids this client answered; a session-open fetch
// already in flight must not re-dock one of them (same race as questions).
const settledPermissions = new Map<string, number>();

// Settled ask/question ids only guard fetches in flight — the reply event
// retires the row long before this passes — so they expire on insert
// instead of growing forever.
const SETTLED_TTL_MS = 60_000;
function markSettled(map: Map<string, number>, id: string): void {
  const cutoff = Date.now() - SETTLED_TTL_MS;
  for (const [k, t] of map) if (t < cutoff) map.delete(k);
  map.set(id, Date.now());
}

// One session's pending asks, merged in: the open view's dock uses this to
// discover an ask made while the page was closed or reloaded. Both
// pipelines: the v2 per-session route, plus the v1 global list (which the
// v2 route never includes). Each list is authoritative only for its own
// pipeline: a docked ask survives unless ITS pipeline's list loaded and no
// longer carries it (1.18.30 serves tool asks on /permission only — the
// /api per-session list is structurally empty there, so treating a fetched
// empty list as truth would wipe every live ask on session open and lock
// the turn behind it).
export async function refreshPermissions(id: string): Promise<void> {
  const [fresh, legacy] = await Promise.all([
    fetchSessionPermissions(id),
    fetchPendingPermissions(),
  ]);
  if (!fresh && !legacy) return;
  const keep = pendingPermissions.value.filter(
    (p) =>
      p.sessionID !== id ||
      (p.v1 === true ? legacy === undefined : fresh === undefined),
  );
  const known = new Set(keep.map((p) => p.id));
  pendingPermissions.value = [
    ...keep,
    ...(fresh ?? []).filter((p) => !settledPermissions.has(p.id) && !known.has(p.id)),
    ...(legacy ?? [])
      .filter((p) => p.sessionID === id)
      .filter((p) => !settledPermissions.has(p.id) && !known.has(p.id)),
  ];
}

// Optimistically drop the entry; the replied event (or a failed call's
// refetch) settles the truth.
export async function answerPermission(
  sessionID: string,
  id: string,
  reply: "once" | "always" | "reject",
  message?: string,
): Promise<void> {
  const ask = pendingPermissions.value.find((p) => p.id === id);
  const done = ask?.v1
    ? replyPermissionV1(id, reply, message)
    : replyPermission(sessionID, id, reply, message);
  markSettled(settledPermissions, id);
  pendingPermissions.value = pendingPermissions.value.filter(
    (p) => p.id !== id,
  );
  if (!(await done)) {
    settledPermissions.delete(id);
    setSendError("The permission reply was rejected by the server.");
    await refreshPermissions(sessionID);
  }
}

// Request ids this client answered or dismissed. A session-open fetch that
// was already in flight must not re-dock one of them (the server list still
// carries the request until the reply event lands).
const settledQuestions = new Map<string, number>();

// One session's pending questions, merged in: the open view's dock uses
// this to discover a question asked while the page was closed or reloaded.
// Same pipeline-scoped authority as refreshPermissions: an ask retires only
// when its own pipeline's list loaded without it.
export async function refreshQuestions(id: string): Promise<void> {
  const fresh = await fetchSessionQuestions(id);
  if (!fresh) return;
  const keep = pendingQuestions.value.filter(
    (q) =>
      q.sessionID !== id ||
      (q.v1 === true ? !fresh.globalLoaded : !fresh.v2Loaded),
  );
  const known = new Set(keep.map((q) => q.id));
  pendingQuestions.value = [
    ...keep,
    ...fresh.rows.filter((q) => !settledQuestions.has(q.id) && !known.has(q.id)),
  ];
}

export async function answerQuestion(
  sessionID: string,
  id: string,
  answers: string[][],
  v1 = false,
): Promise<void> {
  const done = replyQuestion(sessionID, id, answers, v1);
  markSettled(settledQuestions, id);
  pendingQuestions.value = pendingQuestions.value.filter((q) => q.id !== id);
  if (!(await done)) {
    settledQuestions.delete(id);
    setSendError("The answer was rejected by the server.");
    await refreshQuestions(sessionID);
  }
}

export async function dismissQuestion(
  sessionID: string,
  id: string,
  v1 = false,
): Promise<void> {
  const done = rejectQuestion(sessionID, id, v1);
  markSettled(settledQuestions, id);
  pendingQuestions.value = pendingQuestions.value.filter((q) => q.id !== id);
  if (!(await done)) {
    settledQuestions.delete(id);
    setSendError("The question could not be dismissed.");
    await refreshQuestions(sessionID);
  }
}

// The turn is over but the stream will not say so (user stop, or a
// rejection that aborted it — the tool failure arrives, then silence, no
// step.ended). Flip the composer back and retire the prompt: it stays the
// newest visible row (any empty step row it spawned is filtered out), and
// the awaiting placeholder must not pulse over a turn the user ended.
// The session's newest prompt row, or undefined.
function lastUserPrompt(id: string): ChatMessage | undefined {
  return [...(messagesBySession.value.get(id) ?? [])]
    .reverse()
    .find((m) => m.info.role === "user");
}

// An explicit stop marks the turn for the transcript's "Interrupted"
// marker and takes the awaiting gate. Runs before the abort POST
// resolves: the server's own session.error ("Aborted") races it.
function markStoppedTurn(id: string): void {
  const pid = lastUserPrompt(id)?.info.id;
  if (pid) markPromptStopped(pid);
}

// Re-marks a stopped turn from the durable record: Session calls this for
// abort receipts found in a (re)loaded transcript, since the client-side
// marks die with the view.
export function markPromptStopped(pid: string): void {
  // Already marked — the Session effect re-runs this on every streaming
  // batch; the write churns two signals for nothing.
  if (interruptedPrompts.value.has(pid) && stoppedPrompts.value.has(pid))
    return;
  interruptedPrompts.value = new Set([...interruptedPrompts.value, pid]);
  stoppedPrompts.value = new Set([...stoppedPrompts.value, pid]);
}

function unmarkStoppedTurn(id: string): void {
  const pid = lastUserPrompt(id)?.info.id;
  if (!pid) return;
  interruptedPrompts.value = new Set(
    [...interruptedPrompts.value].filter((s) => s !== pid),
  );
  stoppedPrompts.value = new Set(
    [...stoppedPrompts.value].filter((s) => s !== pid),
  );
}

function retireTurn(id: string, stopped = false): void {
  cancelIdle(id);
  cancelRing(id);
  // A stop drops the turns queued behind this one — held prompts would
  // otherwise fire right after the abort (observed: the row stayed, an
  // answer to a message the user had cancelled).
  dropQueued(id);
  sessionStatus.value = { ...sessionStatus.value, [id]: { type: "idle" } };
  const last = lastUserPrompt(id);
  if (last) {
    // The reject paths retire the turn too, but their failed tool part
    // tells that story — only an explicit stop marks it, and stopSession
    // has already run that mark by now (the call below no-ops unless a
    // new prompt row landed mid-abort).
    if (stopped) markStoppedTurn(id);
    else
      interruptedPrompts.value = new Set([
        ...interruptedPrompts.value,
        last.info.id,
      ]);
  }
}

export async function stopSession(id: string): Promise<void> {
  // Mark before the POST: the abort's own session.error races this
  // request's resolution and must find the mark already set.
  markStoppedTurn(id);
  if (!(await interruptSession(id))) {
    unmarkStoppedTurn(id);
    setSendError("Could not interrupt the session.");
    return;
  }
  // Nothing on the event stream announces an aborted turn — flip the
  // composer back now; a still-queued turn re-sets busy on its next step.
  retireTurn(id, true);
  // Dropped holds leave no echo, and a steered prompt's un-landed row
  // must read as a ghost now, not as ours.
  clearPending(id);
  postedRows.delete(id);
  // A steered prompt still sitting in the server's queue fires as a ghost
  // turn next; the watch aborts it when its row arrives.
  armGhostWatch(id);
}
