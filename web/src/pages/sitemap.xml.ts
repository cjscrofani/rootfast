import type { APIRoute } from 'astro';
import { api } from '@/lib/api';
import { STATE_NAMES, stateSlugOf } from '@/lib/states';
import { EXPLORE_CATEGORIES } from '@/lib/explore';

const ORIGIN = 'https://rootfast.org';

interface Entry {
  loc: string;
  priority?: number;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function render(entries: Entry[]): string {
  const urls = entries
    .map(({ loc, priority }) => {
      const p = priority !== undefined ? `\n    <priority>${priority.toFixed(1)}</priority>` : '';
      return `  <url>\n    <loc>${xmlEscape(loc)}</loc>${p}\n  </url>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

export const GET: APIRoute = async () => {
  const entries: Entry[] = [];

  // Static high-value pages.
  entries.push(
    { loc: `${ORIGIN}/`,                                  priority: 1.0 },
    { loc: `${ORIGIN}/explore`,                           priority: 0.9 },
    { loc: `${ORIGIN}/docs`,                              priority: 0.9 },
    { loc: `${ORIGIN}/about`,                             priority: 0.7 },
    { loc: `${ORIGIN}/contact`,                           priority: 0.5 },
    { loc: `${ORIGIN}/privacy`,                           priority: 0.3 },

    // Standalone explore pages (visualizations + indexes).
    { loc: `${ORIGIN}/explore/hardiness-zone-map`,        priority: 0.8 },
    { loc: `${ORIGIN}/explore/biodiversity-map`,          priority: 0.8 },
    { loc: `${ORIGIN}/explore/photo-coverage-map`,        priority: 0.7 },
    { loc: `${ORIGIN}/explore/soil-map`,                  priority: 0.8 },
    { loc: `${ORIGIN}/explore/blooming-now`,              priority: 0.8 },
    { loc: `${ORIGIN}/explore/where-i-live`,              priority: 0.8 },
    { loc: `${ORIGIN}/explore/families`,                  priority: 0.8 },
    { loc: `${ORIGIN}/explore/state-endemics`,            priority: 0.8 },
  );

  // Curated explore lists (skip the visualization placeholders that have
  // their own routes — those entries carry empty filter sets).
  const ownRoutes = new Set([
    'hardiness-zone-map', 'biodiversity-map', 'photo-coverage-map',
    'soil-map', 'blooming-now', 'where-i-live', 'families', 'state-endemics',
  ]);
  for (const cat of EXPLORE_CATEGORIES) {
    for (const list of cat.lists) {
      if (ownRoutes.has(list.slug)) continue;
      if (Object.keys(list.filters).length === 0) continue;
      entries.push({ loc: `${ORIGIN}/explore/${list.slug}`, priority: 0.7 });
    }
  }

  // States — use the canonical /{state_slug} form (the /states/{code} URL
  // 301-redirects here so we'd be double-listing if we included both).
  for (const code of Object.keys(STATE_NAMES)) {
    entries.push({ loc: `${ORIGIN}/${stateSlugOf(code)}`, priority: 0.7 });
    entries.push({ loc: `${ORIGIN}/explore/state-endemics/${code}`, priority: 0.6 });
  }

  // Families — pull live from the API. Fail soft so a transient API blip
  // doesn't take the whole sitemap offline.
  try {
    const families = await api.families();
    for (const f of families.families) {
      if (!f.family) continue;
      entries.push({
        loc: `${ORIGIN}/explore/family/${encodeURIComponent(f.family)}`,
        priority: 0.6,
      });
    }
  } catch {
    /* sitemap still useful without families */
  }

  return new Response(render(entries), {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      // Cache aggressively at the edge — sitemap content only changes when
      // the catalogue does (rare). Crawlers can still pull fresh on demand.
      'cache-control': 'public, max-age=300, s-maxage=86400',
    },
  });
};
