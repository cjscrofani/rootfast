import type { APIRoute } from 'astro';
import { api } from '@/lib/api';
import { slugifyCounty, stateSlugOf } from '@/lib/states';
import {
  countyCanonicalPaths,
  renderUrlset,
  sitemapResponse,
  type UrlEntry,
} from '@/lib/sitemap';

// Every county's canonical /{state_slug}/{county_slug} URL. There are ~3.2k
// counties, comfortably within one urlset and one API page (limit 5000).
export const GET: APIRoute = async () => {
  let entries: UrlEntry[] = [];
  try {
    const { counties } = await api.counties({ limit: 5000 });
    entries = countyCanonicalPaths(counties, slugifyCounty, stateSlugOf).map((loc) => ({
      loc,
      priority: 0.5,
    }));
  } catch {
    /* fail soft — emit an empty (but valid) urlset */
  }
  return sitemapResponse(renderUrlset(entries));
};
