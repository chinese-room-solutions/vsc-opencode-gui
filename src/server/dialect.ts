// Which opencode server dialect a base URL speaks. v1 (opencode-ai 1.x)
// answers GET /api/health with 200 {"healthy":true}; v2 (@opencode/cli 2.x)
// has no health route (404) and serves GET /api/config as a bare ARRAY of
// config source docs (v1 serves the merged config object). Probing works
// for spawned AND attached servers alike; the result is cached per origin.
// Pure module: no Node/vscode/DOM imports, so the webview unit tests can
// exercise the judge directly.
export type Dialect = "v1" | "v2";

// One probe reply: an HTTP status plus whatever JSON the body parsed to
// (undefined for non-JSON), or "error" when the fetch itself failed.
export interface ProbeReply {
  status: number;
  json: unknown;
  error?: boolean;
}

// The decision core, split out for tests: a healthy /api/health is v1
// outright; anything else falls through to the config shape.
export function judgeDialect(
  health: ProbeReply | "error",
  config: ProbeReply | "error",
): Dialect {
  if (health !== "error" && health.status === 200) return "v1";
  if (config !== "error" && config.status === 200 && Array.isArray(config.json))
    return "v2";
  // Unreachable health + non-array config: a v1 server that merely changed
  // its health route is the safer guess — every v2 discriminator failed.
  return "v1";
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

export async function detectDialect(
  baseUrl: string,
  headers: Record<string, string> = {},
  fetchLike: FetchLike = (url, init) =>
    fetch(url, init as RequestInit) as Promise<Response>,
): Promise<Dialect> {
  const origin = new URL(baseUrl).origin;
  const cached = cache.get(origin);
  if (cached) return cached;
  const health = await probe(fetchLike, `${origin}/api/health`, headers);
  const config =
    health !== "error" && health.status === 200
      ? { status: 0, json: undefined }
      : await probe(fetchLike, `${origin}/api/config`, headers);
  const dialect = judgeDialect(health, config);
  cache.set(origin, dialect);
  return dialect;
}
