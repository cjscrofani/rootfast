import type { APIRoute } from 'astro';
import { api } from '@/lib/api';
import {
  SITEMAP_ORIGIN,
  PLANTS_PER_SITEMAP,
  renderUrlset,
  sitemapResponse,
  type UrlEntry,
} from '@/lib/sitemap';

// One page of plant URLs. `page` is 0-indexed; the sitemap index advertises
// exactly as many of these as there are pages of plants.
export const GET: APIRoute = async ({ params }) => {
  const raw = parseInt(params.page ?? '', 10);
  const page = Number.isFinite(raw) && raw >= 0 ? raw : 0;

  let entries: UrlEntry[] = [];
  try {
    const { plants } = await api.plants({
      limit: PLANTS_PER_SITEMAP,
      offset: page * PLANTS_PER_SITEMAP,
    });
    entries = plants.map((p) => ({
      loc: `${SITEMAP_ORIGIN}/plants/${encodeURIComponent(p.usda_symbol)}`,
      priority: 0.6,
    }));
  } catch {
    /* fail soft — emit an empty (but valid) urlset */
  }
  return sitemapResponse(renderUrlset(entries));
};
