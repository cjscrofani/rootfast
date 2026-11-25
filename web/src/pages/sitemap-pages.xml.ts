import type { APIRoute } from 'astro';
import { api } from '@/lib/api';
import { STATE_NAMES, stateSlugOf } from '@/lib/states';
import { EXPLORE_CATEGORIES } from '@/lib/explore';
import { SITEMAP_ORIGIN, renderUrlset, sitemapResponse, type UrlEntry } from '@/lib/sitemap';

const ORIGIN = SITEMAP_ORIGIN;

// Static + curated + state + family URLs. Plant and county URLs live in their
// own child sitemaps (see /sitemap.xml).
export const GET: APIRoute = async () => {
  const entries: UrlEntry[] = [];

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

  // States — canonical /{state_slug} form, plus the per-state endemics page.
  // Both use the slug (not the 2-letter code) so they resolve without a 301.
  for (const code of Object.keys(STATE_NAMES)) {
    const slug = stateSlugOf(code);
    entries.push({ loc: `${ORIGIN}/${slug}`, priority: 0.7 });
    entries.push({ loc: `${ORIGIN}/explore/state-endemics/${slug}`, priority: 0.6 });
  }

  // Families — pull live from the API. Fail soft so a transient API blip
  // doesn't take the whole sitemap offline.
  let complete = true;
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
    /* sitemap still useful without families — but do not cache it */
    complete = false;
  }

  return sitemapResponse(renderUrlset(entries), complete);
};
