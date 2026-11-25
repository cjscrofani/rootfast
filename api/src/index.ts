/**
 * Rootfast API — Cloudflare Worker over D1.
 *
 * Endpoints:
 *   GET /healthz
 *   GET /v1/plants                                         — flat list of all plants (paginated, filterable)
 *   GET /v1/plants/:usda_symbol
 *   GET /v1/plants/random
 *   GET /v1/counties                                       — flat list of all US counties
 *   GET /v1/counties/:county_fips/plants
 *   GET /v1/states                                         — list all states with counts
 *   GET /v1/states/:state_code                             — single state header
 *   GET /v1/states/:state_code/plants?limit&offset         — plants in state (paginated)
 *   GET /v1/states/:state_code/counties                    — counties in state with taxa counts
 *   GET /v1/search?q=...
 *   GET /v1/zip/:zip                                        — ZIP → counties + hardiness zone
 *   GET /v1/zip/:zip/plants                                 — plants recorded in the ZIP's counties
 *
 * Listing endpoints (/v1/plants, /v1/counties, /v1/states/{x}/plants, /v1/counties/{x}/plants)
 * support `?format=json|csv|ndjson` for bulk export. Default is json.
 *
 * Error responses are JSON: `{ "error": { "code": "...", "message": "..." } }`.
 *
 * Cache-Control: each endpoint picks the longest sensible TTL given how often
 * the underlying data changes. The dataset only updates when we re-import a
 * SQLite chunk, so most endpoints are aggressively edge-cached (s-maxage)
 * with shorter browser caches (max-age) to keep clients fresh-ish.
 *
 * Cost guards (see ./guard.ts): Cloudflare does not cache a Worker's own
 * responses, so the `s-maxage` above only takes effect because fetch() below
 * stores and serves them through the Cache API. On a miss, every D1 query is
 * metered; expensive answers are also kept in a global response store, and
 * once the day's row budget (DAILY_ROWS_BUDGET) is spent the API stops
 * querying D1 until 00:00 UTC and answers 503 `daily_budget_exhausted`.
 */

import { OPENAPI_SPEC } from "./openapi";
import {
  Meter, meteredDb, canonicalKey, clientBucket, parseBudget, budgetSpent, rowsToday,
  currentUsage, countRequest, syncUsage, syncDue, rollDay, reserveRows, budgetBusy,
  secondsUntilUtcMidnight, readStored, writeStored, worthStoring, storeCandidate,
  BULK_MAX_ROWS, RESERVE_ROWS, RESERVE_ROWS_FINDER, type StoredResponse,
} from "./guard";

/** Bump when a response shape or query result changes without a new dataset
 *  version, so cached answers from the previous deploy are not served. */
const CACHE_EPOCH = "2";

/** Minimal shape of the Workers execution context (waitUntil only). */
interface ExecCtx { waitUntil(p: Promise<unknown>): void }

/** Query parameters that are not §F filters but that some handler reads. */
const ROUTE_PARAMS = ["limit", "offset", "format", "sort", "q", "state", "scope", "lat", "lon"] as const;

/** Every query parameter any handler reads. Anything else is ignored by the
 *  handlers and therefore left out of cache keys. */
function knownParams(): ReadonlySet<string> {
  return new Set<string>([...FILTER_PARAMS, ...ROUTE_PARAMS]);
}

/** Cloudflare Workers ratelimit binding. Minimal local shape — keeps us
 *  off the experimental @cloudflare/workers-types `RateLimit` import. */
interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  DB: D1Database;
  DATASET_VERSION: string;
  /** Rows the API may read from D1 per UTC day. Unset → 4,000,000 (80% of
   *  the Workers Free allowance). "0" disables the budget. */
  DAILY_ROWS_BUDGET?: string;
  RATELIMIT_DEFAULT: RateLimitBinding;
  RATELIMIT_BULK:    RateLimitBinding;
  RATELIMIT_SEARCH:  RateLimitBinding;
}

export default {
  async fetch(req: Request, env: Env, ctx?: ExecCtx): Promise<Response> {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "POST") {
      return errorResponse("method_not_allowed", "Only GET/HEAD/POST supported.", 405);
    }

    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean);
    // POST exists for the plant finder only. Without this a POST to any other
    // route would run its GET handler with no caching at all.
    if (req.method === "POST" && !(parts[0] === "v1" && parts[1] === "plants" && parts[2] === "search" && !parts[3])) {
      return errorResponse("method_not_allowed", "POST is only supported on /v1/plants/search.", 405);
    }
    const later = (p: Promise<unknown>) => { if (ctx) ctx.waitUntil(p); else void p.catch(() => {}); };

    // 1. Edge cache. Costs no D1 rows, so it is answered before the rate
    //    limiter and the budget — an edge-cached answer is always available.
    const key = isCacheableRequest(req, parts)
      ? canonicalKey(url, `${env.DATASET_VERSION}.${CACHE_EPOCH}`, knownParams())
      : null;
    const edge = edgeCache();
    if (key && edge) {
      const hit = await edge.match(key).catch(() => undefined);
      if (hit) {
        countRequest();
        return conditional(req, tagCache(hit, "edge"));
      }
    }

    // 2. Everything below may read D1: meter it against the daily budget.
    const budget = parseBudget(env.DAILY_ROWS_BUDGET);
    rollDay();                                                    // a new UTC day starts a new count
    if (currentUsage().lastSync === 0) await syncUsage(env.DB);   // not yet synced today: learn the total
    const meter = new Meter();
    const menv: Env = { ...env, DB: meteredDb(env.DB, meter) };

    const routed = await routeRequest(req, menv, url, parts, key, budget);
    const res = await withEtag(routed.res);

    // 3. Keep a successful, cacheable answer: at the edge for this location,
    //    and in the global store when it was expensive to compute.
    if (key && res.status === 200 && isStorable(res)) {
      if (edge) later(edge.put(key, res.clone()).catch(() => {}));
      if (!routed.fromStore && storeCandidate(
        meter.rows, res.headers.get("cache-control") || "", res.headers.get("content-disposition"), key,
      )) {
        later(storeIfWorth(menv.DB, key, res.clone(), meter.rows));
      }
    }

    countRequest();
    if (syncDue(currentUsage(), Date.now(), budget)) later(syncUsage(env.DB, Date.now(), budget));
    return conditional(req, tagCache(res, routed.fromStore ? "store" : "miss"));
  },
};

/** GET/HEAD under /v1 can be answered from cache. /healthz is always live. */
function isCacheableRequest(req: Request, parts: string[]): boolean {
  return (req.method === "GET" || req.method === "HEAD") && parts[0] === "v1" && parts.length > 1;
}

/** The Workers edge cache, or null outside the Workers runtime (unit tests). */
function edgeCache(): Cache | null {
  const c = (globalThis as { caches?: { default?: Cache } }).caches;
  return c?.default ?? null;
}

/** A response the caches may keep: a shared-cache lifetime and not `no-store`. */
function isStorable(res: Response): boolean {
  const cc = res.headers.get("cache-control") || "";
  return !cc.includes("no-store") && /s-maxage=[1-9]/.test(cc);
}

/** Copy a response with an `x-rootfast-cache` header saying where it came
 *  from: `edge` (location cache), `store` (global store) or `miss` (computed). */
function tagCache(res: Response, source: "edge" | "store" | "miss"): Response {
  const h = new Headers(res.headers);
  h.set("x-rootfast-cache", source);
  return new Response(res.body, { status: res.status, headers: h });
}

/** Save an expensive answer in the global response store. The caller has
 *  already checked storeCandidate(), so the body is only read for answers
 *  that can qualify. */
async function storeIfWorth(db: D1Database, key: string, res: Response, rowsCost: number): Promise<void> {
  const body = await res.text();
  const bytes = new TextEncoder().encode(body).length;
  if (!worthStoring(rowsCost, bytes)) return;
  await writeStored(db, key, {
    content_type:        res.headers.get("content-type") || "application/json; charset=utf-8",
    cache_control:       res.headers.get("cache-control") || "",
    etag:                res.headers.get("etag"),
    content_disposition: res.headers.get("content-disposition"),
    body,
  }, rowsCost);
}

function fromStored(s: StoredResponse): Response {
  const h: Record<string, string> = {
    "content-type":  s.content_type,
    "cache-control": s.cache_control,
    ...corsHeaders(),
  };
  if (s.etag) h["etag"] = s.etag;
  if (s.content_disposition) h["content-disposition"] = s.content_disposition;
  return new Response(s.body, { status: 200, headers: h });
}

/** 503 sent once the day's D1 row budget is spent. Cached answers keep
 *  flowing (they never reach this point); everything else waits for 00:00 UTC. */
function budgetExhaustedResponse(): Response {
  const retry = secondsUntilUtcMidnight();
  return new Response(
    JSON.stringify({
      error: {
        code: "daily_budget_exhausted",
        message:
          "Rootfast has used today's database allowance. Cached responses are still served; " +
          "everything else resumes at 00:00 UTC. For the whole dataset in one download, see " +
          "https://github.com/cjscrofani/rootfast/releases",
      },
      retry_after: retry,
    }),
    {
      status: 503,
      headers: {
        "content-type":  "application/json; charset=utf-8",
        "retry-after":   String(retry),
        "cache-control": "no-store",
        ...corsHeaders(),
      },
    },
  );
}

/** 503 sent when the budget is NOT spent but requests already running hold
 *  the rest of it. Unlike `daily_budget_exhausted`, retrying soon works. */
function busyResponse(): Response {
  return new Response(
    JSON.stringify({
      error: { code: "busy", message: "The service is at capacity for a moment. Retry in a few seconds." },
      retry_after: 5,
    }),
    {
      status: 503,
      headers: {
        "content-type":  "application/json; charset=utf-8",
        "retry-after":   "5",
        "cache-control": "no-store",
        ...corsHeaders(),
      },
    },
  );
}

async function routeRequest(
  req: Request, env: Env, url: URL, parts: string[], key: string | null, budget: number,
): Promise<{ res: Response; fromStore?: boolean }> {
  let release: (() => void) | null = null;
  try {
    if (parts[0] === "healthz") return { res: await healthz(env, budget) };
    if (parts[0] !== "v1") return { res: notFound() };

    // The spec and the docs page are static: no dataset query, no limiter,
    // no budget.
    if (parts[1] === "openapi.json" && !parts[2]) return { res: openapiJson() };
    if (parts[1] === "docs"         && !parts[2]) return { res: scalarHtml() };

    // Rate limiting. The limiter is picked by route shape: bulk exports and
    // the plant finder are tightly capped; search is moderately capped;
    // everything else uses the default.
    const denial = await enforceRateLimit(req, env, url, parts);
    if (denial) return { res: denial };

    // Global response store: answers that were expensive to compute once.
    // Read before the budget check — it costs one row, and it is what keeps
    // the popular expensive pages working after the budget is spent.
    if (key) {
      const stored = await readStored(env.DB, key);
      if (stored) return { res: fromStored(stored), fromStore: true };
    }

    // Daily D1 row budget — see ./guard.ts. Rows are set aside for this
    // request before it runs, so a burst cannot pass the check together and
    // then overshoot; the reservation is replaced by the true count when the
    // request finishes.
    if (budgetSpent(budget)) return { res: budgetExhaustedResponse() };
    // Other requests in flight already hold what is left of the budget: ask
    // the client to retry in a few seconds rather than "at midnight". A lone
    // request always runs, however little is left.
    if (budgetBusy(budget)) return { res: busyResponse() };
    release = reserveRows(req.method === "POST" ? RESERVE_ROWS_FINDER : RESERVE_ROWS);

    return { res: await routeV1(req, env, url, parts) };
  } catch (err) {
    console.error("Unhandled error:", err);
    return { res: errorResponse("internal_error", "Unexpected error processing the request.", 500) };
  } finally {
    release?.();
  }
}

async function routeV1(req: Request, env: Env, url: URL, parts: string[]): Promise<Response> {

      // /v1/plants/...
      if (parts[1] === "plants") {
        if (!parts[2]) {
          return await listPlants(env, url);
        }
        if (parts[2] === "random" && !parts[3]) {
          return await plantRandom(env);
        }
        if (parts[2] === "search" && !parts[3]) {
          if (req.method !== "POST") {
            return errorResponse("method_not_allowed", "POST required for /v1/plants/search.", 405);
          }
          return await plantFinder(env, req);
        }
        if (parts[2] === "by-gbif" && parts[3] && !parts[4]) {
          return await plantByGbif(env, parts[3]);
        }
        if (parts[2] && parts[3] === "synonyms" && !parts[4]) {
          return await plantSynonyms(env, parts[2]);
        }
        if (parts[2] && !parts[3]) {
          return await plantBySymbol(env, parts[2]);
        }
      }

      // /v1/counties[...]
      if (parts[1] === "counties") {
        if (!parts[2]) {
          return await listCounties(env, url);
        }
        if (parts[2] === "taxa-counts" && !parts[3]) {
          return await listCountyTaxaCounts(env, url);
        }
        if (parts[2] === "photo-coverage" && !parts[3]) {
          return await listCountyPhotoCoverage(env, url);
        }
        if (parts[2] && parts[3] === "plants") {
          return await plantsByCounty(env, parts[2], url);
        }
      }

      // /v1/families
      if (parts[1] === "families" && !parts[2]) {
        return await listFamilies(env);
      }

      // /v1/states[...]
      if (parts[1] === "states") {
        if (!parts[2]) return await listStates(env);
        if (parts[2] === "endemics" && !parts[3]) return await listStateEndemicCounts(env);
        if (parts[2] && !parts[3]) return await stateHeader(env, parts[2]);
        if (parts[2] && parts[3] === "plants")        return await plantsByState(env, parts[2], url);
        if (parts[2] && parts[3] === "counties")      return await countiesByState(env, parts[2]);
        if (parts[2] && parts[3] === "endemic-taxa")  return await endemicTaxaByState(env, parts[2], url);
      }

      // /v1/search?q=
      if (parts[1] === "search" && !parts[2]) {
        return await search(env, url.searchParams.get("q") ?? "");
      }

      // /v1/zip/{zip}[/plants] — locality lookups keyed by US ZIP code
      if (parts[1] === "zip" && parts[2]) {
        if (!parts[3])                          return await zipLookup(env, parts[2]);
        if (parts[3] === "plants" && !parts[4]) return await plantsByZip(env, parts[2], url);
      }

      // /v1/hardiness/...
      if (parts[1] === "hardiness") {
        if (parts[2] === "zones"    && !parts[3])           return await listHardinessZones(env);
        if (parts[2] === "zones"    && parts[3] && !parts[4]) return await hardinessZone(env, parts[3]);
        if (parts[2] === "counties" && !parts[3])           return await listHardinessCounties(env, url);
        if (parts[2] === "zip"      && parts[3] && !parts[4]) return await hardinessByZip(env, parts[3]);
        if (parts[2] === "county"   && parts[3] && !parts[4]) return await hardinessByCounty(env, parts[3]);
        if (parts[2] === "point"    && !parts[3])            return await hardinessByPoint(env, url);
      }

      // /v1/soil/...
      if (parts[1] === "soil") {
        if (parts[2] === "counties" && !parts[3])           return await listSoilByCounty(env, url);
        if (parts[2] === "county"   && parts[3] && !parts[4]) return await soilByCounty(env, parts[3]);
      }

  return notFound();
}

/* --------------------------- Shared helpers --------------------------- */

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin":  "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, accept, if-none-match",
    "access-control-max-age":       "86400",
    "access-control-expose-headers": "etag, retry-after, link, x-total-count, x-rootfast-cache",
    "vary":                          "Origin",
  };
}

/** Cache profiles — `browser` is `max-age`, `edge` is `s-maxage` (seconds). */
const CACHE = {
  none:    { browser: 0,    edge: 0     }, // /healthz, errors
  short:   { browser: 60,   edge: 300   }, // /v1/search
  medium:  { browser: 600,  edge: 86400 }, // state/county listings
  long:    { browser: 3600, edge: 86400 }, // plant detail, counties index
  rotating:{ browser: 0,    edge: 60    }, // /v1/plants/random — short edge so it varies
} as const;
type CacheProfile = keyof typeof CACHE;

export function cacheControl(profile: CacheProfile): string {
  const c = CACHE[profile];
  if (c.browser === 0 && c.edge === 0) return "no-store";
  return `public, max-age=${c.browser}, s-maxage=${c.edge}`;
}

function json(body: unknown, status = 200, cache: CacheProfile = "medium"): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type":  "application/json; charset=utf-8",
      "cache-control": cacheControl(cache),
      ...corsHeaders(),
    },
  });
}

function errorResponse(code: string, message: string, status: number): Response {
  return json({ error: { code, message } }, status, "none");
}

/* --------------------------- ETag wrapper --------------------------- */

/** Compute a short SHA-1-based weak ETag from a response body. */
export async function computeEtag(body: string): Promise<string> {
  const data = new TextEncoder().encode(body);
  const hash = await crypto.subtle.digest("SHA-1", data);
  const hex  = [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("");
  return `W/"${hex.slice(0, 16)}"`;
}

/** Attach a weak ETag to a successful, cacheable response. The tagged 200 is
 *  what the caches store; conditional() turns it into a 304 per request. */
async function withEtag(res: Response): Promise<Response> {
  if (res.status !== 200) return res;                       // only successful, body-bearing responses
  const cc = res.headers.get("cache-control") || "";
  if (cc.includes("no-store") || cc === "")  return res;    // skip uncacheable
  if (res.headers.get("etag")) return res;                  // already set (handler or store)
  // Skip bulk downloads (CSV/NDJSON/GeoJSON exports). They carry a
  // Content-Disposition attachment header and can be several MB; hashing
  // the whole body would burn CPU per request.
  if (res.headers.get("content-disposition")?.includes("attachment")) return res;

  const text = await res.clone().text();
  if (!text) return res;
  const h = new Headers(res.headers);
  h.set("etag", await computeEtag(text));
  return new Response(text, { status: res.status, headers: h });
}

/** If the request's If-None-Match matches the response's ETag, answer 304
 *  with no body; otherwise pass the response through. */
function conditional(req: Request, res: Response): Response {
  const etag = res.headers.get("etag");
  const ifNoneMatch = req.headers.get("if-none-match");
  if (res.status !== 200 || !etag || !ifNoneMatch || ifNoneMatch !== etag) return res;

  const h = new Headers();
  h.set("etag",          etag);
  h.set("cache-control", res.headers.get("cache-control") || "");
  h.set("vary",          res.headers.get("vary") || "Origin");
  const source = res.headers.get("x-rootfast-cache");
  if (source) h.set("x-rootfast-cache", source);
  // Carry CORS so 304s aren't blocked.
  for (const [k, v] of Object.entries(corsHeaders())) h.set(k, v);
  return new Response(null, { status: 304, headers: h });
}

/** Pick the right limiter based on the route, call it, and return a 429
 *  response on rejection. Null means "request may proceed". */
async function enforceRateLimit(
  req: Request,
  env: Env,
  url: URL,
  parts: string[],
): Promise<Response | null> {
  // Per-client keying. Cloudflare's edge sets `cf-connecting-ip` on every
  // request that arrives from the internet, and a client cannot remove it. A
  // request WITHOUT it therefore did not come through the edge: it is the
  // website calling over its service binding (or local `wrangler dev`).
  // Those calls are not limited here, because they would all share one
  // bucket and starve each other. NOTE: that leaves the website's traffic
  // bounded only by the daily row budget unless a rate-limit / challenge
  // rule exists on the rootfast.org zone (see docs/ROLLOUT.md).
  const ip = req.headers.get("cf-connecting-ip");
  if (!ip) return null;
  const client = clientBucket(ip);
  const format = url.searchParams.get("format")?.toLowerCase();
  const isBulkExport = format === "csv" || format === "ndjson";

  // The plant finder (POST /v1/plants/search) aggregates whole states and is
  // never cached, so it shares the tight bulk limiter (under its own key).
  const isFinder = req.method === "POST";
  const isSearch = parts[1] === "search";

  let limiter: RateLimitBinding;
  let tier: "default" | "bulk" | "search" | "finder";
  if (isFinder)           { limiter = env.RATELIMIT_BULK;    tier = "finder"; }
  else if (isBulkExport)  { limiter = env.RATELIMIT_BULK;    tier = "bulk";   }
  else if (isSearch)      { limiter = env.RATELIMIT_SEARCH;  tier = "search"; }
  else                    { limiter = env.RATELIMIT_DEFAULT; tier = "default";}

  // The simple ratelimit binding only keys on the string we pass — combine
  // tier+client so the limiters don't share a single counter accidentally.
  const { success } = await limiter.limit({ key: `${tier}:${client}` });
  if (success) return null;

  return new Response(
    JSON.stringify({
      error: {
        code: "rate_limited",
        message:
          tier === "bulk"
            ? "Bulk-export quota exceeded (2 req/min/IP). Slow down, filter the export, or download the dataset release."
            : tier === "finder"
            ? "Plant-finder quota exceeded (2 req/min/IP)."
            : tier === "search"
            ? "Search quota exceeded (30 req/min/IP)."
            : "Request quota exceeded (60 req/min/IP).",
      },
      tier,
      retry_after: 60,
    }),
    {
      status: 429,
      headers: {
        "content-type":  "application/json; charset=utf-8",
        "retry-after":   "60",
        "cache-control": "no-store",
        ...corsHeaders(),
      },
    },
  );
}

function notFound(message = "Resource not found."): Response {
  return errorResponse("not_found", message, 404);
}

function badRequest(message: string): Response {
  return errorResponse("bad_request", message, 400);
}

/** Parse `?limit=N&offset=N` with sensible defaults + clamps. */
export function parsePaging(url: URL, opts: { defaultLimit: number; maxLimit: number }): {
  limit: number; offset: number;
} {
  const lp = url.searchParams.get("limit");
  const op = url.searchParams.get("offset");
  let limit = lp === null ? opts.defaultLimit : parseInt(lp, 10);
  let offset = op === null ? 0 : parseInt(op, 10);
  if (!Number.isFinite(limit) || limit < 1) limit = opts.defaultLimit;
  if (limit > opts.maxLimit) limit = opts.maxLimit;
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  return { limit, offset };
}

/* --------------------------- Filter parser --------------------------- */

/**
 * Parses listing-endpoint query parameters into SQL fragments. Every value is
 * either matched against an allow-list or coerced to a number, so user input
 * never reaches the SQL string un-validated.
 *
 * Returns `null` if any parameter has a known name but an invalid value —
 * the caller should respond with HTTP 400.
 */

type Ctx = {
  where: string[];
  binds: unknown[];
  needsChars: boolean;
  /** Set only with `deferNativity`: the validated `nativity` values, for
   *  callers that apply the filter against a summary table themselves. */
  nativity?: string[];
};

/** Parse and validate a comma-separated `nativity` value. */
export function parseNativity(raw: string): string[] | null {
  const values = raw.split(",").map(v => v.trim()).filter(Boolean);
  if (values.length === 0) return null;
  for (const v of values) if (!(NATIVITY_VALUES as readonly string[]).includes(v)) return null;
  return values;
}

const NATIVITY_VALUES   = ["Native", "Introduced", "Both"] as const;
const GROWTH_HABITS     = ["Tree","Shrub","Subshrub","Vine","Forb/herb","Forb","Graminoid","Nonvascular","Lichenous"] as const;
const DURATIONS         = ["Annual","Biennial","Perennial"] as const;
const RANKS             = ["Species","Subspecies","Variety","Form"] as const;
const TOLERANCE_HML     = ["High","Medium","Low","None"] as const;
const SHADE_TOLERANCE   = ["Intolerant","Intermediate","Tolerant"] as const;
const GROWTH_RATE       = ["Slow","Moderate","Rapid"] as const;
const TOXICITY          = ["None","Slight","Moderate","Severe"] as const;
const LIFESPAN          = ["Short","Moderate","Long"] as const;
const COMMERCIAL_AVAIL  = ["No Known Source","Routinely Available","Field Collections Only","Contracting Only"] as const;
const WETLAND_CODES     = ["OBL","FACW","FAC","FACU","UPL","NL"] as const;
/** iNaturalist license codes as stored on plants.photo_license. "pd" is
 *  iNat's public-domain mark; "gfdl" appears on a single legacy photo. */
export const PHOTO_LICENSES = ["cc0","pd","cc-by","cc-by-sa","cc-by-nd","cc-by-nc","cc-by-nc-sa","cc-by-nc-nd","gfdl"] as const;
/** The subset of PHOTO_LICENSES that permits commercial reuse. */
export const COMMERCIAL_PHOTO_LICENSES = ["cc0","pd","cc-by","cc-by-sa","cc-by-nd"] as const;

function pushEnum(ctx: Ctx, col: string, raw: string, allowed: readonly string[]): boolean {
  const values = raw.split(",").map(v => v.trim()).filter(Boolean);
  if (values.length === 0) return false;
  for (const v of values) {
    if (!allowed.includes(v)) return false;
  }
  const placeholders = values.map(() => "?").join(",");
  ctx.where.push(`${col} IN (${placeholders})`);
  ctx.binds.push(...values);
  return true;
}

function pushExists(ctx: Ctx, sub: string, col: string, raw: string, allowed: readonly string[]): boolean {
  const values = raw.split(",").map(v => v.trim()).filter(Boolean);
  if (values.length === 0) return false;
  for (const v of values) {
    if (!allowed.includes(v)) return false;
  }
  const placeholders = values.map(() => "?").join(",");
  ctx.where.push(`EXISTS (SELECT 1 FROM ${sub} WHERE ${sub}.plant_id = p.id AND ${col} IN (${placeholders}))`);
  ctx.binds.push(...values);
  return true;
}

function pushRange(ctx: Ctx, col: string, raw: string, op: ">=" | "<="): boolean {
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return false;
  ctx.where.push(`${col} ${op} ?`);
  ctx.binds.push(n);
  return true;
}

function pushBool(ctx: Ctx, col: string, raw: string): boolean {
  const truthy = ["1","true","yes"];
  const falsy  = ["0","false","no"];
  const v = raw.toLowerCase().trim();
  if (truthy.includes(v))      { ctx.where.push(`${col} = 1`); return true; }
  if (falsy.includes(v))       { ctx.where.push(`${col} = 0`); return true; }
  return false;
}

/** Build SQL filters from `?...` query params. `ctx.needsChars` set when a
 *  filter touches `plant_characteristics` — caller adds the LEFT JOIN. */
export function buildFilters(
  searchParams: URLSearchParams,
  opts: { deferNativity?: boolean } = {},
): Ctx | { error: string } {
  const ctx: Ctx = { where: [], binds: [], needsChars: false };

  const eat = (param: string, ok: boolean): string | null => {
    if (!ok) return `Invalid value for "${param}".`;
    return null;
  };

  // Helper: pull a param value if present and non-empty.
  const v = (k: string): string | null => {
    const raw = searchParams.get(k);
    return raw && raw.trim() ? raw : null;
  };

  let err: string | null;

  // Plant-level
  if (v("family")) {
    ctx.where.push(`p.family LIKE ?`);
    ctx.binds.push(v("family")!.replace(/[%_]/g, "") + "%");
  }
  if (v("genus")) {
    ctx.where.push(`p.genus = ?`);
    ctx.binds.push(v("genus"));
  }
  if (v("rank")    && (err = eat("rank",    pushEnum(ctx, "p.rank", v("rank")!, RANKS))))   return { error: err };
  if (v("growth_habit") && (err = eat("growth_habit", pushExists(ctx, "plant_growth_habits", "plant_growth_habits.growth_habit", v("growth_habit")!, GROWTH_HABITS)))) return { error: err };
  if (v("duration")     && (err = eat("duration",     pushExists(ctx, "plant_durations",     "plant_durations.duration",         v("duration")!,     DURATIONS))))     return { error: err };
  if (v("wetland_code") && (err = eat("wetland_code", pushExists(ctx, "plant_wetland_indicators", "plant_wetland_indicators.wetland_code", v("wetland_code")!, WETLAND_CODES)))) return { error: err };

  // bloom_period — free-text vocabulary on plant_characteristics. Accept a
  // comma-separated list and OR them together; case-insensitive equality.
  if (v("bloom_period")) {
    const raw = v("bloom_period")!;
    const values = raw.split(",").map(s => s.trim()).filter(Boolean);
    if (values.length === 0) return { error: 'Invalid value for "bloom_period".' };
    ctx.needsChars = true;
    const placeholders = values.map(() => "LOWER(?)").join(",");
    ctx.where.push(`LOWER(pc.bloom_period) IN (${placeholders})`);
    ctx.binds.push(...values);
  }

  // Distribution-level
  if (v("nativity")) {
    if (opts.deferNativity) {
      const values = parseNativity(v("nativity")!);
      if (!values) return { error: 'Invalid value for "nativity".' };
      ctx.nativity = values;
    } else if ((err = eat("nativity", pushEnum(ctx, "pcd.nativity", v("nativity")!, NATIVITY_VALUES)))) {
      return { error: err };
    }
  }

  // Photo licensing. iNaturalist photos carry the photographer's own CC
  // license; many are NC (non-commercial). `photo_license` restricts rows to
  // the listed license codes (comma-separated, OR). `has_photo` is a plain
  // boolean on the presence of any photo.
  if (v("photo_license") && (err = eat("photo_license", pushEnum(ctx, "p.photo_license", v("photo_license")!.toLowerCase(), PHOTO_LICENSES)))) return { error: err };
  if (v("has_photo")) {
    const raw = v("has_photo")!.toLowerCase().trim();
    if (["1","true","yes"].includes(raw))      ctx.where.push("p.photo_url IS NOT NULL");
    else if (["0","false","no"].includes(raw)) ctx.where.push("p.photo_url IS NULL");
    else return { error: 'Invalid value for "has_photo". Use 1/0, true/false, or yes/no.' };
  }

  // Characteristics — enums
  const charEnum = (param: string, col: string, allowed: readonly string[]): string | null => {
    const raw = v(param);
    if (!raw) return null;
    ctx.needsChars = true;
    return eat(param, pushEnum(ctx, col, raw, allowed));
  };
  if ((err = charEnum("drought_tolerance",       "pc.drought_tolerance",       TOLERANCE_HML))   ) return { error: err };
  if ((err = charEnum("shade_tolerance",         "pc.shade_tolerance",         SHADE_TOLERANCE)) ) return { error: err };
  if ((err = charEnum("moisture_use",            "pc.moisture_use",            TOLERANCE_HML))   ) return { error: err };
  if ((err = charEnum("growth_rate",             "pc.growth_rate",             GROWTH_RATE))     ) return { error: err };
  if ((err = charEnum("toxicity",                "pc.toxicity",                TOXICITY))        ) return { error: err };
  if ((err = charEnum("lifespan",                "pc.lifespan",                LIFESPAN))        ) return { error: err };
  if ((err = charEnum("commercial_availability", "pc.commercial_availability", COMMERCIAL_AVAIL))) return { error: err };
  if ((err = charEnum("fire_tolerance",          "pc.fire_tolerance",          TOLERANCE_HML))   ) return { error: err };
  if ((err = charEnum("salinity_tolerance",      "pc.salinity_tolerance",      TOLERANCE_HML))   ) return { error: err };
  if ((err = charEnum("nitrogen_fixation",       "pc.nitrogen_fixation",       TOLERANCE_HML))   ) return { error: err };

  // Characteristics — booleans
  for (const [param, col] of [
    ["fire_resistant",          "pc.fire_resistant"],
    ["palatable_human",         "pc.palatable_human"],
    ["nursery_stock_product",   "pc.nursery_stock_product"],
    ["berry_nut_seed_product",  "pc.berry_nut_seed_product"],
    ["lumber_product",          "pc.lumber_product"],
  ] as const) {
    const raw = v(param);
    if (raw) {
      ctx.needsChars = true;
      if (!pushBool(ctx, col, raw)) return { error: `Invalid value for "${param}". Use 1/0, true/false, or yes/no.` };
    }
  }

  // Characteristics — colors (free text equality, but case-insensitive).
  for (const [param, col] of [
    ["flower_color",  "pc.flower_color"],
    ["foliage_color", "pc.foliage_color"],
    ["fruit_color",   "pc.fruit_color"],
  ] as const) {
    const raw = v(param);
    if (raw) {
      ctx.needsChars = true;
      ctx.where.push(`LOWER(${col}) = LOWER(?)`);
      ctx.binds.push(raw);
    }
  }

  // Characteristics — numeric ranges
  const ranges: [string, string, ">=" | "<="][] = [
    ["min_height_ft",          "pc.height_mature_ft",       ">="],
    ["max_height_ft",          "pc.height_mature_ft",       "<="],
    ["min_ph",                 "pc.ph_min",                 ">="],
    ["max_ph",                 "pc.ph_max",                 "<="],
    ["min_precipitation_in",   "pc.precipitation_min_in",   ">="],
    ["max_precipitation_in",   "pc.precipitation_max_in",   "<="],
    ["min_frost_free_days",    "pc.frost_free_days_min",    ">="],
    ["min_temperature_f",      "pc.temperature_min_f",      ">="],
    ["max_temperature_f",      "pc.temperature_min_f",      "<="],
    ["min_root_depth_in",      "pc.root_depth_min_in",      ">="],
  ];
  for (const [param, col, op] of ranges) {
    const raw = v(param);
    if (raw) {
      ctx.needsChars = true;
      if (!pushRange(ctx, col, raw, op)) return { error: `Invalid number for "${param}".` };
    }
  }

  // Distribution-range filters: how many counties a plant is recorded in,
  // nationally. Useful for "rarities" / "widespread" queries on /v1/plants.
  // Reads the precomputed plant_range_summary (migration 008) through its
  // county_count index instead of grouping plant_county_distribution.
  const minCounties = v("min_counties");
  const maxCounties = v("max_counties");
  if (minCounties || maxCounties) {
    const min = minCounties ? Number.parseInt(minCounties, 10) : null;
    const max = maxCounties ? Number.parseInt(maxCounties, 10) : null;
    if ((min !== null && (!Number.isFinite(min) || min < 0)) ||
        (max !== null && (!Number.isFinite(max) || max < 0))) {
      return { error: `Invalid integer for min_counties/max_counties.` };
    }
    const conds: string[] = [];
    const binds: unknown[] = [];
    if (min !== null) { conds.push(">= ?"); binds.push(min); }
    if (max !== null) { conds.push("<= ?"); binds.push(max); }
    // Subquery returns plant_ids whose county count satisfies the bounds.
    ctx.where.push(
      `p.id IN (
         SELECT plant_id
           FROM plant_range_summary
          WHERE ${conds.map(c => `county_count ${c}`).join(" AND ")}
       )`
    );
    ctx.binds.push(...binds);
  }

  return ctx;
}

/** Echo back the user-supplied filter values (only the ones we recognize)
 *  so clients can read what was actually applied. */
const FILTER_PARAMS = new Set([
  "family","genus","rank","growth_habit","duration","nativity","wetland_code","bloom_period",
  "photo_license","has_photo",
  "drought_tolerance","shade_tolerance","moisture_use","growth_rate",
  "toxicity","lifespan","commercial_availability","fire_tolerance",
  "salinity_tolerance","nitrogen_fixation",
  "fire_resistant","palatable_human","nursery_stock_product",
  "berry_nut_seed_product","lumber_product",
  "flower_color","foliage_color","fruit_color",
  "min_height_ft","max_height_ft","min_ph","max_ph",
  "min_precipitation_in","max_precipitation_in",
  "min_frost_free_days","min_temperature_f","max_temperature_f",
  "min_root_depth_in",
  "min_counties","max_counties",
]);

function filtersEcho(url: URL): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const [k, v] of url.searchParams) {
    // First value wins — the one the handlers and the cache key use.
    if (FILTER_PARAMS.has(k) && v && !(k in out)) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/* --------------------------- Format helpers --------------------------- */

type ResponseFormat = "json" | "csv" | "ndjson" | "geojson";
const VALID_FORMATS: readonly ResponseFormat[] = ["json", "csv", "ndjson", "geojson"];

export function parseFormat(url: URL, allowed: readonly ResponseFormat[] = ["json","csv","ndjson"]): ResponseFormat | { error: string } {
  const raw = url.searchParams.get("format");
  if (!raw) return "json";
  const lower = raw.toLowerCase() as ResponseFormat;
  if (!VALID_FORMATS.includes(lower)) {
    return { error: `Unsupported format "${raw}". Use one of: ${VALID_FORMATS.join(", ")}.` };
  }
  if (!allowed.includes(lower)) {
    return { error: `Format "${raw}" is not supported on this endpoint. Use one of: ${allowed.join(", ")}.` };
  }
  return lower;
}

/** Quote a CSV value per RFC 4180. */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  const s = String(v);
  // Quote if it contains comma, quote, newline, or carriage return.
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function toCsv(rows: Record<string, unknown>[], columns?: string[]): string {
  if (rows.length === 0) return columns ? columns.join(",") + "\n" : "";
  const cols = columns ?? Object.keys(rows[0]!);
  const head = cols.join(",");
  const body = rows.map(r => cols.map(c => csvCell(r[c])).join(",")).join("\n");
  return head + "\n" + body + "\n";
}

export function toNdjson(rows: unknown[]): string {
  return rows.map(r => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
}

/** Format-aware response wrapper. JSON falls through to `json()`; CSV/NDJSON
 *  return a text response with the right Content-Type and a download filename. */
function formattedResponse(
  format: ResponseFormat,
  rows: Record<string, unknown>[],
  jsonBody: unknown,
  opts: {
    status?: number;
    cache?: CacheProfile;
    filename: string;       // for Content-Disposition
    columns?: string[];     // optional CSV column order
    /** For CSV / NDJSON, which have no envelope: lets the response say how
     *  many rows exist in total and where the next page is. */
    page?: { url: URL; total: number; limit: number; offset: number };
  },
): Response {
  const status = opts.status ?? 200;
  const cache  = opts.cache  ?? "medium";

  if (format === "json") return json(jsonBody, status, cache);

  const headers: Record<string, string> = {
    "cache-control":       cacheControl(cache),
    "content-disposition": `attachment; filename="${opts.filename}.${format}"`,
    ...corsHeaders(),
    ...bulkPagingHeaders(opts.page, rows.length),
  };

  if (format === "csv") {
    headers["content-type"] = "text/csv; charset=utf-8";
    return new Response(toCsv(rows, opts.columns), { status, headers });
  }
  // ndjson
  headers["content-type"] = "application/x-ndjson; charset=utf-8";
  return new Response(toNdjson(rows), { status, headers });
}

/** `x-total-count`, plus a `link: <...>; rel="next"` when rows remain past
 *  this page. Bulk exports are capped per call (BULK_MAX_ROWS); without these
 *  a truncated CSV would look complete. Exported for tests. */
export function bulkPagingHeaders(
  page: { url: URL; total: number; limit: number; offset: number } | undefined,
  returned: number,
): Record<string, string> {
  if (!page) return {};
  const out: Record<string, string> = { "x-total-count": String(page.total) };
  const nextOffset = page.offset + returned;
  if (returned > 0 && nextOffset < page.total) {
    const next = new URL(page.url.toString());
    next.searchParams.set("limit", String(page.limit));
    next.searchParams.set("offset", String(nextOffset));
    out["link"] = `<${next.toString()}>; rel="next"`;
  }
  return out;
}

/* --------------------------- Endpoints --------------------------- */

/**
 * GET /healthz
 *
 * Liveness plus provenance. Everything beyond `ok` comes from the
 * `schema_meta` key/value table, which migrations fill with the schema
 * version and `api/scripts/populate_meta.sql` fills with dataset counts
 * and source pull dates at build time. `dataset_version` falls back to the
 * DATASET_VERSION Worker var when the build has not stamped one.
 */
async function healthz(env: Env, budget: number): Promise<Response> {
  // /healthz is exempt from the limiter and the budget so it always answers,
  // which makes it an open path to D1. schema_meta only changes on a deploy
  // or data load, so each isolate reads it at most once a minute.
  const now = Date.now();
  if (!healthMemo || now - healthMemo.at >= HEALTH_META_TTL_MS) {
    const rows = await env.DB.prepare("SELECT key, value FROM schema_meta").all<{ key: string; value: string }>();
    healthMemo = { at: now, meta: buildHealthMeta(rows.results ?? []) };
  }
  const meta = healthMemo.meta;
  return json({
    ok: true,
    dataset_version: meta.get("dataset_version") ?? env.DATASET_VERSION,
    dataset_date:    meta.get("dataset_date") ?? null,
    schema_version:  meta.get("schema_version") ?? null,
    api_version:     OPENAPI_SPEC.info.version,
    sources: {
      usda_plants_pulled:       meta.get("source_usda_plants_pulled") ?? null,
      usda_hardiness_edition:   meta.get("source_usda_hardiness_edition") ?? null,
      census_zcta_vintage:      meta.get("source_census_zcta_vintage") ?? null,
      inaturalist_photos_pulled: meta.get("source_inaturalist_photos_pulled") ?? null,
    },
    counts: {
      taxa:                 metaInt(meta, "count_taxa"),
      states:               metaInt(meta, "count_states"),
      counties:             metaInt(meta, "count_counties"),
      distribution_records: metaInt(meta, "count_distribution"),
      photos:               metaInt(meta, "count_photos"),
      hardiness_zips:       metaInt(meta, "count_hardiness_zips"),
      hardiness_counties:   metaInt(meta, "count_hardiness_counties"),
      zip_counties:         metaInt(meta, "count_zip_counties"),
    },
    usage: usageReport(budget),
    releases: "https://github.com/cjscrofani/rootfast/releases",
  }, 200, "none");
}

/** Today's D1 usage as this isolate knows it. Other isolates report in
 *  batches (every FLUSH_ROWS rows or FLUSH_MS), so the figure can trail the
 *  true total by a couple of minutes. */
function usageReport(budget: number): Record<string, unknown> {
  const u = currentUsage();
  return {
    day:               u.day,
    rows_read:         rowsToday(),
    daily_rows_budget: Number.isFinite(budget) ? budget : null,
    budget_exhausted:  budgetSpent(budget),
    resets_in_seconds: secondsUntilUtcMidnight(),
  };
}

const HEALTH_META_TTL_MS = 60_000;
let healthMemo: { at: number; meta: Map<string, string> } | null = null;

/** Collapse schema_meta rows into a map. Exported for tests. */
export function buildHealthMeta(rows: { key: string; value: string }[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of rows) if (r.key && r.value != null) m.set(r.key, String(r.value));
  return m;
}

/** Read an integer meta value, or null when absent / unparsable. */
export function metaInt(meta: Map<string, string>, key: string): number | null {
  const raw = meta.get(key);
  if (raw == null) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

async function plantBySymbol(env: Env, symbol: string): Promise<Response> {
  const plant = await env.DB.prepare(
    `SELECT p2.*
       FROM plants p1
       LEFT JOIN plants p2 ON p2.id = COALESCE(p1.accepted_plant_id, p1.id)
      WHERE p1.usda_symbol = ?1`
  ).bind(symbol.toUpperCase()).first();

  if (!plant) return notFound(`No plant with USDA symbol "${symbol.toUpperCase()}".`);

  const id = plant.id as number;
  const [habits, durations, nativeStatus, chars, counties] = await Promise.all([
    env.DB.prepare("SELECT growth_habit FROM plant_growth_habits WHERE plant_id = ?1").bind(id).all(),
    env.DB.prepare("SELECT duration FROM plant_durations WHERE plant_id = ?1").bind(id).all(),
    env.DB.prepare("SELECT region_code, status FROM plant_native_status WHERE plant_id = ?1").bind(id).all(),
    env.DB.prepare("SELECT * FROM plant_characteristics WHERE plant_id = ?1").bind(id).first(),
    env.DB.prepare(
      `SELECT pcd.county_fips, c.county_name, c.state_code, pcd.nativity
         FROM plant_county_distribution pcd
         JOIN counties c ON c.county_fips = pcd.county_fips
        WHERE pcd.plant_id = ?1
        ORDER BY c.state_code, c.county_name`
    ).bind(id).all(),
  ]);

  const p = plant as Record<string, unknown>;
  const photo = p['photo_url']
    ? {
        source:      p['photo_source'],
        source_id:   p['photo_source_id'],
        taxon_id:    p['photo_taxon_id'],
        url:         p['photo_url'],
        thumb_url:   p['photo_thumb_url'],
        license:     p['photo_license'],
        attribution: p['photo_attribution'],
      }
    : null;

  return json({
    plant,
    photo,
    growth_habits: (habits.results ?? []).map((r: any) => r.growth_habit),
    durations: (durations.results ?? []).map((r: any) => r.duration),
    native_status: nativeStatus.results ?? [],
    characteristics: chars,
    counties: counties.results ?? [],
  }, 200, "long");
}

async function listPlants(env: Env, url: URL): Promise<Response> {
  const format = parseFormat(url);
  if (typeof format === "object") return badRequest(format.error);

  const f = buildFilters(url.searchParams);
  if ("error" in f) return badRequest(f.error);

  // Bulk downloads (CSV/NDJSON) return up to BULK_MAX_ROWS per call and page
  // with `offset`; JSON keeps its 5000/10000 pagination.
  const isBulk = format !== "json";
  const { limit, offset } = parsePaging(url, {
    defaultLimit: isBulk ? BULK_MAX_ROWS : 5000,
    maxLimit:     isBulk ? BULK_MAX_ROWS : 10000,
  });

  const charJoin = f.needsChars
    ? "LEFT JOIN plant_characteristics pc ON pc.plant_id = p.id"
    : "";
  // Drop pcd-based filters for this endpoint — there's no distribution join.
  // If the user passed `nativity`, reject with a helpful message.
  if (url.searchParams.get("nativity")) {
    return badRequest('"nativity" filter is not supported on /v1/plants; use /v1/states/{code}/plants or /v1/counties/{fips}/plants.');
  }
  const extraWhere = f.where.length ? " AND " + f.where.join(" AND ") : "";

  // Plant rows (one row per taxon, no distribution rollup).
  const columns =
    `p.usda_symbol, p.scientific_name, p.scientific_name_canonical,
            p.common_name, p.family, p.genus, p.rank,
            p.gbif_taxon_key, p.gbif_canonical_name,
            p.gbif_match_type, p.gbif_match_status,
            p.is_synonym, p.accepted_plant_id,
            p.photo_url, p.photo_thumb_url, p.photo_license, p.photo_attribution`;

  let plants: Record<string, unknown>[];
  let total: number;
  if (f.where.length === 0) {
    // Unfiltered: walk plant_name_rank (accepted taxa in scientific-name
    // order, migration 008) and stop after one page, instead of reading and
    // sorting all of `plants`. The total is the highest rank — ranks are
    // dense, so that IS the accepted-taxa count, read as one index row and
    // always consistent with the rows returned.
    const rows = await env.DB.prepare(
      `SELECT ${columns}
         FROM plant_name_rank r
         JOIN plants p ON p.id = r.plant_id
        ORDER BY r.name_rank
        LIMIT ? OFFSET ?`
    ).bind(limit, offset).all();
    plants = (rows.results ?? []) as Record<string, unknown>[];
    total = (await env.DB.prepare(
      "SELECT MAX(name_rank) AS n FROM plant_name_rank"
    ).first<{ n: number | null }>())?.n ?? 0;
  } else {
    const rows = await env.DB.prepare(
      `SELECT ${columns}
         FROM plants p
         ${charJoin}
        WHERE p.is_synonym = 0
          AND p.is_excluded = 0
          ${extraWhere}
        ORDER BY p.scientific_name
        LIMIT ? OFFSET ?`
    ).bind(...f.binds, limit, offset).all();
    plants = (rows.results ?? []) as Record<string, unknown>[];

    const totalRow = await env.DB.prepare(
      `SELECT COUNT(*) AS n
         FROM plants p
         ${charJoin}
        WHERE p.is_synonym = 0
          AND p.is_excluded = 0
          ${extraWhere}`
    ).bind(...f.binds).first<{ n: number }>();
    total = totalRow?.n ?? 0;
  }

  return formattedResponse(format, plants, {
    count: plants.length,
    total,
    paging: { limit, offset, has_more: offset + plants.length < total },
    filters: filtersEcho(url),
    plants,
  }, {
    cache:    isBulk ? "long" : "medium",
    filename: "rootfast-plants",
    page:     { url, total, limit, offset },
  });
}

/**
 * POST /v1/plants/search
 *
 * Body: {
 *   counties?: string[],           // FIPS codes; union semantics
 *   states?:   string[],           // state codes; expanded to all of their counties
 *                                  //   (ignored if `counties` is also provided)
 *   include_counties?: boolean,    // include matching_counties array per plant (default false)
 *   limit?:    number,             // default 200, max 1000
 *   filters?:  Record<string,...>  // same keys as the §F GET filter params
 * }
 *
 * Response: { scope, counts, plants: [...] } where each plant carries
 *   matching_county_count, requested_county_count, and match_score
 *   (matches / requested), allowing the caller to rank by geographic fit.
 */
async function plantFinder(env: Env, req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    const text = await req.text();
    body = text ? JSON.parse(text) : {};
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return badRequest("Request body must be a JSON object.");
    }
  } catch {
    return badRequest("Body is not valid JSON.");
  }

  // Validate counties / states.
  const reqCounties = arrayOfStrings(body.counties, "counties");
  if ("error" in reqCounties) return badRequest(reqCounties.error);
  const reqStates   = arrayOfStrings(body.states,   "states");
  if ("error" in reqStates) return badRequest(reqStates.error);
  if (reqCounties.value.length === 0 && reqStates.value.length === 0) {
    return badRequest('Provide at least one of "counties" or "states".');
  }

  // Expand state codes → counties unless explicit counties were provided.
  let scopeCounties: string[];
  if (reqCounties.value.length > 0) {
    scopeCounties = reqCounties.value.map(c => String(c)).slice(0, 2000);
  } else {
    const placeholders = reqStates.value.map(() => "?").join(",");
    const expanded = await env.DB.prepare(
      `SELECT county_fips FROM counties WHERE state_code IN (${placeholders})`
    ).bind(...reqStates.value.map(s => s.toUpperCase())).all();
    scopeCounties = (expanded.results ?? []).map((r: any) => r.county_fips);
    if (scopeCounties.length === 0) {
      return badRequest("None of the requested states have counties in the catalogue.");
    }
    if (scopeCounties.length > 2000) {
      return badRequest("Resolved scope exceeds 2000 counties. Narrow your states.");
    }
  }

  // Convert body.filters into URLSearchParams so we reuse buildFilters().
  const params = new URLSearchParams();
  const filtersIn = (body.filters ?? {}) as Record<string, unknown>;
  if (typeof filtersIn !== "object" || filtersIn === null || Array.isArray(filtersIn)) {
    return badRequest('"filters" must be an object.');
  }
  for (const [k, v] of Object.entries(filtersIn)) {
    if (v === null || v === undefined || v === "") continue;
    params.set(k, Array.isArray(v) ? v.join(",") : String(v));
  }
  // Allow `nativity` as a top-level shortcut too.
  if (typeof body.nativity === "string") params.set("nativity", body.nativity);

  const f = buildFilters(params);
  if ("error" in f) return badRequest(f.error);

  const charJoin = f.needsChars
    ? "LEFT JOIN plant_characteristics pc ON pc.plant_id = p.id"
    : "";
  const extraWhere = f.where.length ? " AND " + f.where.join(" AND ") : "";

  const limit = clampInt(body.limit, 200, 1, 1000);
  const includeCounties = body.include_counties === true;

  const placeholders = scopeCounties.map(() => "?").join(",");
  const sql =
    `SELECT p.usda_symbol, p.scientific_name, p.common_name, p.family,
            p.photo_thumb_url, p.photo_license,
            COUNT(DISTINCT pcd.county_fips)                                          AS matching_county_count,
            SUM(CASE WHEN pcd.nativity = 'Native'     THEN 1 ELSE 0 END)             AS native_counties,
            SUM(CASE WHEN pcd.nativity = 'Introduced' THEN 1 ELSE 0 END)             AS introduced_counties,
            SUM(CASE WHEN pcd.nativity = 'Both'       THEN 1 ELSE 0 END)             AS both_counties
            ${includeCounties ? `, GROUP_CONCAT(DISTINCT pcd.county_fips) AS county_fips_csv` : ""}
       FROM plants p
       JOIN plant_county_distribution pcd ON pcd.plant_id  = p.id
       ${charJoin}
      WHERE pcd.county_fips IN (${placeholders})
        AND p.is_synonym = 0
        AND p.is_excluded = 0
        ${extraWhere}
      GROUP BY p.id
      ORDER BY matching_county_count DESC, p.scientific_name
      LIMIT ?`;

  const rows = await env.DB.prepare(sql)
    .bind(...scopeCounties, ...f.binds, limit)
    .all();

  const requested = scopeCounties.length;
  const plants = (rows.results ?? []).map((r: any) => {
    const matches = Number(r.matching_county_count);
    const out: Record<string, unknown> = {
      usda_symbol:           r.usda_symbol,
      scientific_name:       r.scientific_name,
      common_name:           r.common_name,
      family:                r.family,
      photo_thumb_url:       r.photo_thumb_url,
      photo_license:         r.photo_license,
      matching_county_count: matches,
      requested_county_count: requested,
      match_score:           Math.round((matches / requested) * 10000) / 10000,
      nativity_rollup:       aggregateNativity(
        Number(r.native_counties),
        Number(r.introduced_counties),
        Number(r.both_counties),
      ),
    };
    if (includeCounties && r.county_fips_csv) {
      out.matching_counties = String(r.county_fips_csv).split(",").sort();
    }
    return out;
  });

  return json({
    scope: {
      counties_requested: requested,
      states_requested:   reqStates.value.length ? reqStates.value.map(s => s.toUpperCase()) : null,
    },
    filters: Object.keys(filtersIn).length ? filtersIn : null,
    nativity: typeof body.nativity === "string" ? body.nativity : null,
    count: plants.length,
    limit,
    plants,
  }, 200, "short");
}

function arrayOfStrings(v: unknown, name: string): { value: string[] } | { error: string } {
  if (v === undefined || v === null) return { value: [] };
  if (!Array.isArray(v)) return { error: `"${name}" must be an array of strings.` };
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string" || !item.trim()) {
      return { error: `"${name}" entries must be non-empty strings.` };
    }
    out.push(item.trim());
  }
  return { value: out };
}

export function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : Number.parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

async function plantSynonyms(env: Env, symbol: string): Promise<Response> {
  const sym = symbol.toUpperCase();
  // Resolve through synonyms to the accepted plant. The symbol can sit in
  // any of: plants (accepted), plants (synonym row with accepted_plant_id),
  // plant_synonyms (synonym-only, no plant row of its own).
  let accepted = await env.DB.prepare(
    `SELECT p2.id, p2.usda_symbol, p2.scientific_name, p2.scientific_name_canonical,
            p2.common_name, p2.family, p2.gbif_taxon_key
       FROM plants p1
       LEFT JOIN plants p2 ON p2.id = COALESCE(p1.accepted_plant_id, p1.id)
      WHERE p1.usda_symbol = ?`
  ).bind(sym).first<{
    id: number;
    usda_symbol: string;
    scientific_name: string;
    scientific_name_canonical: string;
    common_name: string | null;
    family: string | null;
    gbif_taxon_key: number | null;
  }>();

  if (!accepted) {
    // Try the synonyms tab — maybe this is a synonym-only USDA symbol.
    accepted = await env.DB.prepare(
      `SELECT p.id, p.usda_symbol, p.scientific_name, p.scientific_name_canonical,
              p.common_name, p.family, p.gbif_taxon_key
         FROM plant_synonyms s
         JOIN plants p ON p.id = s.accepted_plant_id
        WHERE s.synonym_usda_symbol = ?
        LIMIT 1`
    ).bind(sym).first();
  }

  if (!accepted) return notFound(`No plant with USDA symbol "${sym}".`);

  // Pull synonyms from two sources in parallel:
  //   1. plant_synonyms — USDA's Synonyms tab (names without their own plant row)
  //   2. plants table — rows whose accepted_plant_id points back to this taxon
  //                     (these have a USDA symbol of their own)
  const [tabRows, plantRows] = await Promise.all([
    env.DB.prepare(
      `SELECT synonym_usda_symbol AS usda_symbol,
              synonym_scientific_name AS scientific_name
         FROM plant_synonyms
        WHERE accepted_plant_id = ?
        ORDER BY synonym_scientific_name`
    ).bind(accepted.id).all(),
    env.DB.prepare(
      `SELECT usda_symbol, scientific_name, scientific_name_canonical,
              common_name, rank, is_excluded
         FROM plants
        WHERE accepted_plant_id = ?
          AND id != ?
        ORDER BY scientific_name`
    ).bind(accepted.id, accepted.id).all(),
  ]);

  // Combine + dedupe by usda_symbol. Prefer the plants-table source when
  // the same symbol shows up in both (it carries more fields).
  const seen = new Set<string>();
  const synonyms: Array<Record<string, unknown>> = [];

  for (const r of (plantRows.results ?? []) as any[]) {
    const sym = String(r.usda_symbol);
    if (seen.has(sym)) continue;
    seen.add(sym);
    synonyms.push({
      usda_symbol:               r.usda_symbol,
      scientific_name:           r.scientific_name,
      scientific_name_canonical: r.scientific_name_canonical,
      common_name:               r.common_name,
      rank:                      r.rank,
      is_excluded:               r.is_excluded,
      source:                    "plants_table",
    });
  }
  for (const r of (tabRows.results ?? []) as any[]) {
    const sym = String(r.usda_symbol);
    if (seen.has(sym)) continue;
    seen.add(sym);
    synonyms.push({
      usda_symbol:     r.usda_symbol,
      scientific_name: r.scientific_name,
      source:          "usda_synonyms_tab",
    });
  }

  return json({
    accepted: {
      usda_symbol:               accepted.usda_symbol,
      scientific_name:           accepted.scientific_name,
      scientific_name_canonical: accepted.scientific_name_canonical,
      common_name:               accepted.common_name,
      family:                    accepted.family,
      gbif_taxon_key:            accepted.gbif_taxon_key,
    },
    queried_symbol: sym,
    resolved_from_synonym: sym !== accepted.usda_symbol,
    count: synonyms.length,
    synonyms,
  }, 200, "long");
}

async function plantByGbif(env: Env, raw: string): Promise<Response> {
  const key = Number.parseInt(raw, 10);
  if (!Number.isFinite(key) || key <= 0) {
    return badRequest(`GBIF taxon_key must be a positive integer; got "${raw}".`);
  }
  // Prefer accepted (non-synonym, non-excluded) rows when multiple plants
  // map to the same GBIF key — GBIF resolves synonyms upstream too, so
  // collisions are normal and the accepted one is the authoritative entry.
  const row = await env.DB.prepare(
    `SELECT usda_symbol
       FROM plants
      WHERE gbif_taxon_key = ?
      ORDER BY is_synonym ASC, is_excluded ASC, usda_symbol ASC
      LIMIT 1`
  ).bind(key).first<{ usda_symbol: string }>();
  if (!row) return notFound(`No plant matched to GBIF taxon_key ${key}.`);
  return plantBySymbol(env, row.usda_symbol);
}

async function plantRandom(env: Env): Promise<Response> {
  // An accepted taxon with a photo, so the random pick looks good.
  // `ORDER BY RANDOM()` over `plants` read all ~27,700 rows on every call.
  // Instead pick a random position in plant_name_rank (accepted taxa in name
  // order, migration 008) and take the first taxon with a photo at or after
  // it — a handful of rows. Wraps to the start if the tail has none.
  const max = (await env.DB.prepare(
    "SELECT MAX(name_rank) AS m FROM plant_name_rank"
  ).first<{ m: number | null }>())?.m ?? 0;
  if (!max) return notFound("No plants in catalogue.");
  const pick = (from: number) => env.DB.prepare(
    `SELECT p.usda_symbol, p.scientific_name, p.common_name, p.family,
            p.photo_thumb_url, p.photo_url
       FROM plant_name_rank r
       JOIN plants p ON p.id = r.plant_id
      WHERE r.name_rank >= ?1
        AND p.photo_url IS NOT NULL
        AND p.rank IN ('Species','Subspecies','Variety','Form')
      ORDER BY r.name_rank
      LIMIT 1`
  ).bind(from).first();
  const row = (await pick(1 + Math.floor(Math.random() * max))) ?? (await pick(1));
  if (!row) return notFound("No plants in catalogue.");
  return json({ plant: row }, 200, "rotating");
}

async function plantsByCounty(env: Env, fips: string, url: URL): Promise<Response> {
  const format = parseFormat(url);
  if (typeof format === "object") return badRequest(format.error);

  // County header plus its precomputed accepted-taxa counts (migration 008).
  const head = await env.DB.prepare(
    `SELECT c.county_fips, c.county_name, c.state_code,
            s.accepted_count, s.native_count, s.introduced_count, s.both_count
       FROM counties c
       LEFT JOIN county_taxa_summary s ON s.county_fips = c.county_fips
      WHERE c.county_fips = ?`
  ).bind(fips).first<{
    county_fips: string; county_name: string; state_code: string;
    accepted_count: number | null; native_count: number | null;
    introduced_count: number | null; both_count: number | null;
  }>();
  if (!head) return notFound(`No county with FIPS "${fips}".`);
  const county = { county_fips: head.county_fips, county_name: head.county_name, state_code: head.state_code };

  const f = buildFilters(url.searchParams, { deferNativity: true });
  if ("error" in f) return badRequest(f.error);

  const isBulk = format !== "json";
  const { limit, offset } = parsePaging(url, {
    defaultLimit: isBulk ? BULK_MAX_ROWS : 50,
    maxLimit:     isBulk ? BULK_MAX_ROWS : 1000,
  });
  const sortClause = parseSortCounty(url);
  if ("error" in sortClause) return badRequest(sortClause.error);

  const charJoin = f.needsChars
    ? "LEFT JOIN plant_characteristics pc ON pc.plant_id = p.id"
    : "";
  const nat = f.nativity ?? null;
  const natWhere = nat ? ` AND cp.nativity IN (${nat.map(() => "?").join(",")})` : "";
  const natBinds = nat ?? [];
  const extraWhere = f.where.length ? " AND " + f.where.join(" AND ") : "";

  // Total under the same filter scope. With no filter beyond nativity it is
  // a sum of the precomputed per-nativity counts (each record carries exactly
  // one nativity); otherwise count the county's rows in county_plants.
  let total: number;
  if (f.where.length === 0 && head.accepted_count !== null) {
    total = countyTotalFromSummary(head, nat);
  } else {
    const totalRow = await env.DB.prepare(
      `SELECT COUNT(*) AS n
         FROM county_plants cp
         JOIN plants p ON p.id = cp.plant_id
         ${charJoin}
        WHERE cp.county_fips = ?
          ${natWhere}
          ${extraWhere}`
    ).bind(fips, ...natBinds, ...f.binds).first<{ n: number }>();
    total = totalRow?.n ?? 0;
  }

  // county_plants holds accepted taxa only, clustered by (county, name_rank),
  // so the default scientific-name order walks the primary key and stops
  // after one page instead of reading and sorting the whole county.
  const orderBy = sortClause.value === "p.scientific_name" ? "cp.name_rank" : sortClause.value;
  const sql =
    `SELECT p.usda_symbol, p.scientific_name, p.common_name, p.family,
            p.photo_thumb_url, p.photo_license,
            cp.nativity
       FROM county_plants cp
       JOIN plants p ON p.id = cp.plant_id
       ${charJoin}
      WHERE cp.county_fips = ?
        ${natWhere}
        ${extraWhere}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?`;
  const rows = await env.DB.prepare(sql).bind(fips, ...natBinds, ...f.binds, limit, offset).all();
  const plants = (rows.results ?? []) as Record<string, unknown>[];

  return formattedResponse(format, plants, {
    county,
    count: plants.length,
    total,
    paging: { limit, offset, has_more: offset + plants.length < total },
    sort: url.searchParams.get("sort") ?? "sci",
    filters: filtersEcho(url),
    plants,
  }, {
    cache:    "medium",
    filename: `rootfast-county-${fips}-plants`,
    page:     { url, total, limit, offset },
  });
}

/** A county's accepted-taxa total, optionally restricted to nativity values,
 *  from its county_taxa_summary row. Exported for tests. */
export function countyTotalFromSummary(
  s: { accepted_count: number | null; native_count: number | null; introduced_count: number | null; both_count: number | null },
  nativity: string[] | null,
): number {
  if (!nativity) return Number(s.accepted_count ?? 0);
  const want = new Set(nativity);
  return (want.has("Native")     ? Number(s.native_count ?? 0)     : 0)
       + (want.has("Introduced") ? Number(s.introduced_count ?? 0) : 0)
       + (want.has("Both")       ? Number(s.both_count ?? 0)       : 0);
}

/** SQL for a state_plants rollup restricted to the requested nativity values.
 *  The inputs are validated enum values, so the result holds no user text.
 *  Exported for tests. */
export function stateRollupSql(nativity: string[] | null): {
  native: string; introduced: string; both: string; counties: string; where: string;
} {
  const want = nativity ? new Set(nativity) : null;
  const native     = !want || want.has("Native")     ? "sp.native_counties"     : "0";
  const introduced = !want || want.has("Introduced") ? "sp.introduced_counties" : "0";
  const both       = !want || want.has("Both")       ? "sp.both_counties"       : "0";
  const counties   = want ? `(${native} + ${introduced} + ${both})` : "sp.county_count";
  return { native, introduced, both, counties, where: want ? ` AND ${counties} > 0` : "" };
}

/** Sort options for county-plant listings — county listings have no county
 *  aggregation, so we offer scientific / common name ordering only. */
function parseSortCounty(url: URL): { value: string } | { error: string } {
  const raw = (url.searchParams.get("sort") ?? "sci").toLowerCase();
  switch (raw) {
    case "sci":    return { value: "p.scientific_name" };
    case "common": return { value: "COALESCE(NULLIF(p.common_name, ''), p.scientific_name)" };
    default: return { error: `Unsupported sort "${raw}". Use one of: sci, common.` };
  }
}

/** Sort options for state-plant listings — same plus a "counties" mode that
 *  ranks by how many counties the taxon appears in (descending). */
function parseSortState(url: URL): { value: string } | { error: string } {
  const raw = (url.searchParams.get("sort") ?? "sci").toLowerCase();
  switch (raw) {
    case "sci":      return { value: "p.scientific_name" };
    case "common":   return { value: "COALESCE(NULLIF(p.common_name, ''), p.scientific_name)" };
    case "counties": return { value: "county_count DESC, p.scientific_name" };
    default: return { error: `Unsupported sort "${raw}". Use one of: sci, common, counties.` };
  }
}

async function search(env: Env, q: string): Promise<Response> {
  if (!q || q.length < 2) {
    return json({ query: q, results: [] }, 200, "short");
  }
  const safe = q.replace(/[^A-Za-z0-9 ]/g, " ").trim();
  if (!safe) return json({ query: q, results: [] }, 200, "short");

  const results = await env.DB.prepare(
    `SELECT p.usda_symbol, p.scientific_name, p.common_name, p.family,
            p.photo_thumb_url
       FROM plants_fts
       JOIN plants p ON p.id = plants_fts.rowid
      WHERE plants_fts MATCH ?1
        AND p.is_synonym = 0
        AND p.is_excluded = 0
      ORDER BY plants_fts.rank
      LIMIT 25`
  ).bind(safe).all();

  return json({ query: q, results: results.results ?? [] }, 200, "short");
}

/* --------------------------- Counties --------------------------- */

async function listCounties(env: Env, url: URL): Promise<Response> {
  const format = parseFormat(url, ["json","csv","ndjson","geojson"]);
  if (typeof format === "object") return badRequest(format.error);

  const isBulk = format !== "json";
  const { limit, offset } = parsePaging(url, {
    defaultLimit: isBulk ? 5000 : 500,
    maxLimit:     5000,
  });
  const stateFilter = url.searchParams.get("state");

  const where = stateFilter ? "WHERE state_code = ?1" : "";
  const bind: unknown[] = [];
  if (stateFilter) bind.push(stateFilter.toUpperCase());

  const totalRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM counties ${where}`
  ).bind(...bind).first<{ n: number }>();
  const total = totalRow?.n ?? 0;

  const rows = await env.DB.prepare(
    `SELECT county_fips, county_name, state_code, centroid_lat, centroid_lon
       FROM counties
       ${where}
      ORDER BY state_code, county_name
      LIMIT ?${bind.length + 1} OFFSET ?${bind.length + 2}`
  ).bind(...bind, limit, offset).all();
  const counties = (rows.results ?? []) as Record<string, unknown>[];

  if (format === "geojson") {
    return geoJsonCountiesResponse(counties, {
      filename: stateFilter ? `rootfast-counties-${stateFilter.toUpperCase()}` : "rootfast-counties",
    });
  }

  return formattedResponse(format, counties, {
    count: counties.length,
    total,
    limit,
    offset,
    has_more: offset + counties.length < total,
    counties,
  }, {
    cache:    "long",
    filename: stateFilter ? `rootfast-counties-${stateFilter.toUpperCase()}` : "rootfast-counties",
    page:     { url, total, limit, offset },
  });
}

/** Build a GeoJSON FeatureCollection from county rows. Each feature is a
 *  Point at the county centroid; properties carry FIPS, name, state. */
function geoJsonCountiesResponse(
  rows: Record<string, unknown>[],
  opts: { filename: string },
): Response {
  const features = rows
    .filter(r => r.centroid_lat !== null && r.centroid_lon !== null)
    .map(r => ({
      type: "Feature",
      id: r.county_fips,
      geometry: {
        type: "Point",
        coordinates: [Number(r.centroid_lon), Number(r.centroid_lat)],
      },
      properties: {
        county_fips: r.county_fips,
        county_name: r.county_name,
        state_code:  r.state_code,
      },
    }));

  const body = JSON.stringify({
    type: "FeatureCollection",
    count: features.length,
    features,
  });

  return new Response(body, {
    status: 200,
    headers: {
      "content-type":        "application/geo+json; charset=utf-8",
      "cache-control":       cacheControl("long"),
      "content-disposition": `attachment; filename="${opts.filename}.geojson"`,
      ...corsHeaders(),
    },
  });
}

/* --------------------------- States --------------------------- */

async function listStates(env: Env): Promise<Response> {
  // States with no ingested distribution data are filtered out here. They
  // still exist in the `states` table (so /v1/states/{code} keeps working
  // for direct lookups) — only the list endpoint hides them.
  // state_taxa_summary (migration 008) has a row only for states with
  // distribution data, so the JOIN is also the filter.
  const states = await env.DB.prepare(
    `SELECT s.state_code, s.state_name, s.state_fips, s.country,
            t.county_count, t.taxa_count
       FROM states s
       JOIN state_taxa_summary t ON t.state_code = s.state_code
      ORDER BY s.state_name`
  ).all();

  return json({
    count: states.results?.length ?? 0,
    states: states.results ?? [],
  }, 200, "medium");
}

async function stateHeader(env: Env, code: string): Promise<Response> {
  const sc = code.toUpperCase();
  // Counts come from state_taxa_summary (migration 008). A state with no
  // distribution data has no summary row: count its counties, report 0 taxa.
  const state = await env.DB.prepare(
    `SELECT s.state_code, s.state_name, s.state_fips, s.country,
            COALESCE(t.county_count,
                     (SELECT COUNT(*) FROM counties c WHERE c.state_code = s.state_code)) AS county_count,
            COALESCE(t.taxa_count, 0) AS taxa_count
       FROM states s
       LEFT JOIN state_taxa_summary t ON t.state_code = s.state_code
      WHERE s.state_code = ?1`
  ).bind(sc).first();
  if (!state) return notFound(`No state with code "${sc}".`);
  return json({ state }, 200, "medium");
}

async function plantsByState(env: Env, code: string, url: URL): Promise<Response> {
  const format = parseFormat(url);
  if (typeof format === "object") return badRequest(format.error);

  const sc = code.toUpperCase();
  // State header plus its precomputed counts (migration 008).
  const head = await env.DB.prepare(
    `SELECT s.state_code, s.state_name, s.state_fips, s.country,
            t.county_count, t.accepted_count, t.native_count, t.introduced_count, t.both_count
       FROM states s
       LEFT JOIN state_taxa_summary t ON t.state_code = s.state_code
      WHERE s.state_code = ?`
  ).bind(sc).first<{
    state_code: string; state_name: string; state_fips: string | null; country: string | null;
    county_count: number | null; accepted_count: number | null; native_count: number | null;
    introduced_count: number | null; both_count: number | null;
  }>();
  if (!head) return notFound(`No state with code "${sc}".`);
  const state = {
    state_code: head.state_code, state_name: head.state_name,
    state_fips: head.state_fips, country: head.country,
  };

  const f = buildFilters(url.searchParams, { deferNativity: true });
  if ("error" in f) return badRequest(f.error);

  const isBulk = format !== "json";
  const { limit, offset } = parsePaging(url, {
    defaultLimit: isBulk ? BULK_MAX_ROWS : 50,
    maxLimit:     isBulk ? BULK_MAX_ROWS : 10000,
  });
  const sortClause = parseSortState(url);
  if ("error" in sortClause) return badRequest(sortClause.error);

  const charJoin = f.needsChars
    ? "LEFT JOIN plant_characteristics pc ON pc.plant_id = p.id"
    : "";
  const extraWhere = f.where.length ? " AND " + f.where.join(" AND ") : "";

  // state_plants (migration 008) holds one row per accepted taxon per state
  // with its county rollup, clustered in scientific-name order. A `nativity`
  // filter keeps only the counties with those flags, exactly as filtering the
  // distribution rows before aggregating did.
  const nat = f.nativity ?? null;
  const roll = stateRollupSql(nat);

  // County count for the state (summary row, or a count for a state that has
  // no distribution data and therefore no summary).
  const countyCount = head.county_count ?? (await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM counties WHERE state_code = ?"
  ).bind(sc).first<{ n: number }>())?.n ?? 0;

  // Total taxa under the same filters: precomputed when the only filter is
  // none or a single nativity value, counted from state_plants otherwise.
  let totalTaxa: number;
  if (f.where.length === 0 && !nat) {
    totalTaxa = Number(head.accepted_count ?? 0);
  } else if (f.where.length === 0 && nat && nat.length === 1 && head.accepted_count !== null) {
    totalTaxa = Number(
      nat[0] === "Native" ? head.native_count
        : nat[0] === "Introduced" ? head.introduced_count
        : head.both_count
    ) || 0;
  } else {
    const totalRow = await env.DB.prepare(
      `SELECT COUNT(*) AS n
         FROM state_plants sp
         JOIN plants p ON p.id = sp.plant_id
         ${charJoin}
        WHERE sp.state_code = ?
          ${roll.where}
          ${extraWhere}`
    ).bind(sc, ...f.binds).first<{ n: number }>();
    totalTaxa = totalRow?.n ?? 0;
  }

  // The default order walks the primary key (state_code, scientific_name).
  const orderBy = sortClause.value === "p.scientific_name" ? "sp.scientific_name" : sortClause.value;
  const pageSql =
    `SELECT p.usda_symbol, p.scientific_name, p.common_name, p.family,
            p.photo_thumb_url,
            ${roll.counties}   AS county_count,
            ${roll.native}     AS native_counties,
            ${roll.introduced} AS introduced_counties,
            ${roll.both}       AS both_counties
       FROM state_plants sp
       JOIN plants p ON p.id = sp.plant_id
       ${charJoin}
      WHERE sp.state_code = ?
        ${roll.where}
        ${extraWhere}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?`;
  const rows = await env.DB.prepare(pageSql).bind(sc, ...f.binds, limit, offset).all();

  const plants = (rows.results ?? []).map((r: any) => ({
    ...r,
    nativity: aggregateNativity(
      Number(r.native_counties),
      Number(r.introduced_counties),
      Number(r.both_counties),
    ),
  }));

  return formattedResponse(format, plants, {
    state,
    counts: {
      taxa:     totalTaxa,
      counties: countyCount,
    },
    paging: {
      limit, offset,
      count: plants.length,
      has_more: offset + plants.length < totalTaxa,
    },
    filters: filtersEcho(url),
    plants,
  }, {
    cache:    "medium",
    filename: `rootfast-${sc}-plants`,
    page:     { url, total: totalTaxa, limit, offset },
  });
}

async function countiesByState(env: Env, code: string): Promise<Response> {
  const sc = code.toUpperCase();
  const state = await env.DB.prepare(
    "SELECT state_code, state_name, state_fips, country FROM states WHERE state_code = ?1"
  ).bind(sc).first();
  if (!state) return notFound(`No state with code "${sc}".`);

  // taxa_count comes from county_taxa_summary (migration 006). Counting the
  // distribution rows per county here used to read ~69,000 rows per call and
  // was two thirds of the API's entire D1 usage.
  const counties = await env.DB.prepare(
    `SELECT c.county_fips, c.county_name, c.state_code,
            c.centroid_lat, c.centroid_lon,
            COALESCE(s.taxa_count, 0) AS taxa_count
       FROM counties c
       LEFT JOIN county_taxa_summary s ON s.county_fips = c.county_fips
      WHERE c.state_code = ?1
      ORDER BY c.county_name`
  ).bind(sc).all();

  return json({
    state,
    count: counties.results?.length ?? 0,
    counties: counties.results ?? [],
  }, 200, "medium");
}

export function aggregateNativity(native: number, introduced: number, both: number): "Native" | "Introduced" | "Both" {
  if (both > 0) return "Both";
  if (native > 0 && introduced > 0) return "Both";
  if (introduced > 0) return "Introduced";
  return "Native";
}

/* ----------------------------- Soil ----------------------------- */

/** Bulk: every county with a sampled soil profile. Used by the soil map. */
async function listSoilByCounty(env: Env, url: URL): Promise<Response> {
  const state = (url.searchParams.get("state") || "").trim().toUpperCase();
  if (state && !/^[A-Z]{2}$/.test(state)) {
    return badRequest(`Invalid state code "${state}".`);
  }
  const sql = state
    ? `SELECT s.county_fips, c.county_name, c.state_code,
              s.muname, s.dominant_comp, s.drainage_class, s.texture_class,
              s.surface_ph, s.surface_om_pct, s.slope_pct,
              s.surface_sand_pct, s.surface_silt_pct, s.surface_clay_pct,
              s.awc_in_top_25cm
         FROM soil_by_county s
         JOIN counties c ON c.county_fips = s.county_fips
        WHERE c.state_code = ?
        ORDER BY s.county_fips`
    : `SELECT s.county_fips, c.county_name, c.state_code,
              s.muname, s.dominant_comp, s.drainage_class, s.texture_class,
              s.surface_ph, s.surface_om_pct, s.slope_pct,
              s.surface_sand_pct, s.surface_silt_pct, s.surface_clay_pct,
              s.awc_in_top_25cm
         FROM soil_by_county s
         JOIN counties c ON c.county_fips = s.county_fips
        ORDER BY s.county_fips`;
  const rows = await (state
    ? env.DB.prepare(sql).bind(state).all()
    : env.DB.prepare(sql).all());
  const counties = rows.results ?? [];
  return json({ count: counties.length, counties }, 200, "long");
}

/** Single county soil profile. */
async function soilByCounty(env: Env, raw: string): Promise<Response> {
  const fips = raw.trim().padStart(5, "0");
  if (!/^[0-9]{5}$/.test(fips)) {
    return badRequest(`Invalid county FIPS "${raw}". Expected 5 digits.`);
  }
  const row = await env.DB.prepare(
    `SELECT s.*, c.county_name, c.state_code
       FROM soil_by_county s
       JOIN counties c ON c.county_fips = s.county_fips
      WHERE s.county_fips = ?`
  ).bind(fips).first();
  if (!row) {
    // Distinguish "county exists but no soil" from "no such county".
    const cty = await env.DB.prepare(
      "SELECT county_fips, county_name, state_code FROM counties WHERE county_fips = ?"
    ).bind(fips).first();
    if (cty) {
      return json({
        county: cty,
        soil: null,
        note: "County exists but no SSURGO sample at its centroid (territory or water-heavy geometry).",
      }, 200, "long");
    }
    return notFound(`No county with FIPS "${fips}".`);
  }
  const r = row as Record<string, unknown>;
  return json({
    county: { county_fips: r['county_fips'], county_name: r['county_name'], state_code: r['state_code'] },
    soil: {
      mukey:            r['mukey'],
      muname:           r['muname'],
      dominant_comp:    r['dominant_comp'],
      drainage_class:   r['drainage_class'],
      texture_class:    r['texture_class'],
      slope_pct:        r['slope_pct'],
      surface_ph:       r['surface_ph'],
      surface_om_pct:   r['surface_om_pct'],
      surface_sand_pct: r['surface_sand_pct'],
      surface_silt_pct: r['surface_silt_pct'],
      surface_clay_pct: r['surface_clay_pct'],
      awc_in_top_25cm:  r['awc_in_top_25cm'],
    },
  }, 200, "long");
}

/* ------------------------- OpenAPI / Scalar UI ------------------------ */

function openapiJson(): Response {
  return new Response(JSON.stringify(OPENAPI_SPEC), {
    status: 200,
    headers: {
      "content-type":  "application/json; charset=utf-8",
      "cache-control": cacheControl("long"),
      ...corsHeaders(),
    },
  });
}

function scalarHtml(): Response {
  // Single self-contained page that loads Scalar from a CDN and points it
  // at our spec URL. Keep the HTML small and CSP-clean.
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Rootfast API — interactive docs</title>
<style>
  body { margin: 0; background: #faf6ee; }
  noscript { display:block; padding:2rem; font-family: ui-serif, Georgia, serif; }
</style>
</head>
<body>
<noscript>This page requires JavaScript. The spec is also available at <a href="/v1/openapi.json">/v1/openapi.json</a>.</noscript>
<script
  id="api-reference"
  data-url="/v1/openapi.json"
  data-configuration='{"theme":"default","layout":"modern","hideDownloadButton":false,"defaultHttpClient":{"targetKey":"shell","clientKey":"curl"}}'
></script>
<script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "content-type":  "text/html; charset=utf-8",
      "cache-control": cacheControl("long"),
      ...corsHeaders(),
    },
  });
}

/* ----------------------------- Hardiness ----------------------------- */

/** List all 26 canonical USDA Plant Hardiness Zone Map (2023) zones with
 *  the temperature range and counts of ZIPs/counties currently mapped. */
async function listHardinessZones(env: Env): Promise<Response> {
  const zones = await env.DB.prepare(
    `SELECT hz.zone_code, hz.zone_class_code, hz.temp_min_f, hz.temp_max_f, hz.description,
            (SELECT COUNT(*) FROM hardiness_zones_by_zip    z WHERE z.zone_code = hz.zone_code) AS zip_count,
            (SELECT COUNT(*) FROM hardiness_zones_by_county c WHERE c.zone_code = hz.zone_code) AS county_count
       FROM hardiness_zones hz
      ORDER BY hz.zone_class_code`
  ).all();
  return json({
    count: zones.results?.length ?? 0,
    zones: zones.results ?? [],
  }, 200, "long");
}

/** Single zone detail with the same counts. */
async function hardinessZone(env: Env, code: string): Promise<Response> {
  const zc = code.trim().toLowerCase();
  if (!/^([1-9]|1[0-3])[ab]$/.test(zc)) {
    return badRequest(`Invalid zone code "${code}". Expected e.g. "5a", "13b".`);
  }
  const zone = await env.DB.prepare(
    `SELECT hz.zone_code, hz.zone_class_code, hz.temp_min_f, hz.temp_max_f, hz.description,
            (SELECT COUNT(*) FROM hardiness_zones_by_zip    z WHERE z.zone_code = hz.zone_code) AS zip_count,
            (SELECT COUNT(*) FROM hardiness_zones_by_county c WHERE c.zone_code = hz.zone_code) AS county_count
       FROM hardiness_zones hz
      WHERE hz.zone_code = ?1`
  ).bind(zc).first();
  if (!zone) return notFound(`No hardiness zone "${zc}".`);
  return json({ zone }, 200, "long");
}

/** ZIP → hardiness zone. Accepts ZIP and ZIP+4; trims to the first 5 digits. */
/** Normalise user ZIP input: strip non-digits, keep the 5-digit ZIP from a
 *  ZIP+4. Returns null when fewer than five digits remain. Exported for tests. */
export function normalizeZip(raw: string): string | null {
  const digits = raw.replace(/[^0-9]/g, "").slice(0, 5);
  return digits.length === 5 ? digits : null;
}

async function hardinessByZip(env: Env, raw: string): Promise<Response> {
  const digits = normalizeZip(raw);
  if (!digits) {
    return badRequest(`Invalid ZIP "${raw}". Must be a 5-digit ZIP code.`);
  }
  const row = await env.DB.prepare(
    `SELECT z.zip_code,
            hz.zone_code, hz.zone_class_code, hz.temp_min_f, hz.temp_max_f, hz.description
       FROM hardiness_zones_by_zip z
       JOIN hardiness_zones        hz ON hz.zone_code = z.zone_code
      WHERE z.zip_code = ?1`
  ).bind(digits).first<{
    zip_code: string;
    zone_code: string;
    zone_class_code: number;
    temp_min_f: number;
    temp_max_f: number;
    description: string;
  }>();
  if (!row) return notFound(`No hardiness data for ZIP "${digits}".`);
  return json({
    zip_code: row.zip_code,
    zone: {
      zone_code:        row.zone_code,
      zone_class_code:  row.zone_class_code,
      temp_min_f:       row.temp_min_f,
      temp_max_f:       row.temp_max_f,
      description:      row.description,
    },
  }, 200, "long");
}

/* --------------------------- ZIP locality --------------------------- */

type ZipCounty = {
  county_fips: string;
  county_name: string;
  state_code:  string;
  land_share:  number;
  taxa_count:  number;
};

/** Counties a ZIP overlaps, largest land share first. Reads the Census
 *  ZCTA crosswalk (migration 007) joined to the county taxa summary (006). */
async function zipCounties(env: Env, zip: string): Promise<ZipCounty[]> {
  const rows = await env.DB.prepare(
    `SELECT zc.county_fips, c.county_name, c.state_code, zc.land_share,
            COALESCE(s.taxa_count, 0) AS taxa_count
       FROM zip_counties zc
       JOIN counties c            ON c.county_fips = zc.county_fips
       LEFT JOIN county_taxa_summary s ON s.county_fips = zc.county_fips
      WHERE zc.zip_code = ?1
      ORDER BY zc.land_share DESC, zc.county_fips`
  ).bind(zip).all<ZipCounty>();
  return rows.results ?? [];
}

type ZoneRow = {
  zone_code: string; zone_class_code: number;
  temp_min_f: number; temp_max_f: number; description: string;
};

async function zipZone(env: Env, zip: string): Promise<ZoneRow | null> {
  return await env.DB.prepare(
    `SELECT hz.zone_code, hz.zone_class_code, hz.temp_min_f, hz.temp_max_f, hz.description
       FROM hardiness_zones_by_zip z
       JOIN hardiness_zones hz ON hz.zone_code = z.zone_code
      WHERE z.zip_code = ?1`
  ).bind(zip).first<ZoneRow>();
}

const ZIP_CROSSWALK_NOTE =
  "County mapping comes from the US Census 2020 ZCTA-to-county relationship file. " +
  "PO-box-only ZIPs have no ZCTA and will not resolve. land_share is the fraction of the " +
  "ZIP's land area inside each county; the first county listed is the primary one.";

/**
 * GET /v1/zip/{zip}
 *
 * One call to turn a ZIP into everything locality-shaped we know: the
 * county (or counties) it covers, with taxa counts, plus the USDA hardiness
 * zone. 404 only when neither source knows the ZIP.
 */
async function zipLookup(env: Env, raw: string): Promise<Response> {
  const zip = normalizeZip(raw);
  if (!zip) return badRequest(`Invalid ZIP "${raw}". Must be a 5-digit ZIP code.`);

  const [counties, zone] = await Promise.all([zipCounties(env, zip), zipZone(env, zip)]);
  if (counties.length === 0 && !zone) {
    return notFound(`No county or hardiness data for ZIP "${zip}".`);
  }
  return json({
    zip_code:       zip,
    primary_county: counties[0] ?? null,
    counties,
    zone:           zone ?? null,
    note:           ZIP_CROSSWALK_NOTE,
    links: {
      plants: `/v1/zip/${zip}/plants`,
      native_plants: `/v1/zip/${zip}/plants?nativity=Native`,
    },
  }, 200, "long");
}

/** `scope` for /v1/zip/{zip}/plants: union across every overlapping county
 *  (default) or just the primary one. Exported for tests. */
export function parseZipScope(url: URL): "all" | "primary" | { error: string } {
  const raw = (url.searchParams.get("scope") ?? "all").toLowerCase();
  if (raw === "all" || raw === "primary") return raw;
  return { error: `Unsupported scope "${raw}". Use one of: all, primary.` };
}

/**
 * GET /v1/zip/{zip}/plants
 *
 * "What grows where I live?" — every taxon recorded in the county (or
 * counties) a ZIP covers, with the same §F filters, paging, and bulk
 * formats as the state/county listings. Rows are aggregated per taxon
 * across the ZIP's counties, so `nativity` is the rollup used by
 * /v1/states/{code}/plants ("Native" / "Introduced" / "Both").
 */
async function plantsByZip(env: Env, raw: string, url: URL): Promise<Response> {
  const zip = normalizeZip(raw);
  if (!zip) return badRequest(`Invalid ZIP "${raw}". Must be a 5-digit ZIP code.`);

  const format = parseFormat(url);
  if (typeof format === "object") return badRequest(format.error);
  const scope = parseZipScope(url);
  if (typeof scope === "object") return badRequest(scope.error);

  const f = buildFilters(url.searchParams);
  if ("error" in f) return badRequest(f.error);
  const sortClause = parseSortState(url);
  if ("error" in sortClause) return badRequest(sortClause.error);

  const [allCounties, zone] = await Promise.all([zipCounties(env, zip), zipZone(env, zip)]);
  if (allCounties.length === 0) {
    return notFound(`No county mapping for ZIP "${zip}" (PO-box-only ZIPs have no Census ZCTA).`);
  }
  const counties = scope === "primary" ? allCounties.slice(0, 1) : allCounties;
  const fipsList = counties.map(c => c.county_fips);
  const fipsPlaceholders = fipsList.map(() => "?").join(",");

  const isBulk = format !== "json";
  const { limit, offset } = parsePaging(url, {
    defaultLimit: isBulk ? BULK_MAX_ROWS : 50,
    maxLimit:     isBulk ? BULK_MAX_ROWS : 10000,
  });

  const charJoin = f.needsChars
    ? "LEFT JOIN plant_characteristics pc ON pc.plant_id = p.id"
    : "";
  const extraWhere = f.where.length ? " AND " + f.where.join(" AND ") : "";

  const totalSql =
    `SELECT COUNT(*) AS n FROM (
       SELECT p.id
         FROM plants p
         JOIN plant_county_distribution pcd ON pcd.plant_id = p.id
         ${charJoin}
        WHERE pcd.county_fips IN (${fipsPlaceholders})
          AND p.is_synonym = 0
          AND p.is_excluded = 0
          ${extraWhere}
        GROUP BY p.id
     )`;
  const totalRow = await env.DB.prepare(totalSql).bind(...fipsList, ...f.binds).first<{ n: number }>();
  const total = totalRow?.n ?? 0;

  const pageSql =
    `SELECT p.usda_symbol, p.scientific_name, p.common_name, p.family,
            p.photo_thumb_url, p.photo_license,
            COUNT(*)                                                     AS county_count,
            SUM(CASE WHEN pcd.nativity = 'Native'     THEN 1 ELSE 0 END) AS native_counties,
            SUM(CASE WHEN pcd.nativity = 'Introduced' THEN 1 ELSE 0 END) AS introduced_counties,
            SUM(CASE WHEN pcd.nativity = 'Both'       THEN 1 ELSE 0 END) AS both_counties
       FROM plants p
       JOIN plant_county_distribution pcd ON pcd.plant_id = p.id
       ${charJoin}
      WHERE pcd.county_fips IN (${fipsPlaceholders})
        AND p.is_synonym = 0
        AND p.is_excluded = 0
        ${extraWhere}
      GROUP BY p.id
      ORDER BY ${sortClause.value}
      LIMIT ? OFFSET ?`;
  const rows = await env.DB.prepare(pageSql).bind(...fipsList, ...f.binds, limit, offset).all();

  const plants = (rows.results ?? []).map((r: any) => ({
    ...r,
    nativity: aggregateNativity(
      Number(r.native_counties),
      Number(r.introduced_counties),
      Number(r.both_counties),
    ),
  }));

  return formattedResponse(format, plants, {
    zip_code: zip,
    scope,
    zone: zone ?? null,
    counties,
    counts: { taxa: total, counties: counties.length },
    paging: { limit, offset, count: plants.length, has_more: offset + plants.length < total },
    sort: url.searchParams.get("sort") ?? "sci",
    filters: filtersEcho(url),
    note: ZIP_CROSSWALK_NOTE,
    plants,
  }, {
    cache:    "medium",
    filename: `rootfast-zip-${zip}-plants`,
    page:     { url, total, limit, offset },
  });
}

/** Bulk: every county with its taxa count. Used by the biodiversity-by-county
 *  map visualization. Returns all ~3,227 US counties in one response. */
async function listCountyTaxaCounts(env: Env, url: URL): Promise<Response> {
  const state = (url.searchParams.get("state") || "").trim().toUpperCase();
  if (state && !/^[A-Z]{2}$/.test(state)) {
    return badRequest(`Invalid state code "${state}". Use the two-letter USPS code.`);
  }
  // Reads the precomputed county_taxa_summary (migration 006) instead of
  // scanning plant_county_distribution per county.
  const sql = state
    ? `SELECT c.county_fips, c.county_name, c.state_code, s.taxa_count
         FROM counties c
         JOIN county_taxa_summary s ON s.county_fips = c.county_fips
        WHERE c.state_code = ?
        ORDER BY c.county_fips`
    : `SELECT c.county_fips, c.county_name, c.state_code, s.taxa_count
         FROM counties c
         JOIN county_taxa_summary s ON s.county_fips = c.county_fips
        ORDER BY c.county_fips`;
  const rows = await (state
    ? env.DB.prepare(sql).bind(state).all()
    : env.DB.prepare(sql).all());
  const counties = rows.results ?? [];
  return json({ count: counties.length, counties }, 200, "long");
}

/** Per-county photo coverage: total taxa, taxa with photos, percentage.
 *  Used by /explore/photo-coverage-map. */
async function listCountyPhotoCoverage(env: Env, url: URL): Promise<Response> {
  const state = (url.searchParams.get("state") || "").trim().toUpperCase();
  if (state && !/^[A-Z]{2}$/.test(state)) {
    return badRequest(`Invalid state code "${state}".`);
  }
  // Reads the precomputed county_taxa_summary (migration 006) instead of
  // grouping plant_county_distribution × plants for every county.
  const sql = state
    ? `SELECT c.county_fips, c.county_name, c.state_code, s.taxa_count, s.photo_count
         FROM counties c
         JOIN county_taxa_summary s ON s.county_fips = c.county_fips
        WHERE c.state_code = ?
        ORDER BY c.county_fips`
    : `SELECT c.county_fips, c.county_name, c.state_code, s.taxa_count, s.photo_count
         FROM counties c
         JOIN county_taxa_summary s ON s.county_fips = c.county_fips
        ORDER BY c.county_fips`;
  const rows = await (state
    ? env.DB.prepare(sql).bind(state).all()
    : env.DB.prepare(sql).all());
  const counties = (rows.results ?? []).map((r: any) => ({
    county_fips: r.county_fips,
    county_name: r.county_name,
    state_code:  r.state_code,
    taxa_count:  r.taxa_count,
    photo_count: r.photo_count,
    photo_pct:   r.taxa_count > 0
      ? Math.round((r.photo_count / r.taxa_count) * 1000) / 10
      : 0,
  }));
  return json({ count: counties.length, counties }, 200, "long");
}

/** Per-state count of endemic taxa — plants recorded in this state ONLY.
 *  Used by /explore/state-endemics. */
async function listStateEndemicCounts(env: Env): Promise<Response> {
  // Reads the precomputed plant_endemic_state (migration 006). Accepted-only,
  // so endemic_count matches the taxa the /endemic-taxa endpoint returns.
  const rows = await env.DB.prepare(
    `SELECT s.state_code, s.state_name, s.country,
            COUNT(e.plant_id) AS endemic_count
       FROM states s
       JOIN plant_endemic_state e ON e.state_code = s.state_code
      GROUP BY s.state_code, s.state_name, s.country
      ORDER BY endemic_count DESC, s.state_name`
  ).all();
  const states = rows.results ?? [];
  return json({ count: states.length, states }, 200, "long");
}

/** Paginated list of a state's endemic taxa (plants recorded ONLY in that state). */
async function endemicTaxaByState(env: Env, code: string, url: URL): Promise<Response> {
  const sc = code.toUpperCase();
  const state = await env.DB.prepare(
    "SELECT state_code, state_name FROM states WHERE state_code = ?"
  ).bind(sc).first();
  if (!state) return notFound(`No state with code "${sc}".`);

  const { limit, offset } = parsePaging(url, { defaultLimit: 50, maxLimit: 5000 });

  // Reads the precomputed plant_endemic_state (migration 006), which already
  // holds accepted-only endemics — no scan of plant_county_distribution.
  const totalRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM plant_endemic_state WHERE state_code = ?`
  ).bind(sc).first<{ n: number }>();
  const total = totalRow?.n ?? 0;

  const rows = await env.DB.prepare(
    `SELECT p.usda_symbol, p.scientific_name, p.common_name, p.family,
            p.photo_thumb_url
       FROM plant_endemic_state e
       JOIN plants p ON p.id = e.plant_id
      WHERE e.state_code = ?
      ORDER BY p.scientific_name
      LIMIT ? OFFSET ?`
  ).bind(sc, limit, offset).all();
  const plants = rows.results ?? [];

  return json({
    state,
    total,
    paging: { limit, offset, count: plants.length, has_more: offset + plants.length < total },
    plants,
  }, 200, "long");
}

/** List every family with its plant + genus count. Used by /explore/families. */
async function listFamilies(env: Env): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT family,
            COUNT(DISTINCT id)    AS plant_count,
            COUNT(DISTINCT genus) AS genus_count
       FROM plants
      WHERE family IS NOT NULL
        AND family != ''
        AND is_synonym = 0
        AND is_excluded = 0
      GROUP BY family
      ORDER BY plant_count DESC, family`
  ).all();
  const families = rows.results ?? [];
  return json({ count: families.length, families }, 200, "long");
}

/** Bulk: every county with a mapped hardiness zone. Used by the national
 *  zone-map visualization on the website. Filter by `?state=XX` for the
 *  per-state subset. */
async function listHardinessCounties(env: Env, url: URL): Promise<Response> {
  const state = (url.searchParams.get("state") || "").trim().toUpperCase();
  if (state && !/^[A-Z]{2}$/.test(state)) {
    return badRequest(`Invalid state code "${state}". Use the two-letter USPS code.`);
  }
  const rows = await (state
    ? env.DB.prepare(
        `SELECT c.county_fips, c.county_name, c.state_code, hzc.zone_code
           FROM hardiness_zones_by_county hzc
           JOIN counties c ON c.county_fips = hzc.county_fips
          WHERE c.state_code = ?
          ORDER BY c.county_fips`
      ).bind(state).all()
    : env.DB.prepare(
        `SELECT c.county_fips, c.county_name, c.state_code, hzc.zone_code
           FROM hardiness_zones_by_county hzc
           JOIN counties c ON c.county_fips = hzc.county_fips
          ORDER BY c.county_fips`
      ).all());
  const counties = rows.results ?? [];
  return json({
    count: counties.length,
    counties,
  }, 200, "long");
}

/** Validate a lat/lon pair from query params. Returns numbers or an error. */
export function parseLatLon(url: URL): { lat: number; lon: number } | { error: string } {
  const lat = Number.parseFloat(url.searchParams.get("lat") ?? "");
  const lon = Number.parseFloat(url.searchParams.get("lon") ?? "");
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    return { error: 'Provide a numeric "lat" between -90 and 90.' };
  }
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    return { error: 'Provide a numeric "lon" between -180 and 180.' };
  }
  return { lat, lon };
}

/** Latitude scale factor for an equirectangular distance approximation:
 *  a degree of longitude shrinks by cos(latitude). Good enough for
 *  nearest-neighbour ranking over the continental US. */
export function lonScale(lat: number): number {
  return Math.cos((lat * Math.PI) / 180);
}

/**
 * GET /v1/hardiness/point?lat=&lon=
 *
 * Nearest-neighbour hardiness lookup for an arbitrary coordinate. Ranks county
 * centroids by an equirectangular (cos-scaled) squared distance computed in
 * SQL — no trig functions needed on the D1 side — and returns the closest
 * county that has a mapped zone.
 *
 * This is county-centroid resolution today; the response `resolution` field
 * documents that, and the contract is forward-compatible with the planned
 * PRISM point resolution (see docs/HARDINESS_POINT.md).
 */
async function hardinessByPoint(env: Env, url: URL): Promise<Response> {
  const parsed = parseLatLon(url);
  if ("error" in parsed) return badRequest(parsed.error);
  const { lat, lon } = parsed;
  const scale = lonScale(lat);

  const row = await env.DB.prepare(
    `SELECT c.county_fips, c.county_name, c.state_code, c.centroid_lat, c.centroid_lon,
            hz.zone_code, hz.zone_class_code, hz.temp_min_f, hz.temp_max_f, hz.description,
            ( (c.centroid_lat - ?1) * (c.centroid_lat - ?1)
            + ((c.centroid_lon - ?2) * ?3) * ((c.centroid_lon - ?2) * ?3) ) AS dist_sq
       FROM counties c
       JOIN hardiness_zones_by_county hzc ON hzc.county_fips = c.county_fips
       JOIN hardiness_zones           hz  ON hz.zone_code    = hzc.zone_code
      WHERE c.centroid_lat IS NOT NULL AND c.centroid_lon IS NOT NULL
      ORDER BY dist_sq ASC
      LIMIT 1`
  ).bind(lat, lon, scale).first<{
    county_fips: string; county_name: string; state_code: string;
    centroid_lat: number; centroid_lon: number;
    zone_code: string; zone_class_code: number;
    temp_min_f: number; temp_max_f: number; description: string;
    dist_sq: number;
  }>();

  if (!row) return notFound("No county hardiness data available to resolve the point.");

  // ~69 statute miles per degree of latitude; adequate for a rough distance.
  const approxMi = Math.round(Math.sqrt(Number(row.dist_sq)) * 69 * 10) / 10;

  return json({
    query: { lat, lon },
    resolution: "county-centroid",
    note: "Resolved to the nearest county-centroid hardiness sample. PRISM point-level resolution is planned — see docs/HARDINESS_POINT.md.",
    nearest_county: {
      county_fips:  row.county_fips,
      county_name:  row.county_name,
      state_code:   row.state_code,
      centroid_lat: row.centroid_lat,
      centroid_lon: row.centroid_lon,
      approx_distance_mi: approxMi,
    },
    zone: {
      zone_code:       row.zone_code,
      zone_class_code: row.zone_class_code,
      temp_min_f:      row.temp_min_f,
      temp_max_f:      row.temp_max_f,
      description:     row.description,
    },
  }, 200, "long");
}

/** County FIPS → predominant hardiness zone (centroid-sampled). */
async function hardinessByCounty(env: Env, raw: string): Promise<Response> {
  const fips = raw.trim();
  if (!/^[0-9]{4,5}$/.test(fips)) {
    return badRequest(`Invalid county FIPS "${raw}". Expected 4–5 digits.`);
  }
  const padded = fips.padStart(5, "0");
  const row = await env.DB.prepare(
    `SELECT c.county_fips, c.county_name, c.state_code,
            hz.zone_code, hz.zone_class_code, hz.temp_min_f, hz.temp_max_f, hz.description
       FROM counties               c
       JOIN hardiness_zones_by_county hzc ON hzc.county_fips = c.county_fips
       JOIN hardiness_zones        hz  ON hz.zone_code      = hzc.zone_code
      WHERE c.county_fips = ?1`
  ).bind(padded).first<{
    county_fips: string;
    county_name: string;
    state_code: string;
    zone_code: string;
    zone_class_code: number;
    temp_min_f: number;
    temp_max_f: number;
    description: string;
  }>();
  if (!row) {
    // Distinguish "county exists but no zone" from "no such county".
    const c = await env.DB.prepare(
      "SELECT county_fips, county_name, state_code FROM counties WHERE county_fips = ?1"
    ).bind(padded).first();
    if (c) {
      return json({
        county: c,
        zone: null,
        note: "County is in the catalogue but has no hardiness-zone mapping (territory or centroid outside polygon coverage).",
      }, 200, "long");
    }
    return notFound(`No county with FIPS "${padded}".`);
  }
  return json({
    county: {
      county_fips: row.county_fips,
      county_name: row.county_name,
      state_code:  row.state_code,
    },
    zone: {
      zone_code:        row.zone_code,
      zone_class_code:  row.zone_class_code,
      temp_min_f:       row.temp_min_f,
      temp_max_f:       row.temp_max_f,
      description:      row.description,
    },
  }, 200, "long");
}
