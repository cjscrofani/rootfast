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
 */

import { OPENAPI_SPEC } from "./openapi";

/** Cloudflare Workers ratelimit binding. Minimal local shape — keeps us
 *  off the experimental @cloudflare/workers-types `RateLimit` import. */
interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  DB: D1Database;
  DATASET_VERSION: string;
  RATELIMIT_DEFAULT: RateLimitBinding;
  RATELIMIT_BULK:    RateLimitBinding;
  RATELIMIT_SEARCH:  RateLimitBinding;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "POST") {
      return errorResponse("method_not_allowed", "Only GET/HEAD/POST supported.", 405);
    }

    const res = await routeRequest(req, env);
    return await applyEtag(req, res);
  },
};

async function routeRequest(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean);

  try {
    if (parts[0] === "healthz") return await healthz(env);
    if (parts[0] !== "v1") return notFound();

    // Rate limiting (no-op for /v1/openapi.json and /v1/docs — those are
    // cheap and frequently polled). The limiter to use is picked by route
    // shape: bulk exports are tightly capped; search is moderately capped;
    // everything else uses the generous default.
    if (parts[1] !== "openapi.json" && parts[1] !== "docs") {
      const denial = await enforceRateLimit(req, env, url, parts);
      if (denial) return denial;
    }

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

      // /v1/hardiness/...
      if (parts[1] === "hardiness") {
        if (parts[2] === "zones"    && !parts[3])           return await listHardinessZones(env);
        if (parts[2] === "zones"    && parts[3] && !parts[4]) return await hardinessZone(env, parts[3]);
        if (parts[2] === "counties" && !parts[3])           return await listHardinessCounties(env, url);
        if (parts[2] === "zip"      && parts[3] && !parts[4]) return await hardinessByZip(env, parts[3]);
        if (parts[2] === "county"   && parts[3] && !parts[4]) return await hardinessByCounty(env, parts[3]);
      }

      // /v1/soil/...
      if (parts[1] === "soil") {
        if (parts[2] === "counties" && !parts[3])           return await listSoilByCounty(env, url);
        if (parts[2] === "county"   && parts[3] && !parts[4]) return await soilByCounty(env, parts[3]);
      }

      // OpenAPI spec + Scalar UI
      if (parts[1] === "openapi.json" && !parts[2]) return openapiJson();
      if (parts[1] === "docs"         && !parts[2]) return scalarHtml();
  } catch (err) {
    console.error("Unhandled error:", err);
    return errorResponse("internal_error", "Unexpected error processing the request.", 500);
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

/** Wrap an already-built Response with ETag handling. If the request's
 *  If-None-Match matches the computed tag, return 304 with no body. */
async function applyEtag(req: Request, res: Response): Promise<Response> {
  if (res.status !== 200) return res;                       // only successful, body-bearing responses
  const cc = res.headers.get("cache-control") || "";
  if (cc.includes("no-store") || cc === "")  return res;    // skip uncacheable
  if (res.headers.get("etag")) return res;                  // already set by handler
  // Skip bulk downloads (CSV/NDJSON/GeoJSON exports). They carry a
  // Content-Disposition attachment header and can be many MB; buffering the
  // whole body to SHA-1 it would defeat streaming and burn CPU per request.
  if (res.headers.get("content-disposition")?.includes("attachment")) return res;

  const text = await res.clone().text();
  if (!text) return res;
  const etag = await computeEtag(text);

  // Match → 304
  const ifNoneMatch = req.headers.get("if-none-match");
  if (ifNoneMatch && ifNoneMatch === etag) {
    const h = new Headers();
    h.set("etag",          etag);
    h.set("cache-control", cc);
    h.set("vary",          res.headers.get("vary") || "Origin");
    // Carry CORS so 304s aren't blocked.
    for (const [k, v] of Object.entries(corsHeaders())) h.set(k, v);
    return new Response(null, { status: 304, headers: h });
  }

  // Attach ETag to the 200 response.
  const h = new Headers(res.headers);
  h.set("etag", etag);
  return new Response(text, { status: res.status, headers: h });
}

/** Pick the right limiter based on the route, call it, and return a 429
 *  response on rejection. Null means "request may proceed". */
async function enforceRateLimit(
  req: Request,
  env: Env,
  url: URL,
  parts: string[],
): Promise<Response | null> {
  // Per-IP keying. CF sets `cf-connecting-ip` on every request; fall back
  // to a per-deployment static key so a missing header doesn't break the
  // limiter (would happen in local `wrangler dev` against a non-CF runner).
  const ip = req.headers.get("cf-connecting-ip") || "unknown";
  const format = url.searchParams.get("format")?.toLowerCase();
  const isBulkExport = format === "csv" || format === "ndjson";

  // Search routes (both GET /v1/search and POST /v1/plants/search) live in
  // the moderate bucket regardless of format.
  const isSearch =
    parts[1] === "search" ||
    (parts[1] === "plants" && parts[2] === "search");

  let limiter: RateLimitBinding;
  let tier: "default" | "bulk" | "search";
  if (isBulkExport)       { limiter = env.RATELIMIT_BULK;    tier = "bulk";   }
  else if (isSearch)      { limiter = env.RATELIMIT_SEARCH;  tier = "search"; }
  else                    { limiter = env.RATELIMIT_DEFAULT; tier = "default";}

  // The simple ratelimit binding only keys on the string we pass — combine
  // tier+ip so the three limiters don't share a single counter accidentally.
  const { success } = await limiter.limit({ key: `${tier}:${ip}` });
  if (success) return null;

  return new Response(
    JSON.stringify({
      error: {
        code: "rate_limited",
        message:
          tier === "bulk"
            ? "Bulk-export quota exceeded (5 req/min/IP). Slow down or filter the export."
            : tier === "search"
            ? "Search quota exceeded (60 req/min/IP)."
            : "Request quota exceeded (120 req/min/IP).",
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
};

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
export function buildFilters(searchParams: URLSearchParams): Ctx | { error: string } {
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
  if (v("nativity") && (err = eat("nativity", pushEnum(ctx, "pcd.nativity", v("nativity")!, NATIVITY_VALUES)))) return { error: err };

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
  // Implemented as a correlated subquery against plant_county_distribution.
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
    // Subquery returns plant_ids whose distinct county count satisfies the bounds.
    ctx.where.push(
      `p.id IN (
         SELECT plant_id
           FROM plant_county_distribution
          GROUP BY plant_id
         HAVING ${conds.map(c => `COUNT(DISTINCT county_fips) ${c}`).join(" AND ")}
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
    if (FILTER_PARAMS.has(k) && v) out[k] = v;
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
  },
): Response {
  const status = opts.status ?? 200;
  const cache  = opts.cache  ?? "medium";

  if (format === "json") return json(jsonBody, status, cache);

  const headers: Record<string, string> = {
    "cache-control":       cacheControl(cache),
    "content-disposition": `attachment; filename="${opts.filename}.${format}"`,
    ...corsHeaders(),
  };

  if (format === "csv") {
    headers["content-type"] = "text/csv; charset=utf-8";
    return new Response(toCsv(rows, opts.columns), { status, headers });
  }
  // ndjson
  headers["content-type"] = "application/x-ndjson; charset=utf-8";
  return new Response(toNdjson(rows), { status, headers });
}

/* --------------------------- Endpoints --------------------------- */

async function healthz(env: Env): Promise<Response> {
  const row = await env.DB.prepare(
    "SELECT value FROM schema_meta WHERE key = 'schema_version'"
  ).first<{ value: string }>();
  return json({
    ok: true,
    dataset_version: env.DATASET_VERSION,
    schema_version: row?.value ?? null,
  }, 200, "none");
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

  // For bulk downloads (CSV/NDJSON) default to no limit (cap at 50k);
  // JSON keeps the same 5000/10000 pagination as state plants.
  const isBulk = format !== "json";
  const { limit, offset } = parsePaging(url, {
    defaultLimit: isBulk ? 50000 : 5000,
    maxLimit:     isBulk ? 50000 : 10000,
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
  const sql =
    `SELECT p.usda_symbol, p.scientific_name, p.scientific_name_canonical,
            p.common_name, p.family, p.genus, p.rank,
            p.gbif_taxon_key, p.gbif_canonical_name,
            p.gbif_match_type, p.gbif_match_status,
            p.is_synonym, p.accepted_plant_id,
            p.photo_url, p.photo_thumb_url, p.photo_license, p.photo_attribution
       FROM plants p
       ${charJoin}
      WHERE p.is_synonym = 0
        AND p.is_excluded = 0
        ${extraWhere}
      ORDER BY p.scientific_name
      LIMIT ? OFFSET ?`;
  const rows = await env.DB.prepare(sql).bind(...f.binds, limit, offset).all();
  const plants = (rows.results ?? []) as Record<string, unknown>[];

  const totalSql =
    `SELECT COUNT(*) AS n
       FROM plants p
       ${charJoin}
      WHERE p.is_synonym = 0
        AND p.is_excluded = 0
        ${extraWhere}`;
  const totalRow = await env.DB.prepare(totalSql).bind(...f.binds).first<{ n: number }>();
  const total = totalRow?.n ?? 0;

  return formattedResponse(format, plants, {
    count: plants.length,
    total,
    paging: { limit, offset, has_more: offset + plants.length < total },
    filters: filtersEcho(url),
    plants,
  }, {
    cache:    isBulk ? "long" : "medium",
    filename: "rootfast-plants",
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
  // RANDOM() on D1 is OK for small tables; ours is ~5-25k plants.
  // Filter to actionable rank + accepted (non-synonym, non-excluded), prefer
  // ones with a photo so the random pick looks good.
  const row = await env.DB.prepare(
    `SELECT usda_symbol, scientific_name, common_name, family,
            photo_thumb_url, photo_url
       FROM plants
      WHERE is_synonym = 0
        AND is_excluded = 0
        AND photo_url IS NOT NULL
        AND rank IN ('Species','Subspecies','Variety','Form')
      ORDER BY RANDOM()
      LIMIT 1`
  ).first();
  if (!row) return notFound("No plants in catalogue.");
  return json({ plant: row }, 200, "rotating");
}

async function plantsByCounty(env: Env, fips: string, url: URL): Promise<Response> {
  const format = parseFormat(url);
  if (typeof format === "object") return badRequest(format.error);

  const county = await env.DB.prepare(
    "SELECT county_fips, county_name, state_code FROM counties WHERE county_fips = ?"
  ).bind(fips).first();
  if (!county) return notFound(`No county with FIPS "${fips}".`);

  const f = buildFilters(url.searchParams);
  if ("error" in f) return badRequest(f.error);

  const isBulk = format !== "json";
  const { limit, offset } = parsePaging(url, {
    defaultLimit: isBulk ? 50000 : 50,
    maxLimit:     isBulk ? 50000 : 1000,
  });
  const sortClause = parseSortCounty(url);
  if ("error" in sortClause) return badRequest(sortClause.error);

  const charJoin = f.needsChars
    ? "LEFT JOIN plant_characteristics pc ON pc.plant_id = p.id"
    : "";
  const extraWhere = f.where.length ? " AND " + f.where.join(" AND ") : "";

  // Total under the same filter scope.
  const totalSql =
    `SELECT COUNT(*) AS n
       FROM plant_county_distribution pcd
       JOIN plants p ON p.id = pcd.plant_id
       ${charJoin}
      WHERE pcd.county_fips = ?
        AND p.is_synonym = 0
        AND p.is_excluded = 0
        ${extraWhere}`;
  const totalRow = await env.DB.prepare(totalSql).bind(fips, ...f.binds).first<{ n: number }>();
  const total = totalRow?.n ?? 0;

  const sql =
    `SELECT p.usda_symbol, p.scientific_name, p.common_name, p.family,
            p.photo_thumb_url, p.photo_license,
            pcd.nativity
       FROM plant_county_distribution pcd
       JOIN plants p ON p.id = pcd.plant_id
       ${charJoin}
      WHERE pcd.county_fips = ?
        AND p.is_synonym = 0
        AND p.is_excluded = 0
        ${extraWhere}
      ORDER BY ${sortClause.value}
      LIMIT ? OFFSET ?`;
  const rows = await env.DB.prepare(sql).bind(fips, ...f.binds, limit, offset).all();
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
  });
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
  const states = await env.DB.prepare(
    `SELECT s.state_code, s.state_name, s.state_fips, s.country,
            (SELECT COUNT(*) FROM counties c WHERE c.state_code = s.state_code) AS county_count,
            (SELECT COUNT(DISTINCT pcd.plant_id)
               FROM plant_county_distribution pcd
               JOIN counties c ON c.county_fips = pcd.county_fips
              WHERE c.state_code = s.state_code) AS taxa_count
       FROM states s
      WHERE EXISTS (
        SELECT 1
          FROM plant_county_distribution pcd
          JOIN counties c2 ON c2.county_fips = pcd.county_fips
         WHERE c2.state_code = s.state_code
      )
      ORDER BY s.state_name`
  ).all();

  return json({
    count: states.results?.length ?? 0,
    states: states.results ?? [],
  }, 200, "medium");
}

async function stateHeader(env: Env, code: string): Promise<Response> {
  const sc = code.toUpperCase();
  const state = await env.DB.prepare(
    `SELECT s.state_code, s.state_name, s.state_fips, s.country,
            (SELECT COUNT(*) FROM counties c WHERE c.state_code = s.state_code) AS county_count,
            (SELECT COUNT(DISTINCT pcd.plant_id)
               FROM plant_county_distribution pcd
               JOIN counties c ON c.county_fips = pcd.county_fips
              WHERE c.state_code = s.state_code) AS taxa_count
       FROM states s
      WHERE s.state_code = ?1`
  ).bind(sc).first();
  if (!state) return notFound(`No state with code "${sc}".`);
  return json({ state }, 200, "medium");
}

async function plantsByState(env: Env, code: string, url: URL): Promise<Response> {
  const format = parseFormat(url);
  if (typeof format === "object") return badRequest(format.error);

  const sc = code.toUpperCase();
  const state = await env.DB.prepare(
    "SELECT state_code, state_name, state_fips, country FROM states WHERE state_code = ?"
  ).bind(sc).first();
  if (!state) return notFound(`No state with code "${sc}".`);

  const f = buildFilters(url.searchParams);
  if ("error" in f) return badRequest(f.error);

  const isBulk = format !== "json";
  const { limit, offset } = parsePaging(url, {
    defaultLimit: isBulk ? 50000 : 50,
    maxLimit:     isBulk ? 50000 : 10000,
  });
  const sortClause = parseSortState(url);
  if ("error" in sortClause) return badRequest(sortClause.error);

  const charJoin = f.needsChars
    ? "LEFT JOIN plant_characteristics pc ON pc.plant_id = p.id"
    : "";
  const extraWhere = f.where.length ? " AND " + f.where.join(" AND ") : "";

  // Total taxa under the same filters + county count for the state.
  const totalSql =
    `SELECT COUNT(*) AS n FROM (
       SELECT p.id
         FROM plants p
         JOIN plant_county_distribution pcd ON pcd.plant_id  = p.id
         JOIN counties                  c   ON c.county_fips = pcd.county_fips
         ${charJoin}
        WHERE c.state_code = ?
          AND p.is_synonym = 0
          AND p.is_excluded = 0
          ${extraWhere}
        GROUP BY p.id
     )`;
  const [totalRow, countyCountRow] = await Promise.all([
    env.DB.prepare(totalSql).bind(sc, ...f.binds).first<{ n: number }>(),
    env.DB.prepare(
      "SELECT COUNT(*) AS n FROM counties WHERE state_code = ?"
    ).bind(sc).first<{ n: number }>(),
  ]);
  const totalTaxa = totalRow?.n ?? 0;

  const pageSql =
    `SELECT p.usda_symbol, p.scientific_name, p.common_name, p.family,
            p.photo_thumb_url,
            COUNT(*)                                                        AS county_count,
            SUM(CASE WHEN pcd.nativity = 'Native'     THEN 1 ELSE 0 END)    AS native_counties,
            SUM(CASE WHEN pcd.nativity = 'Introduced' THEN 1 ELSE 0 END)    AS introduced_counties,
            SUM(CASE WHEN pcd.nativity = 'Both'       THEN 1 ELSE 0 END)    AS both_counties
       FROM plants p
       JOIN plant_county_distribution pcd ON pcd.plant_id  = p.id
       JOIN counties                  c   ON c.county_fips = pcd.county_fips
       ${charJoin}
      WHERE c.state_code = ?
        AND p.is_synonym = 0
        AND p.is_excluded = 0
        ${extraWhere}
      GROUP BY p.id
      ORDER BY ${sortClause.value}
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
      counties: countyCountRow?.n ?? 0,
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
  });
}

async function countiesByState(env: Env, code: string): Promise<Response> {
  const sc = code.toUpperCase();
  const state = await env.DB.prepare(
    "SELECT state_code, state_name, state_fips, country FROM states WHERE state_code = ?1"
  ).bind(sc).first();
  if (!state) return notFound(`No state with code "${sc}".`);

  const counties = await env.DB.prepare(
    `SELECT c.county_fips, c.county_name, c.state_code,
            c.centroid_lat, c.centroid_lon,
            (SELECT COUNT(*)
               FROM plant_county_distribution pcd
              WHERE pcd.county_fips = c.county_fips) AS taxa_count
       FROM counties c
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
async function hardinessByZip(env: Env, raw: string): Promise<Response> {
  const digits = raw.replace(/[^0-9]/g, "").slice(0, 5);
  if (digits.length !== 5) {
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

/** Bulk: every county with its taxa count. Used by the biodiversity-by-county
 *  map visualization. Returns all ~3,227 US counties in one response. */
async function listCountyTaxaCounts(env: Env, url: URL): Promise<Response> {
  const state = (url.searchParams.get("state") || "").trim().toUpperCase();
  if (state && !/^[A-Z]{2}$/.test(state)) {
    return badRequest(`Invalid state code "${state}". Use the two-letter USPS code.`);
  }
  const sql = state
    ? `SELECT c.county_fips, c.county_name, c.state_code,
              (SELECT COUNT(DISTINCT plant_id) FROM plant_county_distribution pcd
                WHERE pcd.county_fips = c.county_fips) AS taxa_count
         FROM counties c
        WHERE c.state_code = ?
        ORDER BY c.county_fips`
    : `SELECT c.county_fips, c.county_name, c.state_code,
              (SELECT COUNT(DISTINCT plant_id) FROM plant_county_distribution pcd
                WHERE pcd.county_fips = c.county_fips) AS taxa_count
         FROM counties c
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
  const sql = state
    ? `SELECT c.county_fips, c.county_name, c.state_code,
              COUNT(DISTINCT pcd.plant_id) AS taxa_count,
              COUNT(DISTINCT CASE WHEN p.photo_url IS NOT NULL THEN p.id END) AS photo_count
         FROM counties c
         LEFT JOIN plant_county_distribution pcd ON pcd.county_fips = c.county_fips
         LEFT JOIN plants p ON p.id = pcd.plant_id
        WHERE c.state_code = ?
        GROUP BY c.county_fips
        ORDER BY c.county_fips`
    : `SELECT c.county_fips, c.county_name, c.state_code,
              COUNT(DISTINCT pcd.plant_id) AS taxa_count,
              COUNT(DISTINCT CASE WHEN p.photo_url IS NOT NULL THEN p.id END) AS photo_count
         FROM counties c
         LEFT JOIN plant_county_distribution pcd ON pcd.county_fips = c.county_fips
         LEFT JOIN plants p ON p.id = pcd.plant_id
        GROUP BY c.county_fips
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
  const rows = await env.DB.prepare(
    `WITH plant_states AS (
       SELECT pcd.plant_id, c.state_code
         FROM plant_county_distribution pcd
         JOIN counties c ON c.county_fips = pcd.county_fips
        GROUP BY pcd.plant_id, c.state_code
     ),
     endemics AS (
       SELECT plant_id, MIN(state_code) AS only_state
         FROM plant_states
        GROUP BY plant_id
       HAVING COUNT(DISTINCT state_code) = 1
     )
     SELECT s.state_code, s.state_name, s.country,
            COUNT(e.plant_id) AS endemic_count
       FROM states s
       LEFT JOIN endemics e ON e.only_state = s.state_code
      GROUP BY s.state_code
     HAVING COUNT(e.plant_id) > 0
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

  // CTE: plants whose entire distribution lives inside one state.
  const totalRow = await env.DB.prepare(
    `WITH endemics AS (
       SELECT pcd.plant_id
         FROM plant_county_distribution pcd
         JOIN counties c ON c.county_fips = pcd.county_fips
        GROUP BY pcd.plant_id
       HAVING COUNT(DISTINCT c.state_code) = 1
          AND MIN(c.state_code) = ?
     )
     SELECT COUNT(*) AS n
       FROM plants p
       JOIN endemics e ON e.plant_id = p.id
      WHERE p.is_synonym = 0 AND p.is_excluded = 0`
  ).bind(sc).first<{ n: number }>();
  const total = totalRow?.n ?? 0;

  const rows = await env.DB.prepare(
    `WITH endemics AS (
       SELECT pcd.plant_id
         FROM plant_county_distribution pcd
         JOIN counties c ON c.county_fips = pcd.county_fips
        GROUP BY pcd.plant_id
       HAVING COUNT(DISTINCT c.state_code) = 1
          AND MIN(c.state_code) = ?
     )
     SELECT p.usda_symbol, p.scientific_name, p.common_name, p.family,
            p.photo_thumb_url
       FROM plants p
       JOIN endemics e ON e.plant_id = p.id
      WHERE p.is_synonym = 0 AND p.is_excluded = 0
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
