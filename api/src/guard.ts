/**
 * Cost guards for the Rootfast API.
 *
 * Cloudflare meters D1 by ROWS READ and caps the Workers Free plan at
 * 5,000,000 a day. This module keeps the API inside that allowance:
 *
 *   1. canonicalKey()      — one cache key per logical request, so equivalent
 *                            URLs share a cached answer.
 *   2. meteredDb()         — wraps the D1 binding and counts the rows every
 *                            query reads.
 *   3. usage ledger        — adds those counts to the `usage_daily` table in
 *                            small batches, so every isolate learns the
 *                            day's global total.
 *   4. budgetSpent()       — true once the day's total reaches the budget;
 *                            the Worker then stops querying D1 until 00:00 UTC.
 *   5. response store      — expensive answers are saved in the
 *                            `response_cache` table (global, unlike the
 *                            per-location edge cache) and served for one row.
 *
 * Everything here degrades to "no guard" rather than failing a request: if the
 * ledger tables are missing or a write fails, the API keeps serving.
 */

/** Default daily row budget: 80% of the Workers Free allowance (5M rows/day).
 *  The margin covers batches other isolates have not flushed yet and queries
 *  run outside the Worker (wrangler, the dashboard console). */
export const DEFAULT_DAILY_ROWS_BUDGET = 4_000_000;

/** An isolate reports its usage after reading this many rows ... */
export const FLUSH_ROWS = 50_000;
/** ... or after this long, whichever comes first. Each report that carries
 *  rows is one row WRITTEN (Workers Free allows 100,000 a day), so this is
 *  deliberately slow: one isolate can write at most 720 times a day. */
export const FLUSH_MS = 120_000;
/** Once the budget is spent there is little left to learn: check back rarely. */
export const FLUSH_MS_SPENT = 5 * 60_000;
/** After a ledger failure, wait this long before trying it again. */
const LEDGER_RETRY_MS = 5 * 60_000;

/** Rows set aside for a request before it runs, so that many requests
 *  arriving together cannot all pass the budget check and then each read
 *  tens of thousands of rows. Released (and replaced by the true count) when
 *  the request finishes. Sized to the costliest GET (a filtered scan of
 *  `plants` with its count: ~55,000 rows). */
export const RESERVE_ROWS = 60_000;
/** POST /v1/plants/search aggregates the distribution table for whole states
 *  and is never cached: reserve far more for it. */
export const RESERVE_ROWS_FINDER = 500_000;
/** A reservation older than this is ignored. Release normally happens in a
 *  `finally`, but if Cloudflare cancels an invocation mid-await that may
 *  never run; without an expiry a few lost reservations would make an
 *  isolate refuse work with the budget unspent. */
export const RESERVE_TTL_MS = 30_000;

/** Only answers that cost at least this many rows are worth storing. */
export const STORE_MIN_ROWS = 2_000;
/** Largest body kept in the response store. */
export const STORE_MAX_BYTES = 64 * 1024;
/** The store is trimmed back to about this many entries, oldest first (it can
 *  run a few dozen over between trims). 1,000 x 64 KB bounds it at ~64 MB. */
export const STORE_MAX_ENTRIES = 1_000;
/** Only answers meant to live at least this long at the edge are stored:
 *  the store has no expiry of its own, so a short-lived answer (the rotating
 *  /v1/plants/random, search results) must never enter it. */
export const STORE_MIN_SMAXAGE = 86_400;
/** Keys longer than this are not stored (junk or abusive URLs). */
export const STORE_MAX_KEY_CHARS = 512;
/** One insert in this many also trims the store. */
const STORE_TRIM_EVERY = 25;

/** Largest CSV / NDJSON export served by one request. Bigger pulls page with
 *  `offset`, or use the dataset release (one download, no API calls).
 *  (Lives here, not in index.ts: the Workers runtime rejects an entry module
 *  that exports a bare number.) */
export const BULK_MAX_ROWS = 10_000;

/* ----------------------------- time helpers ----------------------------- */

/** 'YYYY-MM-DD' for the UTC day containing `now` (ms since epoch). */
export function utcDay(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Whole seconds from `now` until the next 00:00 UTC (at least 1). */
export function secondsUntilUtcMidnight(now: number = Date.now()): number {
  const d = new Date(now);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now) / 1000));
}

/** Parse the DAILY_ROWS_BUDGET var. Unset or unparsable → the default.
 *  Zero or negative → no budget (Infinity). */
export function parseBudget(raw: string | undefined | null): number {
  if (raw === undefined || raw === null || String(raw).trim() === "") return DEFAULT_DAILY_ROWS_BUDGET;
  // Number(), not parseInt(): "4e6" must not be read as 4 (a permanent 503).
  const n = Number(String(raw).trim());
  if (!Number.isInteger(n)) return DEFAULT_DAILY_ROWS_BUDGET;
  return n <= 0 ? Number.POSITIVE_INFINITY : n;
}

/* ------------------------------ cache keys ------------------------------ */

/**
 * Canonical cache key for a GET request: fixed origin, the path with empty
 * segments removed (the router ignores them too), and — of the query — only
 * the parameters in `known`, sorted by name. Handlers read nothing else, so
 * `?utm_source=x` or `?zz=123` cannot mint a fresh cache entry and force a
 * recomputation. Only the first value of a repeated name is kept, because
 * that is the one handlers read. `version` changes whenever the dataset or
 * the response shapes do, which retires every older entry at once.
 */
export function canonicalKey(url: URL, version: string, known: ReadonlySet<string>): string {
  const path = "/" + url.pathname.split("/").filter(Boolean).join("/");
  const seen = new Set<string>();
  const params: [string, string][] = [];
  for (const [k, v] of url.searchParams) {
    if (!known.has(k) || seen.has(k)) continue;
    seen.add(k);
    params.push([k, v]);
  }
  params.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const qs = new URLSearchParams(params);
  qs.append("__v", version);
  return `https://api.rootfast.org${path}?${qs.toString()}`;
}

/** Rate-limit identity for a client address. An IPv6 customer usually holds
 *  a whole /64, so the last 64 bits are dropped; IPv4 is used as is. */
export function clientBucket(ip: string): string {
  if (!ip.includes(":")) return ip;
  const [head, tail] = ip.split("::");
  const left = head ? head.split(":") : [];
  const right = tail !== undefined ? (tail ? tail.split(":") : []) : null;
  const groups = right === null
    ? left
    : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  return groups.slice(0, 4).map(g => g.toLowerCase().replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

/* ------------------------------ row metering ------------------------------ */

/** Rows read while serving one request. */
export class Meter {
  rows = 0;
  add(n: unknown): void {
    const v = typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
    this.rows += v;
    usage.pendingRows += v;
  }
}

/** The slice of D1PreparedStatement the API uses, with row counting. */
class MeteredStatement {
  constructor(private readonly stmt: D1PreparedStatement, private readonly meter: Meter) {}

  bind(...values: unknown[]): MeteredStatement {
    return new MeteredStatement(this.stmt.bind(...values), this.meter);
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const res = await this.stmt.all<T>();
    this.meter.add(res.meta?.rows_read);
    return res;
  }

  /** D1's own first() hides the row count, so this goes through all(). */
  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const res = await this.all<Record<string, unknown>>();
    const row = res.results?.[0];
    if (!row) return null;
    if (column !== undefined) return (row[column] ?? null) as T | null;
    return row as T;
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const res = await this.stmt.run<T>();
    this.meter.add(res.meta?.rows_read);
    return res;
  }
}

/** Wrap a D1 binding so every query adds its rows_read to `meter`. Only
 *  prepare() is supported — the API uses nothing else. */
export function meteredDb(db: D1Database, meter: Meter): D1Database {
  return {
    prepare: (sql: string) => new MeteredStatement(db.prepare(sql), meter),
  } as unknown as D1Database;
}

/* ------------------------------ usage ledger ------------------------------ */

export interface UsageState {
  day: string;              // UTC day these numbers belong to
  rows: number;             // global rows read today, as of the last sync
  requests: number;         // global requests today, as of the last sync
  pendingRows: number;      // read by this isolate, not yet reported
  pendingRequests: number;  // served by this isolate, not yet reported
  overheadRows: number;     // read by ledger look-ups; reported with the next write
  reservations: Map<number, { rows: number; at: number }>;   // requests still running here
  lastSync: number;         // ms; 0 = never synced
  ledgerDownUntil: number;  // ms; ledger writes are skipped before this
  syncing: Promise<void> | null;   // the sync in flight, if any
}

function freshUsage(day: string): UsageState {
  return { day, rows: 0, requests: 0, pendingRows: 0, pendingRequests: 0, overheadRows: 0, reservations: new Map(), lastSync: 0, ledgerDownUntil: 0, syncing: null };
}

/** Per-isolate view of today's usage. */
let usage: UsageState = freshUsage(utcDay());

/** Test hook: reset the isolate's usage state. */
export function resetUsageForTests(day: string = utcDay()): UsageState {
  usage = freshUsage(day);
  return usage;
}

export function currentUsage(): Readonly<UsageState> {
  return usage;
}

type Counted = Pick<UsageState, "rows" | "pendingRows"> & Partial<Pick<UsageState, "overheadRows" | "reservations">>;

/** Rows this isolate believes have been read today, everywhere. */
export function rowsToday(u: Counted = usage): number {
  return u.rows + u.pendingRows + (u.overheadRows ?? 0);
}

/** Rows set aside for requests still running in this isolate (reservations
 *  older than RESERVE_TTL_MS are dropped). */
export function reservedRows(u: Counted = usage, now: number = Date.now()): number {
  if (!u.reservations) return 0;
  let total = 0;
  for (const [id, r] of u.reservations) {
    if (now - r.at > RESERVE_TTL_MS) u.reservations.delete(id);
    else total += r.rows;
  }
  return total;
}

/** True once the rows actually read today have reached the budget. */
export function budgetSpent(budget: number, u: Counted = usage): boolean {
  return rowsToday(u) >= budget;
}

/** True when the budget is not spent but the requests already running here
 *  have what is left of it set aside — a moment's contention, not the end
 *  of the day. */
export function budgetBusy(budget: number, u: Counted = usage, now: number = Date.now()): boolean {
  return !budgetSpent(budget, u) && rowsToday(u) + reservedRows(u, now) >= budget;
}

let reservationSeq = 0;

/** Set rows aside for a request about to run; returns the function that
 *  releases them (call it when the request finishes; extra calls are no-ops). */
export function reserveRows(n: number, now: number = Date.now()): () => void {
  const u = usage;
  const id = ++reservationSeq;
  u.reservations.set(id, { rows: n, at: now });
  return () => { u.reservations.delete(id); };
}

/** Start a fresh count if the UTC day has changed since this isolate last
 *  looked. Synchronous, so the request that crosses midnight is judged
 *  against the new day rather than yesterday's spent budget. */
export function rollDay(now: number = Date.now()): void {
  const today = utcDay(now);
  if (usage.day !== today) usage = freshUsage(today);
}

/** True when this isolate should report to (or re-read) the ledger.
 *  `budget` only slows the cadence once it is spent. */
export function syncDue(u: UsageState, now: number, budget: number = Number.POSITIVE_INFINITY): boolean {
  if (u.syncing || now < u.ledgerDownUntil) return false;
  if (u.lastSync === 0) return true;
  if (budgetSpent(budget, u)) return now - u.lastSync >= FLUSH_MS_SPENT;
  if (u.pendingRows >= FLUSH_ROWS) return true;
  return now - u.lastSync >= FLUSH_MS;
}

/** Count one served request. */
export function countRequest(): void {
  usage.pendingRequests += 1;
}

/**
 * Bring this isolate's view in line with the ledger: add what it has not yet
 * reported and read back the global totals. Call it (awaited) before serving
 * when the isolate has never synced today, and via waitUntil() after a
 * response when syncDue() says so. Concurrent callers share one sync — a
 * request must not run ahead with "0 rows used" while the first read of the
 * ledger is still in flight. `db` must be the RAW binding: the ledger's own
 * rows are added by hand so they are counted exactly once.
 *
 * A report only WRITES when there are rows to add; requests alone ride along
 * with the next one. That keeps ledger writes far below the plan's
 * rows-written allowance.
 */
export function syncUsage(db: D1Database, now: number = Date.now(), budget: number = Number.POSITIVE_INFINITY): Promise<void> {
  rollDay(now);
  const u = usage;
  if (u.syncing) return u.syncing;
  if (!syncDue(u, now, budget)) return Promise.resolve();
  u.syncing = doSync(db, u, now).finally(() => { u.syncing = null; });
  return u.syncing;
}

async function doSync(db: D1Database, u: UsageState, now: number): Promise<void> {
  // The ledger's own look-ups are tallied apart (overheadRows) so that they
  // alone never turn the next sync into a write.
  const rows = u.pendingRows === 0 ? 0 : u.pendingRows + u.overheadRows;
  const requests = u.pendingRequests;
  const dataRows = u.pendingRows;
  const overhead = u.overheadRows;
  try {
    let total: { rows_read: number; requests: number } | null;
    if (rows === 0) {
      total = await db.prepare(
        "SELECT rows_read, requests FROM usage_daily WHERE day = ?1"
      ).bind(u.day).first<{ rows_read: number; requests: number }>();
    } else {
      u.pendingRows -= dataRows;
      u.overheadRows -= overhead;
      u.pendingRequests -= requests;
      total = await db.prepare(
        `INSERT INTO usage_daily (day, rows_read, requests, updated_at)
         VALUES (?1, ?2, ?3, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
         ON CONFLICT(day) DO UPDATE SET
           rows_read  = rows_read + excluded.rows_read,
           requests   = requests  + excluded.requests,
           updated_at = excluded.updated_at
         RETURNING rows_read, requests`
      ).bind(u.day, rows, requests).first<{ rows_read: number; requests: number }>();
    }
    u.overheadRows += 1;                                  // the ledger query's own read
    u.rows = Number(total?.rows_read ?? 0);
    u.requests = Number(total?.requests ?? 0);
    u.lastSync = now;
  } catch (err) {
    // Ledger unavailable (table missing, D1 error): keep the counts locally
    // so this isolate still enforces the budget on what it has seen itself.
    if (rows !== 0) {
      u.pendingRows += dataRows;
      u.overheadRows += overhead;
      u.pendingRequests += requests;
    }
    u.ledgerDownUntil = now + LEDGER_RETRY_MS;
    console.warn("usage ledger unavailable:", err);
  }
}

/* ----------------------------- response store ----------------------------- */

export interface StoredResponse {
  content_type: string;
  cache_control: string;
  etag: string | null;
  content_disposition: string | null;
  body: string;
}

/** Look a key up in the global response store. Pass the METERED db. */
export async function readStored(db: D1Database, key: string): Promise<StoredResponse | null> {
  try {
    return await db.prepare(
      `SELECT content_type, cache_control, etag, content_disposition, body
         FROM response_cache WHERE key = ?1`
    ).bind(key).first<StoredResponse>();
  } catch {
    return null;                                          // table missing → no store
  }
}

/** True when a finished response is worth keeping in the store. */
export function worthStoring(rowsCost: number, bodyBytes: number): boolean {
  return rowsCost >= STORE_MIN_ROWS && bodyBytes > 0 && bodyBytes <= STORE_MAX_BYTES;
}

/** True when a response MAY enter the store, judged before its body is read:
 *  expensive enough, long-lived (`s-maxage` of a day or more — the store never
 *  expires entries itself), not a file download, and a sane key. */
export function storeCandidate(
  rowsCost: number, cacheControl: string, contentDisposition: string | null, key: string,
): boolean {
  if (rowsCost < STORE_MIN_ROWS) return false;
  if (contentDisposition) return false;
  if (key.length > STORE_MAX_KEY_CHARS) return false;
  const m = /s-maxage=(\d+)/.exec(cacheControl);
  return !!m && Number(m[1]) >= STORE_MIN_SMAXAGE && !cacheControl.includes("no-store");
}

/** Save a response in the global store and occasionally trim it. Pass the
 *  METERED db so the trim's reads are counted. Never throws. */
export async function writeStored(
  db: D1Database,
  key: string,
  entry: StoredResponse,
  rowsCost: number,
  rand: number = Math.random(),
): Promise<void> {
  try {
    await db.prepare(
      `INSERT INTO response_cache (key, content_type, cache_control, etag, content_disposition, body, rows_cost, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT(key) DO UPDATE SET
         content_type = excluded.content_type, cache_control = excluded.cache_control,
         etag = excluded.etag, content_disposition = excluded.content_disposition,
         body = excluded.body, rows_cost = excluded.rows_cost, created_at = excluded.created_at`
    ).bind(key, entry.content_type, entry.cache_control, entry.etag, entry.content_disposition, entry.body, rowsCost).run();

    if (rand < 1 / STORE_TRIM_EVERY) {
      await db.prepare(
        `DELETE FROM response_cache
          WHERE created_at < (SELECT created_at FROM response_cache
                               ORDER BY created_at DESC LIMIT 1 OFFSET ?1)`
      ).bind(STORE_MAX_ENTRIES).run();
    }
  } catch (err) {
    console.warn("response store write failed:", err);
  }
}
