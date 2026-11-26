import { describe, it, expect, beforeEach } from 'vitest';
import worker, {
  buildFilters, countyTotalFromSummary, stateRollupSql, parseNativity, bulkPagingHeaders,
} from '../src/index';
import {
  canonicalKey, clientBucket, parseBudget, utcDay, secondsUntilUtcMidnight, budgetSpent, syncDue,
  worthStoring, storeCandidate, resetUsageForTests, currentUsage, Meter, meteredDb, syncUsage,
  rollDay, reserveRows, reservedRows, budgetBusy, RESERVE_TTL_MS,
  DEFAULT_DAILY_ROWS_BUDGET, FLUSH_ROWS, FLUSH_MS, FLUSH_MS_SPENT, STORE_MIN_ROWS, STORE_MAX_BYTES,
  STORE_MAX_KEY_CHARS, RESERVE_ROWS,
} from '../src/guard';

/* ------------------------------ fakes ------------------------------ */

type Handler = (sql: string, binds: unknown[]) => { results?: unknown[]; rows_read?: number };

/** Minimal D1 stand-in: every statement is answered by `handler`. */
function fakeDb(handler: Handler) {
  const calls: { sql: string; binds: unknown[] }[] = [];
  const mk = (sql: string, binds: unknown[] = []): any => {
    const exec = async () => {
      calls.push({ sql, binds });
      const out = handler(sql, binds);
      return { results: out.results ?? [], meta: { rows_read: out.rows_read ?? 0 } };
    };
    return {
      bind: (...v: unknown[]) => mk(sql, v),
      all: exec,
      run: exec,
      first: async (col?: string) => {
        const row: any = (await exec()).results[0];
        return row ? (col ? row[col] : row) : null;
      },
    };
  };
  return { db: { prepare: (sql: string) => mk(sql) } as any, calls };
}

const allow = { limit: async () => ({ success: true }) };
const deny  = { limit: async () => ({ success: false }) };

function env(db: any, extra: Record<string, unknown> = {}): any {
  return {
    DB: db, DATASET_VERSION: '2026.05',
    RATELIMIT_DEFAULT: allow, RATELIMIT_BULK: allow, RATELIMIT_SEARCH: allow,
    ...extra,
  };
}

const get = (path: string, headers: Record<string, string> = {}) =>
  new Request('https://api.rootfast.org' + path, { headers });

/* ------------------------------ pure helpers ------------------------------ */

describe('canonicalKey', () => {
  const known = new Set(['limit', 'offset', 'family', 'sort', 'nativity']);
  const key = (u: string) => canonicalKey(new URL(u), 'v1', known);

  it('ignores parameter order, host, trailing and doubled slashes', () => {
    const a = key('https://api.rootfast.org/v1/plants?limit=5&family=Rosaceae');
    expect(key('https://x.workers.dev/v1/plants/?family=Rosaceae&limit=5')).toBe(a);
    expect(key('https://api.rootfast.org/v1//plants?limit=5&family=Rosaceae')).toBe(a);
  });

  it('drops parameters no handler reads, so junk cannot mint a new entry', () => {
    const a = key('https://a/v1/plants?limit=5');
    expect(key('https://a/v1/plants?limit=5&zz=123')).toBe(a);
    expect(key('https://a/v1/plants?utm_source=x&limit=5&fbclid=y')).toBe(a);
    expect(key('https://a/v1/plants?limit=5&__v=evil')).toBe(a);
  });

  it('keeps only the first value of a repeated parameter (the one handlers read)', () => {
    expect(key('https://a/v1/plants?sort=sci&sort=common')).toBe(key('https://a/v1/plants?sort=sci'));
    expect(key('https://a/v1/plants?sort=sci&sort=common')).not.toBe(key('https://a/v1/plants?sort=common&sort=sci'));
  });

  it('changes with the version', () => {
    const u = new URL('https://a/v1/states');
    expect(canonicalKey(u, 'a', known)).not.toBe(canonicalKey(u, 'b', known));
  });

  it('separates different paths and values', () => {
    expect(key('https://a/v1/states/MT')).not.toBe(key('https://a/v1/states/TX'));
    expect(key('https://a/v1/plants?limit=5')).not.toBe(key('https://a/v1/plants?limit=50'));
    expect(key('https://a/v1/plants?limit=')).not.toBe(key('https://a/v1/plants'));
  });
});

describe('clientBucket', () => {
  it('uses IPv4 addresses as they are', () => {
    expect(clientBucket('203.0.113.9')).toBe('203.0.113.9');
  });
  it('groups an IPv6 /64 into one bucket', () => {
    const a = clientBucket('2001:db8:aa:bb:1:2:3:4');
    expect(clientBucket('2001:db8:aa:bb:ffff:ffff:ffff:ffff')).toBe(a);
    expect(clientBucket('2001:0DB8:00aa:00bb::1')).toBe(a);
    expect(clientBucket('2001:db8:aa:bc::1')).not.toBe(a);
    expect(clientBucket('2a06:98c0:3600::103')).toBe('2a06:98c0:3600:0::/64');
  });
});

describe('parseBudget', () => {
  it('falls back to the default (80% of the free 5M rows/day)', () => {
    expect(DEFAULT_DAILY_ROWS_BUDGET).toBe(4_000_000);
    expect(parseBudget(undefined)).toBe(DEFAULT_DAILY_ROWS_BUDGET);
    expect(parseBudget('')).toBe(DEFAULT_DAILY_ROWS_BUDGET);
    expect(parseBudget('lots')).toBe(DEFAULT_DAILY_ROWS_BUDGET);
    expect(parseBudget('4_000_000')).toBe(DEFAULT_DAILY_ROWS_BUDGET);
    expect(parseBudget('1.5')).toBe(DEFAULT_DAILY_ROWS_BUDGET);
  });
  it('does not misread scientific notation as a tiny budget', () => {
    expect(parseBudget('4e6')).toBe(4_000_000);
  });
  it('reads a number and treats zero or less as unlimited', () => {
    expect(parseBudget('250000')).toBe(250000);
    expect(parseBudget('0')).toBe(Number.POSITIVE_INFINITY);
    expect(parseBudget('-1')).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('time helpers', () => {
  it('utcDay is the UTC calendar day', () => {
    expect(utcDay(Date.UTC(2026, 10, 25, 23, 59, 59))).toBe('2026-11-25');
    expect(utcDay(Date.UTC(2026, 10, 26, 0, 0, 0))).toBe('2026-11-26');
  });
  it('secondsUntilUtcMidnight counts down to 00:00 UTC', () => {
    expect(secondsUntilUtcMidnight(Date.UTC(2026, 10, 25, 23, 0, 0))).toBe(3600);
    expect(secondsUntilUtcMidnight(Date.UTC(2026, 10, 25, 0, 0, 0))).toBe(86400);
    expect(secondsUntilUtcMidnight(Date.UTC(2026, 10, 25, 23, 59, 59, 900))).toBe(1);
  });
});

describe('budgetSpent / syncDue / worthStoring', () => {
  it('counts reported and unreported rows against the budget', () => {
    expect(budgetSpent(100, { rows: 60, pendingRows: 39 })).toBe(false);
    expect(budgetSpent(100, { rows: 60, pendingRows: 40 })).toBe(true);
    expect(budgetSpent(Number.POSITIVE_INFINITY, { rows: 1e12, pendingRows: 0 })).toBe(false);
  });

  it('reserveRows sets rows aside and releases them exactly once', () => {
    resetUsageForTests();
    const release = reserveRows(500);
    const other = reserveRows(200);
    expect(reservedRows()).toBe(700);
    release(); release();
    expect(reservedRows()).toBe(200);
    other();
    expect(reservedRows()).toBe(0);
  });

  it('reservations make the budget busy, not spent', () => {
    const u = resetUsageForTests();
    u.rows = 50;
    expect(budgetBusy(100)).toBe(false);
    const release = reserveRows(60);
    expect(budgetSpent(100)).toBe(false);
    expect(budgetBusy(100)).toBe(true);
    release();
    expect(budgetBusy(100)).toBe(false);
    u.rows = 100;
    expect(budgetSpent(100)).toBe(true);
    expect(budgetBusy(100)).toBe(false);               // spent is reported as spent
  });

  it('a reservation that was never released expires', () => {
    resetUsageForTests();
    reserveRows(500, 1_000);                           // its request was cancelled; no release
    expect(reservedRows(undefined, 1_000 + RESERVE_TTL_MS)).toBe(500);
    expect(reservedRows(undefined, 1_001 + RESERVE_TTL_MS)).toBe(0);
  });

  it('syncs on a cold isolate, on a full batch, and on the interval', () => {
    const base = { day: 'd', rows: 0, requests: 0, pendingRows: 0, pendingRequests: 0, overheadRows: 0, reservations: new Map(), ledgerDownUntil: 0, syncing: null };
    expect(syncDue({ ...base, lastSync: 0 }, 1000)).toBe(true);
    expect(syncDue({ ...base, lastSync: 1000 }, 2000)).toBe(false);
    expect(syncDue({ ...base, lastSync: 1000, pendingRows: FLUSH_ROWS }, 2000)).toBe(true);
    expect(syncDue({ ...base, lastSync: 1000 }, 1000 + FLUSH_MS - 1)).toBe(false);
    expect(syncDue({ ...base, lastSync: 1000 }, 1000 + FLUSH_MS)).toBe(true);
    expect(syncDue({ ...base, lastSync: 0, syncing: Promise.resolve() }, 1000)).toBe(false);
    expect(syncDue({ ...base, lastSync: 0, ledgerDownUntil: 5000 }, 1000)).toBe(false);
  });

  it('checks back rarely once the budget is spent', () => {
    const spent = { day: 'd', rows: 100, requests: 0, pendingRows: FLUSH_ROWS, pendingRequests: 0, overheadRows: 0, reservations: new Map(), ledgerDownUntil: 0, syncing: null, lastSync: 1000 };
    expect(syncDue(spent, 1000 + FLUSH_MS, 100)).toBe(false);
    expect(syncDue(spent, 1000 + FLUSH_MS_SPENT, 100)).toBe(true);
  });

  it('only long-lived, expensive, non-download answers with sane keys may be stored', () => {
    const day = 'public, max-age=600, s-maxage=86400';
    expect(storeCandidate(STORE_MIN_ROWS, day, null, 'k')).toBe(true);
    expect(storeCandidate(STORE_MIN_ROWS - 1, day, null, 'k')).toBe(false);
    // the rotating /v1/plants/random and search results must never be frozen
    expect(storeCandidate(30_000, 'public, max-age=0, s-maxage=60', null, 'k')).toBe(false);
    expect(storeCandidate(30_000, 'public, max-age=60, s-maxage=300', null, 'k')).toBe(false);
    expect(storeCandidate(30_000, 'no-store', null, 'k')).toBe(false);
    expect(storeCandidate(30_000, day, 'attachment; filename="x.csv"', 'k')).toBe(false);
    expect(storeCandidate(30_000, day, null, 'k'.repeat(STORE_MAX_KEY_CHARS + 1))).toBe(false);
  });

  it('stores only expensive answers of a bounded size', () => {
    expect(worthStoring(STORE_MIN_ROWS - 1, 100)).toBe(false);
    expect(worthStoring(STORE_MIN_ROWS, 100)).toBe(true);
    expect(worthStoring(STORE_MIN_ROWS, STORE_MAX_BYTES + 1)).toBe(false);
    expect(worthStoring(STORE_MIN_ROWS, 0)).toBe(false);
  });
});

describe('meteredDb + syncUsage', () => {
  beforeEach(() => { resetUsageForTests(); });

  it('adds rows_read from all() and first() to the request and the day', async () => {
    const { db } = fakeDb(() => ({ results: [{ n: 7 }], rows_read: 120 }));
    const meter = new Meter();
    const m = meteredDb(db, meter);
    await m.prepare('SELECT 1').bind(1).all();
    expect(await m.prepare('SELECT 1').first<number>('n')).toBe(7);
    expect(meter.rows).toBe(240);
    expect(currentUsage().pendingRows).toBe(240);
  });

  it('reports pending usage and adopts the ledger total', async () => {
    const u = resetUsageForTests(utcDay(1_000_000));
    u.pendingRows = 500; u.pendingRequests = 3;
    const { db, calls } = fakeDb((sql, binds) => {
      expect(sql).toContain('INSERT INTO usage_daily');
      expect(binds).toEqual([utcDay(1_000_000), 500, 3]);
      return { results: [{ rows_read: 90_500, requests: 40 }] };
    });
    await syncUsage(db, 1_000_000);
    expect(calls).toHaveLength(1);
    expect(currentUsage().rows).toBe(90_500);
    expect(currentUsage().requests).toBe(40);
    expect(currentUsage().pendingRows).toBe(0);
    expect(currentUsage().overheadRows).toBe(1);       // the upsert's own read
    expect(currentUsage().lastSync).toBe(1_000_000);
  });

  it('keeps counting locally when the ledger is unavailable', async () => {
    const u = resetUsageForTests(utcDay(1_000_000));
    u.pendingRows = 500;
    const { db } = fakeDb(() => { throw new Error('no such table: usage_daily'); });
    await syncUsage(db, 1_000_000);
    expect(currentUsage().pendingRows).toBe(500);
    expect(syncDue(currentUsage() as any, 1_000_001)).toBe(false);   // backs off
  });

  it('does not write when there are no rows to report', async () => {
    const u = resetUsageForTests(utcDay(1_000_000));
    u.pendingRequests = 9;
    const { db, calls } = fakeDb((sql) => {
      expect(sql).not.toContain('INSERT');
      return { results: [{ rows_read: 777, requests: 5 }] };
    });
    await syncUsage(db, 1_000_000);
    expect(calls).toHaveLength(1);
    expect(currentUsage().rows).toBe(777);
    expect(currentUsage().pendingRequests).toBe(9);    // rides along with the next report
  });

  it('ledger look-ups alone never turn the next sync into a write', async () => {
    resetUsageForTests(utcDay(1_000_000));
    const sqls: string[] = [];
    const { db } = fakeDb((sql) => { sqls.push(sql); return { results: [{ rows_read: 10, requests: 1 }] }; });
    await syncUsage(db, 1_000_000);
    await syncUsage(db, 1_000_000 + FLUSH_MS);
    await syncUsage(db, 1_000_000 + 2 * FLUSH_MS);
    expect(sqls).toHaveLength(3);
    expect(sqls.every(q => q.startsWith('SELECT'))).toBe(true);
    expect(currentUsage().overheadRows).toBe(3);

    currentUsage().pendingRows; (currentUsage() as any).pendingRows = 40;      // real work arrives
    await syncUsage(db, 1_000_000 + 3 * FLUSH_MS);
    expect(sqls[3]).toContain('INSERT INTO usage_daily');
    expect(currentUsage().overheadRows).toBe(1);       // the three were reported with the write
  });

  it('concurrent callers share one sync instead of running ahead of it', async () => {
    resetUsageForTests(utcDay(1_000_000));
    let resolve!: () => void;
    const gate = new Promise<void>(r => { resolve = r; });
    let queries = 0;
    const slow: any = { prepare: () => ({ bind: () => ({ first: async () => { queries++; await gate; return { rows_read: 4_000_000, requests: 1 }; } }) }) };
    const a = syncUsage(slow, 1_000_000);
    const b = syncUsage(slow, 1_000_000);
    let bDone = false;
    void b.then(() => { bDone = true; });
    await Promise.resolve();
    expect(bDone).toBe(false);                         // b waits for the ledger too
    resolve();
    await Promise.all([a, b]);
    expect(queries).toBe(1);
    expect(currentUsage().rows).toBe(4_000_000);
  });

  it('rollDay resets a spent budget as soon as the UTC day changes', () => {
    const u = resetUsageForTests('2026-11-24');
    u.rows = 9_999_999; u.lastSync = 123;
    rollDay(Date.UTC(2026, 10, 24, 23, 59, 59));
    expect(currentUsage().rows).toBe(9_999_999);
    rollDay(Date.UTC(2026, 10, 25, 0, 0, 0));
    expect(currentUsage().day).toBe('2026-11-25');
    expect(budgetSpent(1000)).toBe(false);
    expect(currentUsage().lastSync).toBe(0);           // forces a fresh read of the ledger
  });

  it('starts a fresh count on a new UTC day', async () => {
    const u = resetUsageForTests('2026-11-24');
    u.rows = 3_999_999; u.lastSync = 1;
    const { db } = fakeDb(() => ({ results: [] }));
    await syncUsage(db, Date.UTC(2026, 10, 25, 0, 0, 5));
    expect(currentUsage().day).toBe('2026-11-25');
    expect(currentUsage().rows).toBe(0);
  });
});

/* ------------------------------ query helpers ------------------------------ */

describe('summary-backed query helpers', () => {
  const s = { accepted_count: 1362, native_count: 1086, introduced_count: 254, both_count: 22 };

  it('countyTotalFromSummary sums the requested nativity counts', () => {
    expect(countyTotalFromSummary(s, null)).toBe(1362);
    expect(countyTotalFromSummary(s, ['Native'])).toBe(1086);
    expect(countyTotalFromSummary(s, ['Introduced', 'Both'])).toBe(276);
    expect(countyTotalFromSummary(s, ['Native', 'Introduced', 'Both'])).toBe(1362);
  });

  it('stateRollupSql restricts the rollup to the requested nativity values', () => {
    expect(stateRollupSql(null)).toEqual({
      native: 'sp.native_counties', introduced: 'sp.introduced_counties', both: 'sp.both_counties',
      counties: 'sp.county_count', where: '',
    });
    const r = stateRollupSql(['Introduced']);
    expect(r.native).toBe('0');
    expect(r.both).toBe('0');
    expect(r.counties).toBe('(0 + sp.introduced_counties + 0)');
    expect(r.where).toBe(' AND (0 + sp.introduced_counties + 0) > 0');
  });

  it('parseNativity validates against the enum', () => {
    expect(parseNativity('Native, Both')).toEqual(['Native', 'Both']);
    expect(parseNativity('native')).toBeNull();
    expect(parseNativity(',')).toBeNull();
  });

  it('buildFilters can hand nativity back instead of emitting SQL', () => {
    const f = buildFilters(new URLSearchParams('nativity=Native,Both&family=Rosaceae'), { deferNativity: true });
    if ('error' in f) throw new Error(f.error);
    expect(f.nativity).toEqual(['Native', 'Both']);
    expect(f.where).toEqual(['p.family LIKE ?']);
    const bad = buildFilters(new URLSearchParams('nativity=Alien'), { deferNativity: true });
    expect('error' in bad && bad.error).toMatch(/nativity/);
  });

  it('range filters read plant_range_summary, not the distribution table', () => {
    const f = buildFilters(new URLSearchParams('min_counties=5&max_counties=50'));
    if ('error' in f) throw new Error(f.error);
    expect(f.where[0]).toContain('plant_range_summary');
    expect(f.where[0]).not.toContain('plant_county_distribution');
    expect(f.binds).toEqual([5, 50]);
  });

  it('bulk responses say how many rows exist and where the next page is', () => {
    const url = new URL('https://api.rootfast.org/v1/plants?format=csv&family=Poaceae');
    const h = bulkPagingHeaders({ url, total: 27678, limit: 10000, offset: 0 }, 10000);
    expect(h['x-total-count']).toBe('27678');
    expect(h['link']).toBe('<https://api.rootfast.org/v1/plants?format=csv&family=Poaceae&limit=10000&offset=10000>; rel="next"');
    const last = bulkPagingHeaders({ url, total: 27678, limit: 10000, offset: 20000 }, 7678);
    expect(last['x-total-count']).toBe('27678');
    expect(last['link']).toBeUndefined();
    expect(bulkPagingHeaders(undefined, 5)).toEqual({});
  });
});

/* ------------------------------ fetch flow ------------------------------ */

describe('fetch — budget, limiter and store', () => {
  beforeEach(() => { resetUsageForTests(); });

  const statesDb = (onSql?: (sql: string) => void) => fakeDb((sql) => {
    onSql?.(sql);
    if (sql.includes('FROM usage_daily') || sql.includes('INTO usage_daily')) return { results: [] };
    if (sql.includes('FROM response_cache')) return { results: [] };
    if (sql.includes('FROM states s')) {
      return { results: [{ state_code: 'MT', state_name: 'Montana', state_fips: '30', country: 'US', county_count: 56, taxa_count: 3215 }], rows_read: 110 };
    }
    return { results: [] };
  });

  it('serves a normal request and labels it a miss', async () => {
    const { db } = statesDb();
    const res = await worker.fetch(get('/v1/states', { 'cf-connecting-ip': '203.0.113.9' }), env(db));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-rootfast-cache')).toBe('miss');
    expect(res.headers.get('etag')).toBeTruthy();
    expect((await res.json() as any).states[0].state_code).toBe('MT');
  });

  it('answers 503 daily_budget_exhausted without touching the dataset once the budget is spent', async () => {
    const seen: string[] = [];
    const { db } = fakeDb((sql) => {
      seen.push(sql);
      if (sql.includes('FROM usage_daily')) return { results: [{ rows_read: 1000, requests: 10 }] };
      return { results: [] };
    });
    const res = await worker.fetch(get('/v1/states', { 'cf-connecting-ip': '203.0.113.9' }), env(db, { DAILY_ROWS_BUDGET: '1000' }));
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await res.json() as any).error.code).toBe('daily_budget_exhausted');
    expect(seen.some(s => s.includes('FROM states'))).toBe(false);
  });

  it('still serves a stored answer after the budget is spent', async () => {
    const { db } = fakeDb((sql) => {
      if (sql.includes('FROM usage_daily')) return { results: [{ rows_read: 9_000_000, requests: 10 }] };
      if (sql.includes('FROM response_cache')) {
        return { results: [{ content_type: 'application/json; charset=utf-8', cache_control: 'public, max-age=600, s-maxage=86400', etag: 'W/"abc"', content_disposition: null, body: '{"stored":true}' }], rows_read: 1 };
      }
      return { results: [] };
    });
    const res = await worker.fetch(get('/v1/families'), env(db, { DAILY_ROWS_BUDGET: '1000' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-rootfast-cache')).toBe('store');
  });

  it('serves again as soon as the UTC day changes, without waiting for a sync', async () => {
    const u = resetUsageForTests('2000-01-01');          // an isolate that spent yesterday's budget
    u.rows = 9_000_000; u.lastSync = Date.now();
    const { db } = statesDb();
    const res = await worker.fetch(get('/v1/states'), env(db, { DAILY_ROWS_BUDGET: '1000' }));
    expect(res.status).toBe(200);
  });

  it('a burst cannot pass the budget check together: later requests wait their turn as 503', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const { db } = fakeDb((sql) => {
      if (sql.includes('FROM states s')) return { results: [{ state_code: 'MT' }], rows_read: 10 };
      return { results: [] };
    });
    // Hold the first request inside its dataset query.
    const slowDb: any = { prepare: (sql: string) => {
      const st = db.prepare(sql);
      if (!sql.includes('FROM states s')) return st;
      return { ...st, all: async () => { await gate; return st.all(); }, bind: () => ({ all: async () => { await gate; return st.all(); } }) };
    } };
    // Budget = exactly one reservation: the first request holds all of it.
    const e = env(slowDb, { DAILY_ROWS_BUDGET: String(RESERVE_ROWS) });
    const first = worker.fetch(get('/v1/states'), e);
    await new Promise(r => setTimeout(r, 5));            // first is now holding its reservation
    const second = await worker.fetch(get('/v1/states/MT'), e);
    expect(second.status).toBe(503);
    expect((await second.json() as any).error.code).toBe('busy');
    expect(second.headers.get('retry-after')).toBe('5');     // not "come back at midnight"
    release();
    expect((await first).status).toBe(200);
    expect(reservedRows()).toBe(0);
    const third = await worker.fetch(get('/v1/states/MT'), e);   // the reservation was released
    expect(third.status).not.toBe(503);
  });

  it('never freezes a short-lived answer in the store, however expensive', async () => {
    const writes: string[] = [];
    const { db } = fakeDb((sql) => {
      if (sql.includes('INTO response_cache')) { writes.push(sql); return { results: [] }; }
      if (sql.includes('MAX(name_rank)')) return { results: [{ m: 27678 }], rows_read: 30_000 };
      if (sql.includes('FROM plant_name_rank r')) return { results: [{ usda_symbol: 'PIPO' }], rows_read: 5 };
      return { results: [] };
    });
    const waits: Promise<unknown>[] = [];
    const res = await worker.fetch(get('/v1/plants/random'), env(db), { waitUntil: (p: Promise<unknown>) => { waits.push(p); } });
    await Promise.all(waits);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('s-maxage=60');
    expect(writes).toHaveLength(0);
  });

  it('POST is only accepted on the plant finder', async () => {
    const { db, calls } = statesDb();
    const res = await worker.fetch(new Request('https://api.rootfast.org/v1/states', { method: 'POST', body: '{}' }), env(db));
    expect(res.status).toBe(405);
    expect(calls.some(c => c.sql.includes('FROM states'))).toBe(false);
  });

  it('the plant finder shares the tight bulk limiter', async () => {
    const { db } = statesDb();
    const res = await worker.fetch(
      new Request('https://api.rootfast.org/v1/plants/search', { method: 'POST', body: '{"states":["MT"]}', headers: { 'cf-connecting-ip': '203.0.113.9' } }),
      env(db, { RATELIMIT_BULK: deny }),
    );
    expect(res.status).toBe(429);
    expect((await res.json() as any).tier).toBe('finder');
  });

  it('/healthz reads schema_meta at most once a minute per isolate', async () => {
    const { db, calls } = fakeDb(() => ({ results: [] }));
    await worker.fetch(get('/healthz'), env(db));
    await worker.fetch(get('/healthz'), env(db));
    await worker.fetch(get('/healthz'), env(db));
    expect(calls.filter(c => c.sql.includes('schema_meta')).length).toBeLessThanOrEqual(1);
  });

  it('still answers /healthz and reports usage when the budget is spent', async () => {
    const { db } = fakeDb((sql) => {
      if (sql.includes('FROM usage_daily')) return { results: [{ rows_read: 5000, requests: 10 }] };
      return { results: [] };
    });
    const res = await worker.fetch(get('/healthz'), env(db, { DAILY_ROWS_BUDGET: '1000' }));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.usage.budget_exhausted).toBe(true);
    expect(body.usage.daily_rows_budget).toBe(1000);
    expect(body.usage.rows_read).toBeGreaterThanOrEqual(5000);
  });

  it('rate-limits internet clients but not the website’s service-binding calls', async () => {
    const { db } = statesDb();
    const limited = env(db, { RATELIMIT_DEFAULT: deny });
    const outside = await worker.fetch(get('/v1/states', { 'cf-connecting-ip': '203.0.113.9' }), limited);
    expect(outside.status).toBe(429);
    const internal = await worker.fetch(get('/v1/states'), limited);
    expect(internal.status).toBe(200);
  });

  it('serves a stored answer for one lookup and labels it', async () => {
    const seen: string[] = [];
    const { db } = fakeDb((sql) => {
      seen.push(sql);
      if (sql.includes('FROM response_cache')) {
        return { results: [{ content_type: 'application/json; charset=utf-8', cache_control: 'public, max-age=600, s-maxage=86400', etag: 'W/"abc"', content_disposition: null, body: '{"stored":true}' }], rows_read: 1 };
      }
      return { results: [] };
    });
    const res = await worker.fetch(get('/v1/states/MT/plants?sort=counties'), env(db));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-rootfast-cache')).toBe('store');
    expect(res.headers.get('etag')).toBe('W/"abc"');
    expect(await res.json()).toEqual({ stored: true });
    expect(seen.some(s => s.includes('state_plants'))).toBe(false);

    const notModified = await worker.fetch(get('/v1/states/MT/plants?sort=counties', { 'if-none-match': 'W/"abc"' }), env(db));
    expect(notModified.status).toBe(304);
  });

  it('stores an expensive answer and skips a cheap one', async () => {
    const writes: string[] = [];
    const mk = (rows: number) => fakeDb((sql) => {
      if (sql.includes('INTO response_cache')) { writes.push(sql); return { results: [] }; }
      if (sql.includes('FROM states s')) return { results: [{ state_code: 'MT' }], rows_read: rows };
      return { results: [] };
    }).db;
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => { waits.push(p); } };

    await worker.fetch(get('/v1/states'), env(mk(110)), ctx);
    await Promise.all(waits);
    expect(writes).toHaveLength(0);

    await worker.fetch(get('/v1/states'), env(mk(STORE_MIN_ROWS + 1)), ctx);
    await Promise.all(waits);
    expect(writes).toHaveLength(1);
  });

  it('does not rate-limit or meter the static spec', async () => {
    const { db, calls } = fakeDb((sql) => {
      if (sql.includes('usage_daily')) return { results: [{ rows_read: 9e9, requests: 1 }] };
      return { results: [] };
    });
    const res = await worker.fetch(get('/v1/openapi.json', { 'cf-connecting-ip': '203.0.113.9' }), env(db, { RATELIMIT_DEFAULT: deny, DAILY_ROWS_BUDGET: '1' }));
    expect(res.status).toBe(200);
    expect(calls.filter(c => !c.sql.includes('usage_daily'))).toHaveLength(0);
  });
});
