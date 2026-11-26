/**
 * Shared sitemap rendering + URL helpers.
 *
 * /sitemap.xml is a sitemap INDEX pointing at child sitemaps:
 *   /sitemap-pages.xml         static + explore + state + family URLs
 *   /sitemap-counties.xml      every county's canonical /{state}/{county} URL
 *   /sitemap-plants-{n}.xml    all plant pages, paginated (PLANTS_PER_SITEMAP each)
 *
 * A single urlset is capped by the protocol at 50,000 URLs; the catalogue has
 * ~27.7k plants, so plants are paginated to stay well within that and keep each
 * child response a reasonable size.
 */

export const SITEMAP_ORIGIN = 'https://rootfast.org';
export const PLANTS_PER_SITEMAP = 10000;

export function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface UrlEntry {
  loc: string;
  priority?: number;
}

export function renderUrlset(entries: UrlEntry[]): string {
  const urls = entries
    .map(({ loc, priority }) => {
      const p = priority !== undefined ? `\n    <priority>${priority.toFixed(1)}</priority>` : '';
      return `  <url>\n    <loc>${xmlEscape(loc)}</loc>${p}\n  </url>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

export function renderSitemapIndex(locs: string[]): string {
  const body = locs
    .map((loc) => `  <sitemap>\n    <loc>${xmlEscape(loc)}</loc>\n  </sitemap>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</sitemapindex>\n`;
}

/** `complete: false` marks a sitemap that fell back to an empty or partial
 *  list because the API call failed. It is still served (a valid, smaller
 *  sitemap beats an error) but must not be cached: the rendered-page cache in
 *  src/middleware.ts would otherwise keep the empty one for a day. */
export function sitemapResponse(xml: string, complete: boolean = true): Response {
  return new Response(xml, {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      // Sitemap content only changes when the catalogue does (rare).
      'cache-control': complete ? 'public, max-age=300, s-maxage=86400' : 'no-store',
    },
  });
}

/**
 * Reproduce the per-state county slug + collision suffixing used by the
 * [county_slug].astro route so the sitemap emits the exact canonical
 * /{state_slug}/{county_slug} URLs (and never a redirecting form).
 *
 * `counties` is expected in the API's default order (state_code, county_name),
 * which matches the per-state county_name order the county page dedupes in.
 */
export function countyCanonicalPaths(
  counties: { county_fips: string; county_name: string; state_code: string }[],
  slugifyCounty: (name: string) => string,
  stateSlugOf: (code: string) => string,
): string[] {
  const perStateCounts = new Map<string, Map<string, number>>();
  const out: string[] = [];
  for (const c of counties) {
    let counts = perStateCounts.get(c.state_code);
    if (!counts) {
      counts = new Map();
      perStateCounts.set(c.state_code, counts);
    }
    let slug = slugifyCounty(c.county_name);
    const n = (counts.get(slug) ?? 0) + 1;
    counts.set(slug, n);
    if (n > 1) slug = `${slug}-${n}`;
    out.push(`${SITEMAP_ORIGIN}/${stateSlugOf(c.state_code)}/${slug}`);
  }
  return out;
}
