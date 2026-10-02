// Which opencode server dialect a base URL speaks. v1 (opencode-ai 1.x)
// answers GET /api/health with 200 {"healthy":true}; v2 (@opencode/cli 2.x)
// has no health route (404) and serves GET /api/config as a bare ARRAY of
// config source docs (v1 serves the merged config object). Probing works
// for spawned AND attached servers alike; the result is cached per origin.
// Pure module: no Node/vscode/DOM imports, so the webview unit tests can
// exercise the judge directly.
export type Dialect = "v1" | "v2";

// A verdict of "unknown" means no route answered with a shape that names a
// dialect — every probe was unreachable, or an early-init v2 answered with
// its SPA fallback (200 + HTML) instead of the route. Transitional, not a
// fact: the caller re-probes (awaitDialect) instead of acting on it.
export type DialectOrUnknown = Dialect | "unknown";

// One probe reply: an HTTP status plus whatever JSON the body parsed to
// (undefined for non-JSON), or "error" when the fetch itself failed.
export interface ProbeReply {
  status: number;
  json: unknown;
  error?: boolean;
}

// The decision core, split out for tests: a healthy /api/health is v1
// outright; a config array is v2, a config object is v1; anything
// answer-shaped but discriminated by neither (SPA HTML, 404, unreachable)
// is "unknown" — never a dialect guess.
export function judgeDialect(
  health: ProbeReply | "error",
  config: ProbeReply | "error",
): DialectOrUnknown {
  // v1's health route; a JSON body must actually say healthy (a v2 in
  // early init serves the SPA HTML fallback for unknown paths — 200, but
  // not a health reply).
  if (
    health !== "error" &&
    health.status === 200 &&
    (health.json as { healthy?: unknown } | undefined)?.healthy === true
  )
    return "v1";
  if (config !== "error") {
    if (config.status === 200) {
      if (Array.isArray(config.json)) return "v2";
      // v1's merged config object. A non-JSON body (json undefined) is the
      // SPA fallback — unknown, not v1.
      if (config.json && typeof config.json === "object") return "v1";
      return "unknown";
    }
    // v2's config route exists; anything but 200 means the route has not
    // mounted yet (404/5xx mid-boot) or the reply never arrived — retry
    // rather than guess. 401 is an auth wall: a real (if foreign) server
    // is behind it, and the attach path's workspace check has already
    // rejected it — the historic v1 verdict only keeps that final answer.
    if (config.status === 401) return "v1";
    return "unknown";
  }
  return "unknown";
}

const cache = new Map<string, Dialect>();

export function cachedDialect(origin: string): Dialect | undefined {
  return cache.get(origin);
}

type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

async function probe(
  fetchLike: FetchLike,
  url: string,
  headers: Record<string, string>,
): Promise<ProbeReply | "error"> {
  try {
    const res = await fetchLike(url, {
      headers,
      signal: AbortSignal.timeout(2000),
    });
    const ct = (res as { headers?: { get?: (n: string) => string | null } })
      .headers?.get?.("content-type") ?? "";
    return {
      status: res.status,
      // v1 answers unknown GETs with 200 + SPA HTML — only JSON counts.
      json: ct.includes("application/json") ? await res.json() : undefined,
    };
  } catch {
    return "error";
  }
}

// One probe round: the cached verdict, else judge a fresh probe pair. An
// "unknown" verdict is never cached — the next caller re-probes.
async function probeDialect(
  baseUrl: string,
  headers: Record<string, string>,
  fetchLike: FetchLike,
): Promise<DialectOrUnknown> {
  const origin = new URL(baseUrl).origin;
  const cached = cache.get(origin);
  if (cached) return cached;
  const health = await probe(fetchLike, `${origin}/api/health`, headers);
  const config =
    health !== "error" && health.status === 200
      ? { status: 0, json: undefined }
      : await probe(fetchLike, `${origin}/api/config`, headers);
  const dialect = judgeDialect(health, config);
  if (dialect !== "unknown") cache.set(origin, dialect);
  return dialect;
}

export async function detectDialect(
  baseUrl: string,
  headers: Record<string, string> = {},
  fetchLike: FetchLike = (url, init) =>
    fetch(url, init as RequestInit) as Promise<Response>,
): Promise<Dialect> {
  const verdict = await probeDialect(baseUrl, headers, fetchLike);
  // No conclusive answer: keep the historic v1 guess, but leave the cache
  // empty so a later (healthy) detection wins.
  return verdict === "unknown" ? "v1" : verdict;
}

// Poll until a probe round is conclusive — a server that just printed its
// URL can still be mid-init (routes not mounted, SPA fallback answering),
// and a dialect guess baked into the webview page is sticky for the
// server's whole lifetime. Returns the fallback v1 past the deadline.
export async function awaitDialect(
  baseUrl: string,
  headers: Record<string, string> = {},
  fetchLike: FetchLike = (url, init) =>
    fetch(url, init as RequestInit) as Promise<Response>,
  opts: { deadlineMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<Dialect> {
  const deadline = Date.now() + (opts.deadlineMs ?? 60_000);
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  for (;;) {
    const verdict = await probeDialect(baseUrl, headers, fetchLike);
    if (verdict !== "unknown") return verdict;
    if (Date.now() >= deadline) return "v1";
    await sleep(250);
  }
}
