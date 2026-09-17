// Typed API access for the webview app, relayed through the extension host
// (AppHost): the webview origin is opaque, so the server's CORS would block
// every direct call — the app posts {type:"api-request"} and the host
// answers {type:"api-result"}. Shapes reflect the live server (CLI
// 1.18.25); v2 answers unknown paths with 200 + SPA HTML, so the host only
// reports a body as `json` when its content-type is application/json.
import { postToHost } from "./host";

// Row of GET /api/session.
export interface Session {
  id: string;
  title: string;
  cost: number;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
  time: { created: number; updated: number };
  location: { directory: string };
  // Set once an agent/model switch happened (POST /api/session/{id}/agent|
  // model); absent means the session still runs on its defaults.
  agent?: string;
  model?: { id: string; providerID: string; variant?: string };
  // Sub-agent sessions only: the session whose task tool spawned them.
  // They stay out of Home's lists — the transcript's chip is the way in.
  parentID?: string;
  // Pending revert marker: the transcript folds at this message (it and
  // everything after hide) until the next prompt commits the cut — the
  // server keeps serving the rows until then.
  revert?: { messageID: string };
}

// Value of the GET /session/status map (sessionID → status).
export type SessionStatus =
  | { type: "idle" }
  | { type: "busy" }
  | { type: "retry"; attempt: number; message: string; next: number };

// GET /provider. `default` is a lookup map, never rendered. Only the model
// `limit` is read (context-window size for the ring).
export interface Providers {
  all: {
    id: string;
    name: string;
    models: Record<
      string,
      {
        // Display name ("GLM-5.3-Flash") and reasoning-effort variants
        // (keys only) for chips/pickers; `limit` feeds the context ring.
        name?: string;
        variants?: Record<string, unknown>;
        limit?: { context?: number };
      }
    >;
  }[];
  default: Record<string, string>;
  connected: string[];
}

// One relay round-trip: post the request, resolve on the matching reply.
// The host always answers — any relay/fetch failure replies {ok:false} —
// so the promise never hangs or rejects.
interface ApiResult {
  ok: boolean;
  json?: unknown;
}

const pending = new Map<number, (r: ApiResult) => void>();
let nextRequestId = 0;

function apiRequest(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  timeoutMs?: number,
): Promise<ApiResult> {
  return new Promise((resolve) => {
    const id = ++nextRequestId;
    pending.set(id, resolve);
    postToHost({
      type: "api-request",
      id,
      method,
      path,
      ...(body !== undefined ? { body } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  });
}

window.addEventListener("message", (e: MessageEvent) => {
  const m = e.data as {
    type?: string;
    id?: number;
    ok?: boolean;
    json?: unknown;
  };
  if (m?.type !== "api-result" || typeof m.id !== "number") return;
  const resolve = pending.get(m.id);
  if (!resolve) return;
  pending.delete(m.id);
  resolve({ ok: m.ok === true, json: m.json });
});

// GET JSON or nothing: a non-JSON 200 body (v2 SPA fallback) is a failure,
// not data.
async function getJson<T>(path: string): Promise<T | undefined> {
  const res = await apiRequest("GET", path);
  if (!res.ok || res.json === undefined) return undefined;
  return res.json as T;
}

export interface SessionPage {
  sessions: Session[];
  // Cursor for the next (older) page, when more exist.
  next?: string;
}

// GET /api/session — newest first, paginated ({data, cursor} envelope).
export async function fetchSessions(
  cursor?: string,
): Promise<SessionPage | undefined> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  const body = await getJson<{
    data?: Session[];
    cursor?: { next?: string };
  }>(`/api/session${query}`);
  if (!body) return undefined;
  return { sessions: body.data ?? [], next: body.cursor?.next };
}

// GET /session/status — the sessionID → status map.
export async function fetchSessionStatus(): Promise<
  Record<string, SessionStatus> | undefined
> {
  return getJson<Record<string, SessionStatus>>("/session/status");
}

export async function fetchProviders(): Promise<Providers | undefined> {
  return getJson<Providers>("/provider");
}

// GET /config — the default model ("providerID/modelID", so a draft with no
// explicit pick can show what a prompt would run on) and the user's provider
// blocks (the ids the model picker may list).
export interface ServerConfig {
  model?: string;
  provider?: Record<string, unknown>;
}

export async function fetchConfig(): Promise<ServerConfig | undefined> {
  return getJson<ServerConfig>("/config");
}

// GET /agent — flat array; the key is `name`. Only mode:"primary" agents
// take the composer's turn; hidden ones (compaction, summary, title) are
// bookkeeping.
export interface Agent {
  name: string;
  description?: string;
  mode: "primary" | "subagent" | "all";
  hidden?: boolean;
  native?: boolean;
}

export async function fetchAgents(): Promise<Agent[] | undefined> {
  return getJson<Agent[]>("/agent");
}

// GET /command — user-defined commands (command/mcp/skill sources).
export interface Command {
  name: string;
  description?: string;
}

export async function fetchCommands(): Promise<Command[] | undefined> {
  return getJson<Command[]>("/command");
}

// A permission ask (v2 dialect). The tool asserts its action and the
// resource it touches — for bash the whole command line — and `save` lists
// the resources an "always" reply would remember; empty → once/reject only.
export interface PermissionRequest {
  id: string;
  sessionID: string;
  action: string;
  resources: string[];
  save: string[];
  source?: { type: "tool"; messageID: string; callID: string };
  // True for asks discovered through the v1 pipeline (permission.asked on
  // /event, the global GET /permission list) — those reply on /permission;
  // the v2 per-session route rejects them.
  v1?: boolean;
}

// Map a raw ask onto PermissionRequest. The pipelines name the same facts
// differently: v1 permission/patterns/always (+ `tool`), v2
// action/resources/save (+ `source`).
export function normalizePermission(
  raw: PermissionRequest & {
    permission?: string;
    patterns?: string[];
    always?: string[];
    tool?: { messageID: string; callID: string };
  },
  v1: boolean,
): PermissionRequest {
  return {
    id: raw.id,
    sessionID: raw.sessionID,
    action: v1 ? (raw.permission ?? raw.action) : raw.action,
    resources: v1 ? (raw.patterns ?? []) : raw.resources,
    save: v1 ? (raw.always ?? []) : raw.save,
    source:
      v1 && raw.tool
        ? { type: "tool", messageID: raw.tool.messageID, callID: raw.tool.callID }
        : raw.source,
    v1: v1 || raw.v1 === true,
  };
}

// GET /api/session/{id}/permission — one session's pending asks. The v1
// global /permission list stays empty (v2 only), so pending asks are
// discovered per session, on open.
export async function fetchSessionPermissions(
  id: string,
): Promise<PermissionRequest[] | undefined> {
  const body = await getJson<{ data?: PermissionRequest[] }>(
    `/api/session/${id}/permission`,
  );
  return body?.data;
}

// GET /permission — the v1 pipeline's pending asks, across all sessions (the
// v2 route above never lists them). Asks made while the page was closed are
// recovered from here.
export async function fetchPendingPermissions(): Promise<
  PermissionRequest[] | undefined
> {
  const body = await getJson<
    (PermissionRequest & { permission?: string; patterns?: string[]; always?: string[] })[]
  >("/permission");
  return body ? body.map((r) => normalizePermission(r, true)) : undefined;
}

// GET /question — every session's pending questions.
export interface QuestionInfo {
  question: string;
  header: string;
  options: { label: string; description?: string }[];
  multiple?: boolean;
  // Absent means true (server 1.18.29 omits it from model asks); only an
  // explicit false — builtin asks like plan_exit — hides the free-text row.
  custom?: boolean;
}

export interface QuestionRequest {
  id: string;
  sessionID: string;
  questions: QuestionInfo[];
  // Which pipeline holds the ask — it decides the reply route. A v1 turn's
  // question tool lists only on the global GET /question and answers on the
  // global /question/{id}/reply; a v2 ask lists on /api/session/{id}/question
  // and answers on the /api route. The other route 404s (QuestionNotFoundError).
  v1?: boolean;
}

// Pending questions for one session, both pipelines merged: the v2
// per-session route plus the global /question list (v1 asks; the /api route
// returns [] for them — wire-verified 1.18.25). The /api copy wins on an id
// collision, so a v2 ask that shows up in both keeps the v2 reply route.
// Which of the two lists actually loaded rides along: a refresh may only
// retire an ask its own pipeline's list confirmed absent.
export interface SessionQuestions {
  rows: QuestionRequest[];
  v2Loaded: boolean;
  globalLoaded: boolean;
}
export async function fetchSessionQuestions(
  id: string,
): Promise<SessionQuestions | undefined> {
  const [v2, global] = await Promise.all([
    getJson<{ data?: QuestionRequest[] }>(`/api/session/${id}/question`),
    getJson<QuestionRequest[]>("/question"),
  ]);
  if (v2 === undefined && global === undefined) return undefined;
  const v2Rows = (v2?.data ?? []).map((q) => ({ ...q, v1: false }));
  const seen = new Set(v2Rows.map((q) => q.id));
  const v1Rows = (global ?? [])
    .filter((q) => q.sessionID === id && !seen.has(q.id))
    .map((q) => ({ ...q, v1: true }));
  return {
    rows: [...v2Rows, ...v1Rows],
    v2Loaded: v2 !== undefined,
    globalLoaded: global !== undefined,
  };
}

// Chat message. Only the fields the UI reads; the server sends more.
// Assistant messages carry the turn's usage (cost + token classes) and the
// model that ran (providerID/modelID) — the ring's context fill derives
// from the latest of them.
export interface Message {
  id: string;
  role: "user" | "assistant";
  time: { created: number; completed?: number };
  error?: { name: string; data?: { message?: string } };
  providerID?: string;
  modelID?: string;
  // The agent that ran the turn ("build", "plan") and the message this one
  // answers — assistant messages of one turn share the user's id as parent.
  agent?: string;
  parentID?: string;
  cost?: number;
  tokens?: MessageTokens;
  // Text chars already covered by `tokens` — stamped at each step boundary
  // (store) and on fetch. The turn footer's streamed-tail estimate is the
  // chars beyond it, so a multi-step message keeps counting while its later
  // steps stream (usage for them lands only at their step end).
  reportedChars?: number;
}

export interface MessageTokens {
  total?: number;
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}

// Summed usage. Zero is not a measurement: the endpoint announces rows and
// steps with all-zero tokens before their real numbers exist, and storing
// the zero tells the turn footer the row is already counted — its streamed
// tail estimate then stops, and count and rate vanish for the whole step.
// The server precomputes `total` on message rows; step events don't.
export function tokensTotal(t?: MessageTokens): number {
  if (!t) return 0;
  return t.total ?? t.input + t.output + t.reasoning + t.cache.read + t.cache.write;
}

// Part of a message. Shapes read off the live server (CLI 1.18.x): tool
// parts carry `tool` plus a `state` machine
// (status/input/output/title/metadata/error/time). Text-ish parts carry
// `text`; step-start/step-finish are model-loop bookkeeping.
interface PartBase {
  id: string;
  type: string;
  messageID: string;
  sessionID: string;
}

export interface TextPart extends PartBase {
  type: "text" | "reasoning";
  text?: string;
  // Server-injected context, not the user's words: the endpoint's image
  // emulation for non-vision models ("Called the Read tool…" plus the raw
  // file bytes). Never rendered in the transcript.
  synthetic?: boolean;
  // opencode-plugin-peers tags its injections synthetic too, but carries
  // the sender in metadata.peerMessage — those we DO render (peer card).
  metadata?: Record<string, unknown>;
  // Reasoning parts carry the thinking window (server-sourced on fetch,
  // stamped from stream events live); text parts don't.
  time?: { start?: number; end?: number };
}

export interface ToolState {
  status: "pending" | "running" | "completed" | "error";
  input?: Record<string, unknown>;
  output?: string;
  title?: string;
  // The machine-readable result, present in BOTH dialects (live SSE
  // tool.success and durable rows): edit/apply_patch carry unified patch
  // strings in structured.files[], todowrite the todo rows, write the
  // operation facts. The OUT text lives in output/content instead.
  structured?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  error?: string;
  // Durable completed rows carry the result as content text items (the live
  // stream instead carries a `result` string, mapped to output by the
  // projector); fetchMessages folds these into output.
  content?: { type: string; text?: string }[];
  time?: { start?: number; end?: number };
}

export interface ToolPart extends PartBase {
  type: "tool";
  tool: string;
  state?: ToolState;
}

// Attachments (composer paste/drop/+, data-URI url) and @-mentions (file://
// url, `source` pointing back at the "@path" text).
export interface FilePart extends PartBase {
  type: "file";
  mime?: string;
  url?: string;
  filename?: string;
}

// `type` stays open (step-start, file, agent, ...) so unseen kinds degrade
// to PartBase instead of breaking the union.
export type Part = TextPart | ToolPart | FilePart | PartBase;

export const isText = (p: Part): p is TextPart =>
  p.type === "text" || p.type === "reasoning";
export const isTool = (p: Part): p is ToolPart => p.type === "tool";

// Tool ids arrive as schema names ("bash"); the row shows the friendly label.
// Only the ids whose capitalization wouldn't read right on its own — read,
// glob, grep, edit, write, list, skill, question, task label themselves.
const TOOL_NAMES: Record<string, string> = {
  bash: "Shell",
  apply_patch: "Patch",
  webfetch: "Fetch",
  websearch: "Web Search",
  todowrite: "Todo",
  todoread: "Todo",
};

export function toolName(tool: string): string {
  const known = TOOL_NAMES[tool];
  if (known) return known;
  return tool.charAt(0).toUpperCase() + tool.slice(1);
}

// Part text is display-only — the server keeps the durable copy — so giant
// parts (multi-MB tool dumps) clamp to head + marker + tail before they
// enter state: one multi-MB part arriving in every open window at once is
// an allocation spike and a boot render that kills the renderer. Once a
// part clamps, its id is tracked and further stream deltas for it are
// dropped (never re-grow past the cap).
export const PART_TEXT_CAP = 1_048_576;
const PART_TEXT_HEAD = 524_288;
const PART_TEXT_TAIL = 65_536;
const truncatedParts = new Set<string>();

export function clampPartText(partID: string, text: string): string {
  if (text.length <= PART_TEXT_CAP) return text;
  truncatedParts.add(partID);
  return (
    text.slice(0, PART_TEXT_HEAD) +
    `\n\n[… truncated for display — ${text.length} chars total …]\n\n` +
    text.slice(-PART_TEXT_TAIL)
  );
}

// Tool outputs render beside text rows and update as whole strings on the
// stream — same clamp, same tracker.
export const clampToolOutput = (partID: string, output: string): string =>
  clampPartText(partID, output);

export const isTruncatedPart = (partID: string): boolean =>
  truncatedParts.has(partID);

export function forgetTruncatedParts(partIDs: Iterable<string>): void {
  for (const id of partIDs) truncatedParts.delete(id);
}

// Row of GET /session/{id}/message.
export interface MessageWithParts {
  info: Message;
  parts: Part[];
}

// Row of GET /api/session/{id}/message (v2). Assistant rows carry their
// parts in `content` (fields the SSE part events add — messageID/sessionID
// and sometimes the part id — are row-level or absent here); user rows carry
// the prompt as a bare `text`. Rows have no `role` (it's `type`) and no
// `parentID` (the preceding user row IS the parent). `system` rows are
// server-injected context notes ("Today's date is now …") — filtered out
// below: they are not conversation, and a row between the prompt and the
// reply would split the turn.
interface V2MessageRow {
  id: string;
  type: "user" | "assistant" | "system";
  time: { created: number; completed?: number };
  text?: string;
  content?: { type: string; id?: string }[];
  agent?: string;
  model?: { id?: string; providerID?: string };
  cost?: number;
  tokens?: MessageTokens;
  error?: { name: string; data?: { message?: string } };
}

// GET /api/session/{id}/message (v2) — {data, cursor}, newest first. The v1
// /session/{id}/message returns [] on CLI 1.18.x (legacy store gone), so
// rows are mapped into the {info, parts} the SSE message events also speak.
// Tool and step failures stringify whatever the server sent (live SSE and
// durable rows carry it as an object).
export function stringifyError(error: unknown): string {
  if (typeof error === "string") return error;
  const m = error as { message?: string; data?: { message?: string } };
  return m?.data?.message ?? m?.message ?? "The tool failed.";
}

export interface MessagePage {
  messages: MessageWithParts[];
  // Cursor to the next (older) page — only when the page came back FULL.
  // The endpoint reports a cursor on every non-empty page, even the
  // exhausted one (it points at the oldest row just returned), so a short
  // page is the only real "no more messages" signal.
  next?: string;
}

// The default page size (the server's own). A page shorter than this
// proves the transcript is complete.
const MESSAGE_PAGE = 50;

export async function fetchMessages(
  id: string,
  cursor?: string,
  limit?: number,
): Promise<MessagePage | undefined> {
  const size = limit ?? MESSAGE_PAGE;
  const params = new URLSearchParams();
  if (cursor) {
    params.set("cursor", cursor);
    params.set("direction", "next");
  }
  params.set("limit", String(size));
  const query = `?${params}`;
  const body = await getJson<{
    data?: V2MessageRow[];
    cursor?: { next?: string };
  }>(`/api/session/${id}/message${query}`);
  if (!body) return undefined;
  const rows = [...(body.data ?? [])].sort(
    (a, b) => a.time.created - b.time.created,
  );
  let parent: string | undefined;
  const messages = rows
    .filter(
      (r): r is V2MessageRow & { type: "user" | "assistant" } =>
        r.type === "user" || r.type === "assistant",
    )
    .map((r) => {
    if (r.type === "user") parent = r.id;
    const parts: Part[] =
      r.type === "user"
        ? [
            {
              id: `${r.id}:text`,
              messageID: r.id,
              sessionID: id,
              type: "text",
              text: clampPartText(`${r.id}:text`, r.text ?? ""),
            },
          ]
        : (r.content ?? []).map((c, i) => ({
            ...c,
            // Durable rows name tools `name`; the SSE dialect the UI speaks
            // (and ToolPart declares) uses `tool`.
            ...((c as { type?: string }).type === "tool" &&
            (c as { tool?: string }).tool === undefined
              ? { tool: (c as { name?: string }).name }
              : {}),
            // Durable reasoning parts name the thinking window
            // {created, completed}; the live path stamps {start, end} —
            // normalize to one shape here.
            ...((c as { type?: string }).type === "reasoning" &&
            (c as { time?: { created?: number; completed?: number } }).time
              ? {
                  time: {
                    start: (c as { time?: { created?: number } }).time?.created,
                    end: (c as { time?: { completed?: number } }).time
                      ?.completed,
                  },
                }
              : {}),
            id: c.id ?? `${r.id}:${i}`,
            messageID: r.id,
            sessionID: id,
          })) as Part[];
    // Durable rows keep a tool's failure as the raw {type, message} object;
    // the live SSE path stores it stringified. Normalize on fetch so the
    // failure text (e.g. "Tool execution interrupted") survives a reload.
    for (const p of parts) {
      if (isText(p) && typeof p.text === "string")
        p.text = clampPartText(p.id, p.text);
      if (!isTool(p) || !p.state) continue;
      // A durable completed tool has no output string — its result lives in
      // content text items. Fold them in so a reload keeps the transcript's
      // outputs (the tool body's OUT row reads this).
      const texts = (p.state.content ?? [])
        .map((c) => c.text ?? "")
        .filter(Boolean);
      if (!p.state.output && texts.length > 0)
        p.state.output = texts.join("\n");
      if (typeof p.state.output === "string")
        p.state.output = clampToolOutput(p.id, p.state.output);
      // A row that never ran keeps its input as the JSON text the stream
      // was writing when the turn died; the live dialect serves the object.
      const raw = p.state.input as unknown;
      if (typeof raw === "string" && raw) {
        try {
          p.state = { ...p.state, input: JSON.parse(raw) };
        } catch {
          // Partial JSON — the pill falls back to the title.
        }
      }
      if (typeof p.state.error === "object" && p.state.error !== null) {
        p.state = { ...p.state, error: stringifyError(p.state.error) };
      }
    }
    const info: Message = {
      id: r.id,
      role: r.type,
      time: r.time,
      agent: r.agent,
      providerID: r.model?.providerID,
      modelID: r.model?.id,
      cost: r.cost,
      tokens: r.tokens,
      // Fetched usage covers every fetched char of a counted row; an
      // in-flight step's tail regrows from zero as deltas resume.
      ...(r.type === "assistant" && r.tokens
        ? {
            reportedChars: parts.reduce(
              (k, p) => k + (isText(p) ? p.text?.length ?? 0 : 0),
              0,
            ),
          }
        : {}),
      ...(r.error ? { error: r.error } : {}),
      ...(r.type === "assistant" && parent
        ? { parentID: parent }
        : {}),
    };
    return { info, parts };
  });
  // Raw row count (pre-filter): full page → an older page may exist.
  const full = (body.data?.length ?? 0) >= size;
  return { messages, next: full ? body.cursor?.next : undefined };
}

// GET /session/{id}/message (v1) — the legacy store. Compaction writes ONLY
// here: summarize's trigger user row (a lone `compaction` part) and the
// summary assistant row (agent "compaction", `summary:true`, the summary
// turn's own tokens) land in it, so the v2 endpoint above never serves
// them. Merge into the v2 page on refresh. Parts arrive in the live
// dialect (flat modelID/providerID, reasoning time {start,end}); tool
// parts still name `name` and step rows are bookkeeping — normalized away
// like the v2 path does.
export async function fetchLegacyMessages(
  id: string,
): Promise<MessageWithParts[] | undefined> {
  const rows = await getJson<MessageWithParts[]>(`/session/${id}/message`);
  if (!rows) return undefined;
  return rows.map(({ info, parts }) => ({
    info,
    parts: parts
      .filter((p) => p.type !== "step-start" && p.type !== "step-finish")
      .map((p) => {
        if (isText(p) && typeof p.text === "string")
          p.text = clampPartText(p.id, p.text);
        return p.type === "tool" && (p as { tool?: string }).tool === undefined
          ? { ...p, tool: (p as { name?: string }).name }
          : p;
      }),
  }));
}

// GET /session/{id} (v1) — the flat row; used to tell a restored route a
// dead session id without relying on the paginated list. The flat row
// carries root `directory`, so normalize before it enters the store.
export async function fetchSession(id: string): Promise<Session | undefined> {
  const row = await getJson<Session & { directory?: string }>(`/session/${id}`);
  return row ? normalizeSession(row) : undefined;
}

// Row of GET /project — a known worktree with its avatar color (assigned by
// the host's ServerManager on boot when missing) and optional display name.
export interface Project {
  id: string;
  worktree: string;
  name?: string;
  icon?: { color?: string };
  time?: { created: number; updated: number };
}

export async function fetchProjects(): Promise<Project[] | undefined> {
  return getJson<Project[]>("/project");
}

// PATCH /project/{id} — set the display name. The worktree stays the
// project's identity; the name is pure label.
export async function renameProject(
  id: string,
  name: string,
  directory: string,
): Promise<boolean> {
  return (
    (await sendJson("PATCH", `/project/${id}${dirQuery(directory)}`, { name }))
      ?.ok === true
  );
}

// GET /project/current — this server's project (`worktree` is the folder;
// id "global" when the folder is not a git worktree root).
export interface CurrentProject {
  id: string;
  worktree?: string;
  sandboxes?: string[];
}

export async function fetchCurrentProject(): Promise<
  CurrentProject | undefined
> {
  return getJson<CurrentProject>("/project/current");
}

// POST/PATCH/DELETE JSON; only a JSON reply is parsed, and the caller still
// sees `ok` so empty 204/200 replies count as success. The v2 SPA fallback
// (200 + HTML) for a wrong path is a failure, for reads and writes alike.
async function sendJson<T>(
  method: "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  timeoutMs?: number,
): Promise<{ ok: boolean; data?: T }> {
  const res = await apiRequest(method, path, body, timeoutMs);
  return { ok: res.ok, data: res.json as T | undefined };
}

// Every v1 session row (POST /session reply, SSE info) carries the worktree
// as root `directory`; only the list wraps it as `location`. Normalize on
// entry, so a row from any source reads like the list's.
export function normalizeSession(
  row: Session & { directory?: string },
): Session {
  return {
    ...row,
    location: { directory: row.location?.directory ?? row.directory ?? "" },
  };
}

// POST /session (v1) — honors `title` plus an optional agent/model preset
// (a draft's picker selection rides along on creation), returns a flat row.
// No title leaves the naming to the server ("New session - <date>"), whose
// auto-title replaces it again on the first prompt.
export async function createSession(
  title?: string,
  preset?: { agent?: string; model?: ModelSelection },
): Promise<Session | undefined> {
  const res = await sendJson<Session & { directory?: string }>(
    "POST",
    "/session",
    { title, agent: preset?.agent, model: preset?.model },
  );
  const row = res?.data;
  return row ? normalizeSession(row) : undefined;
}

// POST /session/{id}/prompt_async — the v1 pipeline, what every native
// surface (TUI, web app) runs turns on. The v2 /api/session/{id}/prompt
// writes the new session_message store, which nothing else reads: compaction
// (POST /session/{id}/summarize) summarizes the legacy store only, so v2
// sessions compacted to an empty "(none)" template and folded nothing. v1
// accepts fire-and-forget (204); rows and deltas stream on GET /event. The
// model rides along explicitly — prompt_async's own default resolution can
// land on a model the account can't run (observed: zai-coding-plan
// glm-5.3-highspeed → 429). A file part carries mime/url/filename.
function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

const MIME_OF_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
};

// Attachable text extensions — source, config, data. Anything attachable
// that isn't image/pdf rides as text/plain.
const TEXT_EXT = new Set(
  "c cc cjs clj cmd conf cpp cs css csv cts dart env erb erl ex exs go gql graphql gradle h hh hpp htm html hs ini java js json jsonl jsx kt kts less log lua md mdx mjs mts php pl proto ps1 py rb rs sass scss sh sql swift toml ts tsx txt xml yaml yml zsh".split(
    " ",
  ),
);
const TEXT_MIME_RE = /text\/|application\/(json|ld\+json|toml|x-toml|x-yaml|xml|yaml|javascript)/;

// Type and gate of an attached file, decided from its name and blob type.
// Images and pdf are known by extension (or a sniffed blob type, when the
// name has none); text extensions ride as text/plain; anything else is
// refused — an unknown mime reaches the endpoint as a binary blob it
// "reads" into the context as raw bytes. `undefined` = not attachable.
export function attachMime(name: string, type: string): string | undefined {
  const ext = extOf(name);
  if (MIME_OF_EXT[ext]) return MIME_OF_EXT[ext];
  if (TEXT_EXT.has(ext) || TEXT_MIME_RE.test(type)) return "text/plain";
  if (type && Object.values(MIME_OF_EXT).includes(type)) return type;
  return undefined;
}

function fileMime(uri: string): string {
  // Data URIs self-describe ("data:image/png;base64,…") — the composer
  // stamps the type at attach time. Guessing an extension from the payload
  // instead labeled every pasted image text/plain, which the endpoint then
  // "read" as text and inlined into the context as raw bytes.
  if (uri.startsWith("data:")) {
    const m = /^data:([^;,]+)/.exec(uri);
    return m ? m[1] : "application/octet-stream";
  }
  const ext = extOf(uri.split("?")[0].split("#")[0]);
  return MIME_OF_EXT[ext] ?? "text/plain";
}

// v1 message parts we send. Text carries the prompt (mentions stay inline);
// a file part is an attachment (data-URI) or a mention (file:// url plus a
// source range pointing back at the "@path" text); an agent part switches
// the turn to that agent.
export type PromptPart =
  | { type: "text"; text: string }
  | {
      type: "file";
      mime: string;
      url: string;
      filename?: string;
      source?: {
        type: "file";
        path: string;
        text: { value: string; start: number; end: number };
      };
    }
  | {
      type: "agent";
      name: string;
      source?: { value: string; start: number; end: number };
    };

// Composer attachments (paste/drop/+) as data-URI file parts.
export function attachmentParts(
  files: { uri: string; name: string }[],
): PromptPart[] {
  return files.map((f) => ({
    type: "file" as const,
    mime: fileMime(f.uri),
    url: f.uri,
    filename: f.name,
  }));
}

export async function promptSession(
  id: string,
  parts: PromptPart[],
  agent?: string,
  model?: ModelSelection,
): Promise<boolean> {
  const body = {
    parts,
    ...(agent ? { agent } : {}),
    ...(model ? { model: { providerID: model.providerID, modelID: model.id } } : {}),
    // The reasoning effort rides TOP-LEVEL, not inside model — the v1 prompt
    // schema takes it as its own field. Omitted, the runner resolves the
    // model's default variant, runs the turn at that effort, and rewrites
    // the session row with variant "default": every picker choice reset at
    // the first send.
    ...(model?.variant ? { variant: model.variant } : {}),
  };
  return (await sendJson("POST", `/session/${id}/prompt_async`, body))?.ok ===
    true;
}

// GET /find/file — the file finder behind "@" mentions (the same route the
// official app's compat layer calls). Bare array of paths relative to the
// directory; directories carry the platform trailing separator. Normalized
// to "/" so display, inserted text and the send-time parser agree.
export async function findFiles(
  query: string,
  directory?: string,
): Promise<string[]> {
  const qs = new URLSearchParams({ query, limit: "20" });
  if (directory) qs.set("directory", directory);
  const rows = await getJson<string[]>(`/find/file?${qs}`);
  return (rows ?? []).map((p) => p.replace(/\\/g, "/"));
}

// POST /session/{id}/abort — the v1 interrupt (the v2 one only reaches the
// v2 loop). A no-op on an idle session.
export async function interruptSession(id: string): Promise<boolean> {
  return (await sendJson("POST", `/session/${id}/abort`))?.ok === true;
}

// POST /api/session/{id}/agent — the agent for subsequent turns. 204.
export async function switchSessionAgent(
  id: string,
  agent: string,
): Promise<boolean> {
  return (await sendJson("POST", `/api/session/${id}/agent`, { agent }))?.ok === true;
}

// A model pick: provider + model id, plus the reasoning-effort variant
// (ModelRef accepts one) when the model offers it and a choice was made.
export interface ModelSelection {
  providerID: string;
  id: string;
  variant?: string;
}

// POST /api/session/{id}/model — `model` is a ModelRef {providerID, id}.
export async function switchSessionModel(
  id: string,
  providerID: string,
  modelID: string,
  variant?: string,
): Promise<boolean> {
  return (
    (await sendJson("POST", `/api/session/${id}/model`, {
      model: { providerID, id: modelID, ...(variant ? { variant } : {}) },
    }))?.ok === true
  );
}

// POST /session/{id}/command — run a slash command; replies {info, parts}
// with the assistant message it produced. The POST resolves only when the
// command's turn ends, and skill/agent commands run minutes — the relay's
// default 10s abort would report every long command as failed while it
// keeps running server-side, so this carries the same long cap as
// compactSession. The session's current agent/model/variant ride along:
// the server resolves a bare command under the default agent with no
// variant and rewrites the session row from the turn (prompt.ts
// createUserMessage) — resetting Plan to Build and the effort to default.
// A command's own agent/model config still wins server-side.
export async function runCommand(
  id: string,
  command: string,
  args: string,
  sel?: { agent: string; model?: ModelSelection },
): Promise<boolean> {
  const model = sel?.model;
  return (
    (await sendJson(
      "POST",
      `/session/${id}/command`,
      {
        command,
        arguments: args,
        ...(sel ? { agent: sel.agent } : {}),
        ...(model ? { model: `${model.providerID}/${model.id}` } : {}),
        ...(model?.variant && model.variant !== "default"
          ? { variant: model.variant }
          : {}),
      },
      300_000,
    ))?.ok === true
  );
}

// POST /session/{id}/summarize — native compaction, what the TUI's /compact
// runs: the server folds the history into an AI summary written by the
// given model, freeing the context. `auto` defaults to false server-side.
// The POST resolves only when the summary turn is done, so it carries its
// own long timeout — the relay's default cap would abort mid-compaction and
// read as failure while the server keeps folding.
export async function compactSession(
  id: string,
  providerID: string,
  modelID: string,
): Promise<boolean> {
  return (
    await sendJson(
      "POST",
      `/session/${id}/summarize`,
      { providerID, modelID },
      300_000,
    )
  ).ok;
}

// POST /api/session/{sid}/permission/{id}/reply — `always` only when the
// request offers it (save non-empty); `message` rides a reject.
export async function replyPermission(
  sessionID: string,
  id: string,
  reply: "once" | "always" | "reject",
  message?: string,
): Promise<boolean> {
  return (
    (
      await sendJson(
        "POST",
        `/api/session/${sessionID}/permission/${id}/reply`,
        { reply, message },
      )
    )?.ok === true
  );
}

// POST /permission/{id}/reply — the v1 route for v1 asks; answering one on
// the v2 per-session route comes back PermissionNotFound.
export async function replyPermissionV1(
  id: string,
  reply: "once" | "always" | "reject",
  message?: string,
): Promise<boolean> {
  return (
    (await sendJson("POST", `/permission/${id}/reply`, { reply, message }))
      ?.ok === true
  );
}

// POST .../question/{id}/reply — one label array per question, in order.
// The pipeline split runs through the reply too: a v1 ask answers on the
// global /question/{id}/reply, a v2 ask on /api/session/{sid}/question/{id}/reply
// — the wrong route 404s (QuestionNotFoundError).
export async function replyQuestion(
  sessionID: string,
  id: string,
  answers: string[][],
  v1 = false,
): Promise<boolean> {
  const path = v1
    ? `/question/${id}/reply`
    : `/api/session/${sessionID}/question/${id}/reply`;
  return (await sendJson("POST", path, { answers }))?.ok === true;
}

// POST .../question/{id}/reject — bodyless, same pipeline split.
export async function rejectQuestion(
  sessionID: string,
  id: string,
  v1 = false,
): Promise<boolean> {
  const path = v1
    ? `/question/${id}/reject`
    : `/api/session/${sessionID}/question/${id}/reject`;
  return (await sendJson("POST", path))?.ok === true;
}

// `?directory=<worktree>` scopes a session write to its project. Verified
// against GET /doc (CLI 1.18.25): /session/{id} PATCH+DELETE and /session
// GET all take it; /api/session/{id} does not, so these are v1 paths.
const dirQuery = (directory?: string) =>
  directory ? `?directory=${encodeURIComponent(directory)}` : "";

// PATCH /session/{id} — rename. Replies the flat v1 row; callers patch the
// list locally instead of parsing it.
export async function renameSession(
  id: string,
  title: string,
  directory?: string,
): Promise<boolean> {
  return (
    (await sendJson("PATCH", `/session/${id}${dirQuery(directory)}`, { title }))
      ?.ok === true
  );
}

// DELETE /session/{id} — 200, empty body.
export async function deleteSession(
  id: string,
  directory?: string,
): Promise<boolean> {
  return (await sendJson("DELETE", `/session/${id}${dirQuery(directory)}`))
    ?.ok === true;
}

// POST /session/{id}/revert — rewind to before the given user message: it,
// its reply, and everything after fold out of the transcript (v1
// session.revert — the store prompt_async writes; unrevert would restore).
// Replies the updated session row carrying the revert marker.
export async function revertSession(
  id: string,
  messageID: string,
  directory?: string,
): Promise<Session | undefined> {
  const res = await sendJson<Session & { directory?: string }>(
    "POST",
    `/session/${id}/revert${dirQuery(directory)}`,
    { messageID },
  );
  const row = res?.data;
  return row ? normalizeSession(row) : undefined;
}

// GET /session?directory= (v1) — a project's sessions, unpaged. Only ids
// are read (project purge).
export async function fetchProjectSessions(
  directory: string,
): Promise<{ id: string }[] | undefined> {
  return getJson<{ id: string }[]>(
    `/session${dirQuery(directory)}`,
  );
}
