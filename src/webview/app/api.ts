// Typed API access for the webview app, relayed through the extension host
// (AppHost): the webview origin is opaque, so the server's CORS would block
// every direct call — the app posts {type:"api-request"} and the host
// answers {type:"api-result"}. Shapes reflect the live server (CLI
// 1.18.25); v2 answers unknown paths with 200 + SPA HTML, so the host only
// reports a body as `json` when its content-type is application/json.
import { postToHost } from "./host";

// Which server dialect the routes below speak. v1 (opencode-ai 1.x) keeps
// its turn pipeline under bare /session routes; v2 (@opencode/cli 2.x)
// dropped that surface — everything lives under /api with {data}/{location,
// data} envelopes, 204s on PATCH/DELETE, and a {text} prompt body. The host
// probes the dialect at boot and bakes it here; a late "dialect" host
// message can flip it (idempotent — callers re-sync on it).
export type Dialect = "v1" | "v2";
let serverDialect: Dialect =
  (document.querySelector('meta[name="opencode-dialect"]')?.getAttribute(
    "content",
  ) ?? "") === "v2"
    ? "v2"
    : "v1";

export function dialect(): Dialect {
  return serverDialect;
}

export function setDialect(d: Dialect): void {
  serverDialect = d;
}

// Route seam: v1 path, v2 path.
const route = (v1: string, v2: string): string =>
  serverDialect === "v2" ? v2 : v1;



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

// capabilities.input of a catalog model: the modalities it accepts. Absent
// (model missing from the catalog, or no capabilities block) means unknown —
// callers fall back to the legacy attachment allowlist.
export interface ModelInput {
  text?: boolean;
  audio?: boolean;
  image?: boolean;
  video?: boolean;
  pdf?: boolean;
}

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
        capabilities?: { attachment?: boolean; input?: ModelInput };
      }
    >;
  }[];
  default: Record<string, string>;
  connected: string[];
}

// One relay round-trip: post the request, resolve on the matching reply.
// The host always answers — any relay/fetch failure replies {ok:false} —
// so the promise never hangs or rejects. `error` is the host's compact
// reason (HTTP status + server message, or the transport failure).
interface ApiResult {
  ok: boolean;
  json?: unknown;
  error?: string;
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
    error?: unknown;
  };
  if (m?.type !== "api-result" || typeof m.id !== "number") return;
  const resolve = pending.get(m.id);
  if (!resolve) return;
  pending.delete(m.id);
  resolve({
    ok: m.ok === true,
    json: m.json,
    error: typeof m.error === "string" ? m.error : undefined,
  });
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

// The session page size we ask for. The endpoint reports a cursor on every
// non-empty page, even the last — a page shorter than the limit is the
// list-complete signal (same rule as fetchMessages).
const SESSION_PAGE = 50;

// GET /api/session — newest first, paginated ({data, cursor} envelope).
export async function fetchSessions(
  cursor?: string,
): Promise<SessionPage | undefined> {
  const params = new URLSearchParams({ limit: String(SESSION_PAGE) });
  if (cursor) params.set("cursor", cursor);
  const body = await getJson<{
    data?: Session[];
    cursor?: { next?: string };
  }>(`/api/session?${params}`);
  if (!body) return undefined;
  const rows = body.data ?? [];
  return {
    sessions: rows,
    next: rows.length < SESSION_PAGE ? undefined : body.cursor?.next,
  };
}

// GET /session/status (v1: the sessionID → status map). v2 serves the
// ACTIVE sessions at /api/session/active: a record keyed by sessionID
// ({} when idle) — the official client reads it as
// `new Map(Object.keys(t).map(...running))`. Streaming truth comes from
// the event translation either way (see v2events.ts).
export async function fetchSessionStatus(): Promise<
  Record<string, SessionStatus> | undefined
> {
  if (serverDialect === "v2") {
    const body = await getJson<{ data?: Record<string, unknown> | null }>(
      "/api/session/active",
    );
    const active = body?.data;
    if (!active || typeof active !== "object" || Array.isArray(active))
      return undefined;
    const map: Record<string, SessionStatus> = {};
    for (const sid of Object.keys(active)) map[sid] = { type: "busy" };
    return map;
  }
  return getJson<Record<string, SessionStatus>>("/session/status");
}

// Row of GET /api/model (v2): flat catalog entry. `capabilities.input`
// lists modalities as strings (v1 speaks a boolean record); `variants` is
// an array of {id, settings} (v1 keys a record by id); `limit` carries the
// context/output window sizes.
interface V2ModelRow {
  id?: string;
  providerID?: string;
  name?: string;
  capabilities?: { tools?: boolean; input?: string[]; output?: string[] };
  variants?: { id?: string }[];
  limit?: { context?: number; output?: number };
}

// ["text","image"] → {text:true, image:true}
function inputRecord(list?: string[]): ModelInput | undefined {
  if (!Array.isArray(list)) return undefined;
  const out: ModelInput = {};
  for (const m of list) out[m as keyof ModelInput] = true;
  return out;
}

// GET /provider (v1 shape). On v2 the catalog is assembled from three
// routes: /api/provider (connected providers — no models), /api/model
// (the flat catalog), /api/model/default (the pinned default). No `limit`
// param on /api/model: the route returns an empty list when handed one.
export async function fetchProviders(): Promise<Providers | undefined> {
  if (serverDialect !== "v2")
    return getJson<Providers>("/provider");
  const [providers, models, config] = await Promise.all([
    getJson<{ data?: { id?: string; name?: string }[] }>("/api/provider"),
    getJson<{ data?: V2ModelRow[] }>("/api/model"),
    getJson<
      { info?: { model?: { providerID?: string; model?: string } } }[]
    >("/api/config"),
  ]);
  if (!models) return undefined;
  const all: Providers["all"] = [];
  const byId = new Map<string, Providers["all"][number]>();
  for (const m of models.data ?? []) {
    if (!m?.id || !m.providerID) continue;
    let provider = byId.get(m.providerID);
    if (!provider) {
      provider = { id: m.providerID, name: m.providerID, models: {} };
      byId.set(m.providerID, provider);
      all.push(provider);
    }
    provider.models[m.id] = {
      name: m.name ?? m.id,
      variants: Object.fromEntries(
        (m.variants ?? [])
          .map((v) => v?.id)
          .filter((id): id is string => !!id)
          .map((id) => [id, {}]),
      ),
      ...(m.limit?.context !== undefined
        ? { limit: { context: m.limit.context } }
        : {}),
      capabilities: {
        input: inputRecord(m.capabilities?.input),
      },
    };
  }
  // "Connected" on v2: the /api/model catalog is availability-filtered
  // server-side (public models, configured providers, discovered local
  // servers — a fresh isolated server shows only what it can actually
  // run), so every provider it lists is pickable. /api/provider rows and
  // the config default's provider are unioned in for completeness (rows
  // without catalog models render no group either way).
  const connected = [
    ...new Set(
      [
        ...all.map((p) => p.id),
        ...(providers?.data ?? [])
          .map((r) => r.id)
          .filter((id): id is string => !!id),
        v2ConfigDefaultModel(config)?.providerID,
      ].filter((id): id is string => !!id),
    ),
  ];
  return {
    all,
    default: {},
    connected,
  };
}

// v2's /api/config is an array of source documents; the first doc with an
// info.model block is the user's configured default (the /api/model/default
// route answers the built-in public default instead, which no one picked).
function v2ConfigDefaultModel(
  docs: { info?: { model?: { providerID?: string; model?: string } } }[] | undefined,
): { providerID?: string; model?: string } | undefined {
  for (const d of docs ?? [])
    if (d?.info?.model?.providerID) return d.info.model;
  return undefined;
}

// GET /config — the default model ("providerID/modelID", so a draft with no
// explicit pick can show what a prompt would run on) and the user's provider
// blocks (the ids the model picker may list). v2 has no merged config: the
// default comes from the config source docs' model block.
export interface ServerConfig {
  model?: string;
  provider?: Record<string, unknown>;
}

export async function fetchConfig(): Promise<ServerConfig | undefined> {
  if (serverDialect === "v2") {
    const docs = await getJson<
      { info?: { model?: { providerID?: string; model?: string } } }[]
    >("/api/config");
    const model = v2ConfigDefaultModel(docs);
    return model?.providerID && model.model
      ? { model: `${model.providerID}/${model.model}` }
      : {};
  }
  return getJson<ServerConfig>("/config");
}

// GET /agent — flat array; v2 rows carry the id ("build") the switch
// endpoint wants and the display name ("Build"); `name` below stays the
// switch key (v1: the id-ish name), `label` the display copy. Only
// mode:"primary" agents take the composer's turn; hidden ones (compaction,
// summary, title) are bookkeeping.
export interface Agent {
  name: string;
  label?: string;
  description?: string;
  mode: "primary" | "subagent" | "all";
  hidden?: boolean;
  native?: boolean;
}

export async function fetchAgents(): Promise<Agent[] | undefined> {
  if (serverDialect === "v2") {
    const body = await getJson<{
      data?: {
        id?: string;
        name?: string;
        description?: string;
        mode?: Agent["mode"];
        hidden?: boolean;
      }[];
    }>("/api/agent");
    return (body?.data ?? [])
      .filter((r) => r.id || r.name)
      .map((r) => ({
        name: r.id ?? r.name ?? "",
        ...(r.name && r.name !== (r.id ?? r.name)
          ? { label: r.name }
          : {}),
        description: r.description,
        mode: r.mode ?? "primary",
        hidden: r.hidden,
      }));
  }
  return getJson<Agent[]>("/agent");
}

// GET /command — user-defined commands (command/mcp/skill sources).
export interface Command {
  name: string;
  description?: string;
}

export async function fetchCommands(): Promise<Command[] | undefined> {
  if (serverDialect === "v2") {
    const body = await getJson<{ data?: Command[] }>("/api/command");
    return body?.data;
  }
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

// Pending asks, both dialects: v2 GETs /api/permission/request ({data}
// envelope, same row shape the session.permissions event carries); v1
// GETs the global /permission list. Asks made while the page was closed
// are recovered from here.
export async function fetchPendingPermissions(): Promise<
  PermissionRequest[] | undefined
> {
  if (serverDialect === "v2") {
    const body = await getJson<
      { data?: (PermissionRequest & { sessionID?: string })[] } | PermissionRequest[]
    >("/api/permission/request");
    const rows = Array.isArray(body)
      ? body
      : Array.isArray((body as { data?: PermissionRequest[] })?.data)
        ? (body as { data: PermissionRequest[] }).data
        : undefined;
    return rows ? rows.map((r) => normalizePermission(r as PermissionRequest, false)) : undefined;
  }
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
  // global /question/{id}/reply; a v2 ask is a FORM (lists on
  // /api/session/{id}/form, answers on /api/session/{id}/form/{id}/reply
  // with {answer}). The other route 404s (QuestionNotFoundError).
  v1?: boolean;
  // A v2 form ask: per-field names, in question order — a multi-field
  // reply keys its answer object by them (single-field answers go as the
  // scalar).
  formFieldNames?: string[];
}

// Pending questions for one session, both pipelines merged: v2 asks are
// FORMS (GET /api/session/{id}/form, {data} envelope — the /question
// routes are gone); v1 asks list on the global /question (the /api route
// returns [] for them — wire-verified 1.18.25). A form row maps onto the
// v1 question shape the dock renders; the form flag routes its reply to
// the form endpoints. The /api copy wins on an id collision, so a v2 ask
// that shows up in both keeps the v2 reply route.
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
    serverDialect === "v2"
      ? getJson<{ data?: unknown[] }>(`/api/session/${id}/form`)
      : getJson<{ data?: QuestionRequest[] }>(`/api/session/${id}/question`),
    getJson<QuestionRequest[]>("/question"),
  ]);
  if (v2 === undefined && global === undefined) return undefined;
  const v2Rows =
    serverDialect === "v2"
      ? ((Array.isArray((v2 as { data?: unknown[] })?.data)
          ? (v2 as { data: unknown[] }).data
          : []) as Record<string, unknown>[])
          .map((f) => formToQuestion(f, id))
          .filter((q): q is QuestionRequest => !!q)
      : ((Array.isArray(v2?.data) ? v2?.data : []) as QuestionRequest[]).map(
          (q) => ({ ...q, v1: false }),
        );
  const seen = new Set(v2Rows.map((q) => q.id));
  const v1Rows = (Array.isArray(global) ? global : [])
    .filter((q) => q.sessionID === id && !seen.has(q.id))
    .map((q) => ({ ...q, v1: true }));
  return {
    rows: [...v2Rows, ...v1Rows],
    v2Loaded: v2 !== undefined,
    globalLoaded: global !== undefined,
  };
}

// v2 form row → v1 QuestionRequest. Field shape is only partially known
// (Form.Field: name/label/type/options); option-like fields list their
// options, everything else offers the free-text row. Field names ride
// along so a multi-field reply can key its answer object.
export function formToQuestion(
  raw: Record<string, unknown>,
  sessionID: string,
): QuestionRequest | undefined {
  const id = typeof raw.id === "string" ? raw.id : undefined;
  if (!id) return undefined;
  const title = typeof raw.title === "string" ? raw.title : "";
  const fields = (Array.isArray(raw.fields) ? raw.fields : []).filter(
    (f): f is Record<string, unknown> =>
      typeof f === "object" && f !== null,
  );
  const names = fields.map((f, i) =>
    typeof f.name === "string" ? f.name : `field${i}`,
  );
  const questions: QuestionInfo[] =
    fields.length === 0
      ? [{ question: title, header: "", options: [], custom: true }]
      : fields.map((f, i) => {
          const label =
            typeof f.label === "string"
              ? f.label
              : typeof f.name === "string"
                ? f.name
                : `Field ${i + 1}`;
          const options = Array.isArray(f.options)
            ? (f.options as Record<string, unknown>[])
                .map((o) =>
                  typeof o === "string"
                    ? { label: o }
                    : typeof o?.label === "string"
                      ? {
                          label: o.label,
                          ...(typeof o.description === "string"
                            ? { description: o.description }
                            : {}),
                        }
                      : typeof o?.value === "string" ||
                          typeof o?.value === "number"
                        ? { label: String(o.value) }
                        : undefined,
                )
                .filter(
                  (o): o is { label: string; description?: string } => !!o,
                )
            : [];
          return {
            question:
              fields.length > 1
                ? `${title} — ${label}`
                : title || label,
            header: label,
            options,
            multiple: f.multiple === true,
            // Free-text row: explicit on the field, or the only offering
            // of an option-less (input) field.
            custom:
              f.custom === true ||
              (options.length === 0 && f.custom !== false),
          };
        });
  return { id, sessionID, questions, formFieldNames: names, v1: false };
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
  source?: {
    type: "file";
    path: string;
    text: { value: string; start: number; end: number };
  };
}

// `type` stays open (step-start, file, agent, ...) so unseen kinds degrade
// to PartBase instead of breaking the union.
export type Part = TextPart | ToolPart | FilePart | PartBase;

export const isText = (p: Part): p is TextPart =>
  p.type === "text" || p.type === "reasoning";
export const isTool = (p: Part): p is ToolPart => p.type === "tool";

// Tool ids arrive as schema names; the row shows the friendly label. v2
// renamed some tools while accepting the v1 names in places — the shell
// tool can arrive as bash/shell/execute, the subagent spawner as
// task/subagent — so the matchers below go through the alias sets.
export const isBashTool = (tool: string): boolean =>
  tool === "bash" || tool === "shell" || tool === "execute";
export const isTaskTool = (tool: string): boolean =>
  tool === "task" || tool === "subagent";

const TOOL_NAMES: Record<string, string> = {
  bash: "Shell",
  shell: "Shell",
  execute: "Shell",
  task: "Task",
  subagent: "Task",
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

function clampText(text: string): string {
  return (
    text.slice(0, PART_TEXT_HEAD) +
    `\n\n[… truncated for display — ${text.length} chars total …]\n\n` +
    text.slice(-PART_TEXT_TAIL)
  );
}

export function clampPartText(partID: string, text: string): string {
  if (text.length <= PART_TEXT_CAP) return text;
  truncatedParts.add(partID);
  return clampText(text);
}

// Tool outputs render beside text rows and update as whole strings on the
// stream — same clamp, same tracker.
export const clampToolOutput = (partID: string, output: string): string =>
  clampPartText(partID, output);

// Deep clamp for the structured blobs no stream delta ever appends to
// (tool input/structured/metadata arrive whole), so they don't register in
// the truncation tracker.
const CLAMP_DEEP_DEPTH = 8;
function clampStringsDeep(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.length <= PART_TEXT_CAP ? value : clampText(value);
  if (depth >= CLAMP_DEEP_DEPTH || typeof value !== "object" || value === null)
    return value;
  if (Array.isArray(value))
    return value.map((v) => clampStringsDeep(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value))
    out[k] = clampStringsDeep(v, depth + 1);
  return out;
}

// Bound one tool part's state — applied at every entry path (live stream,
// durable fetch, legacy fetch) so no dialect can smuggle a multi-MB payload
// into state. Tool input (a write's whole file content), structured
// (unified patches) and metadata (legacy diffs) hold the bulk of a coding
// transcript; display reads only small fields off them, so the cap loses
// nothing visible. A content[] result folds into output (the display copy)
// and is then dropped — kept raw it holds the text twice.
export function clampToolState(
  partID: string,
  state: ToolState,
): ToolState {
  const next = { ...state };
  if (!next.output && Array.isArray(next.content)) {
    const texts = next.content
      .map((c) => (typeof c?.text === "string" ? c.text : ""))
      .filter(Boolean);
    if (texts.length > 0) next.output = texts.join("\n");
  }
  if (typeof next.output === "string")
    next.output = clampToolOutput(partID, next.output);
  next.input = clampStringsDeep(next.input) as ToolState["input"];
  next.structured = clampStringsDeep(next.structured) as ToolState["structured"];
  next.metadata = clampStringsDeep(next.metadata) as ToolState["metadata"];
  delete next.content;
  return next;
}

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

// Row of GET /api/session/{id}/message. Assistant rows carry their parts in
// `content` (fields the SSE part events add — messageID/sessionID and
// sometimes the part id — are row-level or absent here); user rows carry
// the prompt in `payload.text` (v2 CLI) or a bare `text` (1.18). Rows have
// no `role` (it's `type`) and no `parentID` (the preceding user row IS the
// parent). `system` rows are server-injected context notes ("Today's date
// is now …"); `idle`/`compaction` are lifecycle markers and
// `agent-switched`/`model-switched` are bookkeeping rows the v2 switch
// endpoints write — all filtered out below: none of them are conversation,
// and a row between the prompt and the reply would split the turn.
interface V2MessageRow {
  id: string;
  type: "user" | "assistant" | "system" | "idle" | "compaction" | string;
  // compaction rows: "running" until the summary lands.
  status?: string;
  time: { created: number; completed?: number };
  text?: string;
  payload?: { text?: string; files?: V2RowFile[] };
  content?: { type: string; id?: string }[];
  // A user row's attachments (Session.Message.User.files — the same
  // Prompt.FileAttachment the prompt body speaks): an inline payload carries
  // {data, mime}; an on-disk file carries source {type:"uri", uri}; a
  // mention adds its range. Nesting under payload covers the API's text
  // wrapper (the store keeps both bare).
  files?: V2RowFile[];
  agent?: string;
  model?: { id?: string; providerID?: string };
  cost?: number;
  tokens?: MessageTokens;
  error?: { name: string; data?: { message?: string } };
}

interface V2RowFile {
  data?: string;
  mime?: string;
  source?: { type?: string; uri?: string };
  name?: string;
  mention?: V2Mention;
}

// file:///C:/w/repo/src/a.ts?start=12 → C:/w/repo/src/a.ts — a path the
// pill's data-path opener (resolveFileRef) accepts like any v1 mention path.
function fileUrlToPath(uri: string): string | undefined {
  const m = /^file:\/\/([^?]+)/.exec(uri);
  if (!m) return undefined;
  const path = m[1]
    .split("/")
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    })
    .join("/");
  const win = /^\/[A-Za-z]:/.test(path) ? path.slice(1) : path;
  return win || undefined;
}

// A v2 user row's files[] → the FilePart the renderers speak (same shape a
// v1 row's file parts have): uri-sourced files keep their file:// url,
// inline payloads rebuild the data: URI, a mention range becomes the v1
// source that pillifies the "@path" text.
function v2RowFileParts(row: V2MessageRow, sessionID: string): FilePart[] {
  return (row.files ?? row.payload?.files ?? []).map((f, i) => {
    const uri = f.source?.type === "uri" ? f.source.uri : undefined;
    const url =
      uri ??
      (f.data !== undefined
        ? `data:${f.mime ?? "application/octet-stream"};base64,${f.data}`
        : undefined);
    const path = uri !== undefined ? fileUrlToPath(uri) : undefined;
    return {
      id: `${row.id}:f${i}`,
      messageID: row.id,
      sessionID,
      type: "file" as const,
      ...(f.mime ? { mime: f.mime } : {}),
      ...(url ? { url } : {}),
      ...(f.name ? { filename: f.name } : {}),
      ...(f.mention && (path ?? f.name)
        ? {
            source: {
              type: "file" as const,
              path: path ?? f.name!,
              text: {
                value: f.mention.text,
                start: f.mention.start,
                end: f.mention.end,
              },
            },
          }
        : {}),
    };
  });
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
      (r): r is V2MessageRow & { type: "user" | "assistant" | "compaction" } =>
        r.type === "user" ||
        r.type === "assistant" ||
        (r.type === "compaction" && r.status !== "running"),
    )
    .map((r) => {
    if (r.type === "user") parent = r.id;
    // A completed compaction row is v2's summary — the same facts v1's
    // legacy store serves as an assistant row with agent "compaction"
    // (running ones have no content yet; the done-event refresh brings
    // them completed).
    if (r.type === "compaction") {
      const c = r as V2MessageRow & {
        type: "compaction";
        summary?: string;
        recent?: string;
      };
      return {
        info: {
          id: r.id,
          role: "assistant",
          time: r.time,
          agent: "compaction",
        },
        parts: [
          {
            id: `${r.id}:text`,
            messageID: r.id,
            sessionID: id,
            type: "text",
            text: c.summary ?? "",
          },
        ],
      } satisfies { info: Message; parts: Part[] };
    }
    // v2 rides a user row's attachments as top-level files[] (mapped below);
    // content file items are the older/1.18 fallback.
    const rowFiles = v2RowFileParts(r, id);
    const parts: Part[] =
      r.type === "user"
        ? [
            {
              id: `${r.id}:text`,
              messageID: r.id,
              sessionID: id,
              type: "text",
              text: clampPartText(
                `${r.id}:text`,
                r.payload?.text ?? r.text ?? "",
              ),
            },
            ...(rowFiles.length > 0
              ? rowFiles
              : // Durable @-mention attachments ride the row's content (the live
                // path speaks parts directly); keep them so pills survive reload.
                (r.content ?? [])
                  .filter((c) => (c as { type?: string }).type === "file")
                  .map((c, i) => ({
                    ...c,
                    id: c.id ?? `${r.id}:f${i}`,
                    messageID: r.id,
                    sessionID: id,
                  }))),
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
      // v2 stamps tool runs {created, ran, completed}; the live dialect
      // (and ToolState) speaks {start, end}. A mid-stream reload's
      // "streaming" status is a still-writing input — reads as running.
      const t = p.state.time as
        | {
            created?: number;
            ran?: number;
            completed?: number;
            start?: number;
            end?: number;
          }
        | undefined;
      if (
        t &&
        (t.created !== undefined ||
          t.ran !== undefined ||
          t.completed !== undefined)
      ) {
        p.state = {
          ...p.state,
          time: {
            start: t.start ?? t.ran ?? t.created,
            end: t.end ?? t.completed,
          },
        };
      }
      if ((p.state.status as string) === "streaming")
        p.state = { ...p.state, status: "running" };
      p.state = clampToolState(p.id, p.state);
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
  // v2 dropped the legacy store route (SPA fallback) — nothing to merge.
  if (serverDialect === "v2") return undefined;
  const rows = await getJson<MessageWithParts[]>(`/session/${id}/message`);
  if (!rows) return undefined;
  return rows.map(({ info, parts }) => ({
    info,
    parts: parts
      .filter((p) => p.type !== "step-start" && p.type !== "step-finish")
      .map((p) => {
        if (isText(p) && typeof p.text === "string")
          p.text = clampPartText(p.id, p.text);
        const named =
          p.type === "tool" && (p as { tool?: string }).tool === undefined
            ? { ...p, tool: (p as { name?: string }).name }
            : p;
        return isTool(named) && named.state
          ? { ...named, state: clampToolState(named.id, named.state) }
          : named;
      }),
  }));
}

// GET /session/{id} (v1) / /api/session/{id} (v2, {data} envelope) — used
// to tell a restored route a dead session id without relying on the
// paginated list. The v1 flat row carries root `directory`, so normalize
// before it enters the store.
export async function fetchSession(id: string): Promise<Session | undefined> {
  const row =
    serverDialect === "v2"
      ? (
          await getJson<{ data?: Session & { directory?: string } }>(
            `/api/session/${id}`,
          )
        )?.data
      : await getJson<Session & { directory?: string }>(`/session/${id}`);
  return row ? normalizeSession(row) : undefined;
}

// Row of GET /project (v1) / /api/project (v2, bare array with the
// worktree as `canonical`) — a known worktree with its avatar color and
// optional display name.
export interface Project {
  id: string;
  worktree: string;
  name?: string;
  icon?: { color?: string };
  time?: { created: number; updated: number };
}

export async function fetchProjects(): Promise<Project[] | undefined> {
  if (serverDialect === "v2") {
    const rows = await getJson<
      (Omit<Project, "worktree"> & { canonical?: string })[]
    >("/api/project");
    return rows?.map((r) => ({ ...r, worktree: r.canonical ?? "" }));
  }
  return getJson<Project[]>("/project");
}

// PATCH /project/{id} — set the display name. The worktree stays the
// project's identity; the name is pure label. (v2's project PATCH is
// unverified; a failure surfaces through the app's error banner.)
export async function renameProject(
  id: string,
  name: string,
): Promise<boolean> {
  return (
    (await sendJson("PATCH", route(`/project/${id}`, `/api/project/${id}`), {
      name,
    }))?.ok === true
  );
}

// GET /project/current — this server's project (`worktree` is the folder;
// id "global" when the folder is not a git worktree root). Gone on v2 —
// the host always bakes the workspace meta, which is the better source.
export interface CurrentProject {
  id: string;
  worktree?: string;
  sandboxes?: string[];
}

export async function fetchCurrentProject(): Promise<
  CurrentProject | undefined
> {
  if (serverDialect === "v2") return undefined;
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
): Promise<{ ok: boolean; data?: T; error?: string }> {
  const res = await apiRequest(method, path, body, timeoutMs);
  return { ok: res.ok, data: res.json as T | undefined, error: res.error };
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

// POST /session (v1) / POST /api/session (v2) — honors `title` plus an
// optional agent/model preset (a draft's picker selection rides along on
// creation; both dialects accept all three fields — the v2 row comes back
// with agent and model applied). v1 replies a flat row, v2 {data:{row}}.
// No title leaves the naming to the server ("New session - <date>"), whose
// auto-title replaces it again on the first prompt.
export async function createSession(
  title?: string,
  preset?: { agent?: string; model?: ModelSelection },
): Promise<{ session?: Session; error?: string }> {
  const model = preset?.model;
  const body = {
    title,
    agent: preset?.agent,
    ...(model
      ? {
          model: {
            providerID: model.providerID,
            id: model.id,
            ...(model.variant ? { variant: model.variant } : {}),
          },
        }
      : {}),
  };
  const res =
    serverDialect === "v2"
      ? await sendJson<{ data?: Session & { directory?: string } }>(
          "POST",
          "/api/session",
          body,
        )
      : await sendJson<Session & { directory?: string }>(
          "POST",
          "/session",
          body,
        );
  const row = (
    serverDialect === "v2"
      ? (res?.data as { data?: Session & { directory?: string } } | undefined)
          ?.data
      : res?.data
  ) as (Session & { directory?: string }) | undefined;
  return res?.ok && row
    ? { session: normalizeSession(row) }
    : { error: res?.error };
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
export function extOf(name: string): string {
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
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  flac: "audio/flac",
  aac: "audio/aac",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
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
// Images, pdf and audio/video are known by extension (or a sniffed blob
// type, when the name has none); text extensions ride as text/plain;
// anything else is refused — an unknown mime reaches the endpoint as a
// binary blob it "reads" into the context as raw bytes. `undefined` = not
// classifiable from name/type; callers may then sniff content (sniffsText).
export function attachMime(name: string, type: string): string | undefined {
  const ext = extOf(name);
  if (MIME_OF_EXT[ext]) return MIME_OF_EXT[ext];
  if (TEXT_EXT.has(ext) || TEXT_MIME_RE.test(type)) return "text/plain";
  if (type && Object.values(MIME_OF_EXT).includes(type)) return type;
  return undefined;
}

// Content sniff for files the name/type layers couldn't classify: the
// prefix rides as text iff it holds no NUL byte and decodes as UTF-8.
// The stream option tolerates a read window cut mid-codepoint — a text
// file must not be refused because its first 8 KB ended inside a char.
export function sniffsText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes, {
      stream: true,
    });
    return true;
  } catch {
    return false;
  }
}

// Model-aware half of the gate: may a mime ride to a model whose catalog
// entry declares `input`? Text (and the directory mention mime) always
// passes; every other modality needs its flag. `input` undefined — the
// catalog doesn't know the model — keeps the legacy allowlist: image+pdf
// pass, audio/video don't.
export function attachAllowed(mime: string, input?: ModelInput): boolean {
  if (mime.startsWith("text/") || mime === "application/x-directory")
    return true;
  if (input === undefined)
    return mime.startsWith("image/") || mime === "application/pdf";
  if (mime.startsWith("image/")) return input.image === true;
  if (mime === "application/pdf") return input.pdf === true;
  if (mime.startsWith("audio/")) return input.audio === true;
  if (mime.startsWith("video/")) return input.video === true;
  return false;
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

// v2 attachment shapes: {start, end, text} pointing back at the mention.
interface V2Mention {
  start: number;
  end: number;
  text: string;
}

// The v2 prompt/command body's file/agent lists, mapped from our parts:
// an attachment (data: URI or snapshotted file:// URL) is {uri, name}; a
// mention additionally carries the range of its "@path" text. Mime is not
// sent — the server sniffs the payload (PromptInput.FileAttachment).
function v2PromptBody(
  parts: PromptPart[],
  text: string,
): { text: string; files?: unknown[]; agents?: unknown[] } {
  const files: unknown[] = [];
  const agents: unknown[] = [];
  for (const p of parts) {
    if (p.type === "file") {
      const m = p.source?.text;
      const mention: V2Mention | undefined = m
        ? { start: m.start, end: m.end, text: m.value }
        : undefined;
      files.push({
        uri: p.url,
        ...(mention ? { mention } : {}),
        ...(!mention && p.filename ? { name: p.filename } : {}),
      });
    } else if (p.type === "agent" && p.source) {
      agents.push({
        name: p.name,
        mention: { start: p.source.start, end: p.source.end, text: p.source.value },
      });
    } else if (p.type === "agent") {
      agents.push({ name: p.name });
    }
  }
  return {
    text,
    ...(files.length > 0 ? { files } : {}),
    ...(agents.length > 0 ? { agents } : {}),
  };
}

// The prompt POST's reply on v2: the admitted user message row. v1 has no
// equivalent (the row streams back as message.updated).
export interface PromptUserRow {
  id: string;
  created?: number;
  text?: string;
}

export async function promptSession(
  id: string,
  parts: PromptPart[],
  agent?: string,
  model?: ModelSelection,
): Promise<{ ok: boolean; error?: string; user?: PromptUserRow }> {
  // v2: per-turn agent/model rides the session-scoped switch routes (both
  // wire-verified). Callers only pass a selection that differs from the
  // session row, keeping the switches (each writes a bookkeeping message
  // row server-side) off the steady state. The prompt body is PromptInput
  // — {text, files, agents} — mapped from our parts below; the schema is
  // additionalProperties:false, so nothing else may ride along.
  if (serverDialect === "v2") {
    if (agent)
      await sendJson("POST", `/api/session/${id}/agent`, { agent });
    if (model)
      await sendJson("POST", `/api/session/${id}/model`, {
        model: {
          providerID: model.providerID,
          id: model.id,
          ...(model.variant ? { variant: model.variant } : {}),
        },
      });
    const text = parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");
    const body = v2PromptBody(parts, text);
    const res = await sendJson<{
      data?: { id?: string; time?: { created?: number }; payload?: { text?: string } };
    }>("POST", `/api/session/${id}/prompt`, body);
    const row = res.ok ? res.data?.data : undefined;
    return {
      ok: res.ok === true,
      error: res.error,
      ...(row?.id
        ? {
            user: {
              id: row.id,
              created: row.time?.created,
              text: row.payload?.text ?? text,
            },
          }
        : {}),
    };
  }
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
  const res = await sendJson("POST", `/session/${id}/prompt_async`, body);
  return { ok: res.ok === true, error: res.error };
}

// GET /find/file (v1) / GET /api/fs/find (v2, {location,data} envelope) —
// the file finder behind "@" mentions. Bare array of paths relative to the
// directory; directories carry the platform trailing separator. Normalized
// to "/" so display, inserted text and the send-time parser agree.
export async function findFiles(
  query: string,
  directory?: string,
): Promise<string[]> {
  if (serverDialect === "v2") {
    const qs = new URLSearchParams({ query, limit: "20" });
    const body = await getJson<{ data?: string[] }>(`/api/fs/find?${qs}`);
    return (body?.data ?? []).map((p) => p.replace(/\\/g, "/"));
  }
  const qs = new URLSearchParams({ query, limit: "20" });
  if (directory) qs.set("directory", directory);
  const rows = await getJson<string[]>(`/find/file?${qs}`);
  return (rows ?? []).map((p) => p.replace(/\\/g, "/"));
}

// POST /session/{id}/abort (v1) / POST /api/session/{id}/interrupt (v2,
// replies {interrupted} instead of v1's {ok}). A no-op on an idle session.
export async function interruptSession(id: string): Promise<boolean> {
  return (
    (await sendJson(
      "POST",
      route(`/session/${id}/abort`, `/api/session/${id}/interrupt`),
    ))?.ok === true
  );
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
// A command's own agent/model config still wins server-side. v2's body is
// {name, text} only (PromptInput, additionalProperties:false): no
// per-command agent/model — the command's own config decides there.
export async function runCommand(
  id: string,
  command: string,
  args: string,
  sel?: { agent: string; model?: ModelSelection },
): Promise<boolean> {
  if (serverDialect === "v2") {
    return (
      (await sendJson(
        "POST",
        `/api/session/${id}/command`,
        { name: command, text: args },
        300_000,
      ))?.ok === true
    );
  }
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

// POST /session/{id}/summarize (v1) / POST /api/session/{id}/compact (v2,
// body {} required): native compaction, what the TUI's /compact runs — the
// server folds the history into an AI summary, freeing the context. The
// POST resolves only when the summary turn is done, so it carries its own
// long timeout — the relay's default cap would abort mid-compaction and
// read as failure while the server keeps folding.
export async function compactSession(
  id: string,
  providerID: string,
  modelID: string,
): Promise<boolean> {
  return (
    (await sendJson(
      "POST",
      route(`/session/${id}/summarize`, `/api/session/${id}/compact`),
      serverDialect === "v2" ? {} : { providerID, modelID },
      300_000,
    ))?.ok === true
  );
}

// POST /api/session/{sid}/permission/{id}/reply — SDK body is
// {decision, message} ("once" | "always" | "reject"); `always` only when
// the request offers it (save non-empty).
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
        { decision: reply, ...(message !== undefined ? { message } : {}) },
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

// POST .../reply — one label array per question, in order. The pipeline
// split runs through the reply too: a v1 ask answers on the global
// /question/{id}/reply; a v2 ask is a form — /api/session/{sid}/form/{id}/reply
// with {answer} (the scalar for a single-field form, an object keyed by
// field name for more).
export async function replyQuestion(
  sessionID: string,
  id: string,
  answers: string[][],
  v1 = false,
  formFieldNames?: string[],
): Promise<boolean> {
  if (!v1) {
    const answer =
      formFieldNames && formFieldNames.length > 1
        ? Object.fromEntries(
            formFieldNames.map((n, i) => [n, answers[i]?.[0] ?? ""]),
          )
        : (answers[0]?.[0] ?? "");
    return (
      (await sendJson("POST", `/api/session/${sessionID}/form/${id}/reply`, {
        answer,
      }))?.ok === true
    );
  }
  return (
    (await sendJson("POST", `/question/${id}/reply`, { answers }))?.ok === true
  );
}

// POST .../reject — bodyless on v1; a v2 form ask cancels via DELETE.
export async function rejectQuestion(
  sessionID: string,
  id: string,
  v1 = false,
): Promise<boolean> {
  if (!v1)
    return (
      (await sendJson("DELETE", `/api/session/${sessionID}/form/${id}`))?.ok ===
      true
    );
  return (await sendJson("POST", `/question/${id}/reject`))?.ok === true;
}

// `?directory=<worktree>` scopes a session write to its project. Verified
// against GET /doc (CLI 1.18.25): /session/{id} PATCH+DELETE and /session
// GET all take it; /api/session/{id} does not, so these are v1 paths.
const dirQuery = (directory?: string) =>
  directory ? `?directory=${encodeURIComponent(directory)}` : "";

// PATCH /session/{id} — rename. v1 replies the flat row (callers patch the
// list locally instead of parsing it); v2 replies 204 with no body.
export async function renameSession(
  id: string,
  title: string,
  directory?: string,
): Promise<boolean> {
  return (
    (await sendJson(
      "PATCH",
      serverDialect === "v2"
        ? `/api/session/${id}`
        : `/session/${id}${dirQuery(directory)}`,
      { title },
    ))?.ok === true
  );
}

// DELETE /session/{id} — 200/204, empty body.
export async function deleteSession(
  id: string,
  directory?: string,
): Promise<boolean> {
  return (
    (await sendJson(
      "DELETE",
      serverDialect === "v2"
        ? `/api/session/${id}`
        : `/session/${id}${dirQuery(directory)}`,
    ))?.ok === true
  );
}

// POST /session/{id}/revert (v1) / v2's two-step: POST /revert/stage
// {messageID, files?} marks the cut, POST /revert/commit applies it (the
// bare POST /revert 404s on v2 — wire-verified). Rewind semantics: the
// message, its reply, and everything after fold out of the transcript.
// v1 replies the updated session row carrying the revert marker; v2
// commits with 204, so the row is refetched either way.
export async function revertSession(
  id: string,
  messageID: string,
  directory?: string,
): Promise<Session | undefined> {
  if (serverDialect === "v2") {
    const staged = await sendJson("POST", `/api/session/${id}/revert/stage`, {
      messageID,
    });
    if (!staged?.ok) return undefined;
    const committed = await sendJson("POST", `/api/session/${id}/revert/commit`);
    if (!committed?.ok) return undefined;
    return fetchSession(id);
  }
  const res = await sendJson<Session & { directory?: string }>(
    "POST",
    `/session/${id}/revert${dirQuery(directory)}`,
    { messageID },
  );
  const row = res?.data;
  return row ? normalizeSession(row) : undefined;
}

// GET /session?directory= (v1) — a project's sessions, unpaged. Only ids
// are read (project purge). v2 has no directory filter: walk the paginated
// /api/session list and match rows by their location directory (folded for
// the compare — separators and drive-letter case).
export async function fetchProjectSessions(
  directory: string,
): Promise<{ id: string }[] | undefined> {
  if (serverDialect === "v2") {
    const fold = (p: string | undefined) =>
      (p ?? "").replace(/\\/g, "/").replace(/^([a-z]):/i, (m) => m.toUpperCase()).replace(/\/+$/, "");
    const want = fold(directory);
    const out: { id: string }[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const params = new URLSearchParams({ limit: "400" });
      if (cursor) {
        params.set("cursor", cursor);
        params.set("direction", "next");
      }
      const body = await getJson<{
        data?: Session[];
        cursor?: { next?: string };
      }>(`/api/session?${params}`);
      if (!body) break;
      for (const s of body.data ?? [])
        if (fold(s.location?.directory) === want) out.push({ id: s.id });
      if ((body.data?.length ?? 0) < 400) break;
      cursor = body.cursor?.next;
      if (!cursor) break;
    }
    return out;
  }
  return getJson<{ id: string }[]>(
    `/session${dirQuery(directory)}`,
  );
}
