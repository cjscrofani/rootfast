import { describe, it, expect } from 'vitest';
import {
  parsePaging,
  buildFilters,
  parseFormat,
  csvCell,
  toCsv,
  toNdjson,
  aggregateNativity,
  clampInt,
  cacheControl,
  computeEtag,
  parseLatLon,
  lonScale,
} from '../src/index';

const params = (qs: string) => new URLSearchParams(qs);
const filters = (qs: string) => buildFilters(params(qs));

describe('buildFilters', () => {
  it('returns an empty context for no params', () => {
    const f = filters('');
    expect(f).toEqual({ where: [], binds: [], needsChars: false });
  });

  it('family uses a prefix LIKE with wildcards stripped from user input', () => {
    const f = filters('family=Rosaceae');
    if ('error' in f) throw new Error(f.error);
    expect(f.where).toContain('p.family LIKE ?');
    expect(f.binds).toEqual(['Rosaceae%']);
  });

  it('strips % and _ from the family value so users cannot inject LIKE wildcards', () => {
    // Build params directly so the literal % survives (a query string would
    // percent-decode it before buildFilters ever sees it).
    const sp = new URLSearchParams();
    sp.set('family', 'Ros%ac_eae');
    const f = buildFilters(sp);
    if ('error' in f) throw new Error(f.error);
    expect(f.binds).toEqual(['Rosaceae%']);
  });

  it('binds injection-looking values as parameters, never into the SQL text', () => {
    const f = filters("genus=Quercus'); DROP TABLE plants;--");
    if ('error' in f) throw new Error(f.error);
    expect(f.where).toEqual(['p.genus = ?']);
    // The dangerous string is a bound parameter, not concatenated into SQL.
    expect(f.binds).toEqual(["Quercus'); DROP TABLE plants;--"]);
    expect(f.where.join(' ')).not.toContain('DROP');
  });

  it('accepts a valid enum and rejects an invalid one', () => {
    const ok = filters('rank=Species');
    if ('error' in ok) throw new Error(ok.error);
    expect(ok.where).toContain('p.rank IN (?)');
    expect(ok.binds).toEqual(['Species']);

    const bad = filters('rank=Species,Wizard');
    expect('error' in bad && bad.error).toMatch(/rank/);
  });

  it('growth_habit becomes an EXISTS subquery and does not need the characteristics join', () => {
    const f = filters('growth_habit=Tree,Shrub');
    if ('error' in f) throw new Error(f.error);
    expect(f.where[0]).toContain('EXISTS');
    expect(f.where[0]).toContain('plant_growth_habits');
    expect(f.binds).toEqual(['Tree', 'Shrub']);
    expect(f.needsChars).toBe(false);
  });

  it('a characteristics enum flips needsChars and binds the value', () => {
    const f = filters('drought_tolerance=High');
    if ('error' in f) throw new Error(f.error);
    expect(f.needsChars).toBe(true);
    expect(f.where).toContain('pc.drought_tolerance IN (?)');
    expect(f.binds).toEqual(['High']);
  });

  it('parses numeric ranges and rejects non-numbers', () => {
    const ok = filters('min_height_ft=3.5');
    if ('error' in ok) throw new Error(ok.error);
    expect(ok.where).toContain('pc.height_mature_ft >= ?');
    expect(ok.binds).toEqual([3.5]);
    expect(ok.needsChars).toBe(true);

    const bad = filters('min_height_ft=tall');
    expect('error' in bad && bad.error).toMatch(/min_height_ft/);
  });

  it('boolean params accept truthy/falsy words and reject junk', () => {
    const t = filters('fire_resistant=yes');
    if ('error' in t) throw new Error(t.error);
    expect(t.where).toContain('pc.fire_resistant = 1');

    const bad = filters('fire_resistant=maybe');
    expect('error' in bad && bad.error).toMatch(/fire_resistant/);
  });

  it('min/max counties build a HAVING subquery and reject negatives', () => {
    const f = filters('min_counties=5&max_counties=50');
    if ('error' in f) throw new Error(f.error);
    expect(f.where[0]).toContain('COUNT(DISTINCT county_fips)');
    expect(f.binds).toEqual([5, 50]);

    const bad = filters('min_counties=-1');
    expect('error' in bad && bad.error).toMatch(/min_counties/);
  });

  it('nativity binds against the distribution column', () => {
    const f = filters('nativity=Native');
    if ('error' in f) throw new Error(f.error);
    expect(f.where).toContain('pcd.nativity IN (?)');
    expect(f.binds).toEqual(['Native']);
  });
});

describe('parsePaging', () => {
  const opts = { defaultLimit: 50, maxLimit: 1000 };
  const u = (qs: string) => new URL(`https://x/?${qs}`);

  it('applies defaults when absent', () => {
    expect(parsePaging(u(''), opts)).toEqual({ limit: 50, offset: 0 });
  });
  it('clamps limit to maxLimit', () => {
    expect(parsePaging(u('limit=99999'), opts).limit).toBe(1000);
  });
  it('falls back to default on non-positive or NaN limit', () => {
    expect(parsePaging(u('limit=0'), opts).limit).toBe(50);
    expect(parsePaging(u('limit=abc'), opts).limit).toBe(50);
  });
  it('floors negative offset to 0', () => {
    expect(parsePaging(u('offset=-5'), opts).offset).toBe(0);
  });
});

describe('parseFormat', () => {
  const u = (qs: string) => new URL(`https://x/?${qs}`);
  it('defaults to json', () => expect(parseFormat(u(''))).toBe('json'));
  it('accepts csv/ndjson', () => {
    expect(parseFormat(u('format=csv'))).toBe('csv');
    expect(parseFormat(u('format=NDJSON'))).toBe('ndjson');
  });
  it('rejects an unknown format', () => {
    const r = parseFormat(u('format=xml'));
    expect(typeof r === 'object' && 'error' in r).toBe(true);
  });
  it('rejects a valid format not allowed on the endpoint', () => {
    const r = parseFormat(u('format=geojson'), ['json', 'csv', 'ndjson']);
    expect(typeof r === 'object' && 'error' in r).toBe(true);
  });
});

describe('CSV / NDJSON formatting', () => {
  it('quotes cells containing comma, quote, or newline per RFC 4180', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
  });
  it('renders null/undefined as empty and booleans as 1/0', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(true)).toBe('1');
    expect(csvCell(false)).toBe('0');
  });
  it('toCsv emits a header row and honors a column order', () => {
    const rows = [{ a: 1, b: 2 }, { a: 3, b: 4 }];
    expect(toCsv(rows, ['b', 'a'])).toBe('b,a\n2,1\n4,3\n');
  });
  it('toCsv with no rows still emits the header when columns are given', () => {
    expect(toCsv([], ['a', 'b'])).toBe('a,b\n');
  });
  it('toNdjson emits one JSON object per line with a trailing newline', () => {
    expect(toNdjson([{ a: 1 }, { b: 2 }])).toBe('{"a":1}\n{"b":2}\n');
    expect(toNdjson([])).toBe('');
  });
});

describe('aggregateNativity', () => {
  it('is Both when any Both county exists', () => {
    expect(aggregateNativity(0, 0, 1)).toBe('Both');
  });
  it('is Both when both Native and Introduced counties exist', () => {
    expect(aggregateNativity(2, 3, 0)).toBe('Both');
  });
  it('is Introduced when only introduced counties exist', () => {
    expect(aggregateNativity(0, 4, 0)).toBe('Introduced');
  });
  it('defaults to Native otherwise', () => {
    expect(aggregateNativity(5, 0, 0)).toBe('Native');
    expect(aggregateNativity(0, 0, 0)).toBe('Native');
  });
});

describe('clampInt', () => {
  it('clamps within bounds and floors floats', () => {
    expect(clampInt(500, 200, 1, 1000)).toBe(500);
    expect(clampInt(5000, 200, 1, 1000)).toBe(1000);
    expect(clampInt(0, 200, 1, 1000)).toBe(1);
    expect(clampInt(3.9, 200, 1, 1000)).toBe(3);
  });
  it('falls back on non-numeric input', () => {
    expect(clampInt('nope', 200, 1, 1000)).toBe(200);
    expect(clampInt(undefined, 200, 1, 1000)).toBe(200);
  });
});

describe('cacheControl', () => {
  it('emits no-store for the none profile', () => {
    expect(cacheControl('none')).toBe('no-store');
  });
  it('emits max-age/s-maxage for a cached profile', () => {
    expect(cacheControl('long')).toBe('public, max-age=3600, s-maxage=86400');
  });
});

describe('parseLatLon', () => {
  const u = (qs: string) => new URL(`https://x/?${qs}`);
  it('accepts a valid pair', () => {
    expect(parseLatLon(u('lat=45.5&lon=-111.2'))).toEqual({ lat: 45.5, lon: -111.2 });
  });
  it('rejects out-of-range or missing values', () => {
    expect('error' in parseLatLon(u('lat=200&lon=0'))).toBe(true);
    expect('error' in parseLatLon(u('lat=45&lon=999'))).toBe(true);
    expect('error' in parseLatLon(u('lon=10'))).toBe(true);
    expect('error' in parseLatLon(u('lat=abc&lon=10'))).toBe(true);
  });
});

describe('lonScale', () => {
  it('is 1 at the equator and shrinks toward the poles', () => {
    expect(lonScale(0)).toBeCloseTo(1, 10);
    expect(lonScale(60)).toBeCloseTo(0.5, 6);
    expect(lonScale(90)).toBeCloseTo(0, 10);
  });
});

describe('computeEtag', () => {
  it('is a stable weak ETag for the same body', async () => {
    const a = await computeEtag('hello');
    const b = await computeEtag('hello');
    expect(a).toBe(b);
    expect(a).toMatch(/^W\/"[0-9a-f]{16}"$/);
  });
  it('differs for different bodies', async () => {
    expect(await computeEtag('a')).not.toBe(await computeEtag('b'));
  });
});
