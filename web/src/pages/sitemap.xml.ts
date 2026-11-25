import type { APIRoute } from 'astro';
import { api } from '@/lib/api';
import {
  SITEMAP_ORIGIN,
  PLANTS_PER_SITEMAP,
  renderSitemapIndex,
  sitemapResponse,
} from '@/lib/sitemap';

// Sitemap index. Child sitemaps carry the actual URLs; plants are paginated.
export const GET: APIRoute = async () => {
  const children: string[] = [
    `${SITEMAP_ORIGIN}/sitemap-pages.xml`,
    `${SITEMAP_ORIGIN}/sitemap-counties.xml`,
  ];

  // Ask the API how many plants there are so we know how many plant sitemaps
  // to advertise. Fail soft — a blip shouldn't drop the whole index; fall back
  // to a single plants sitemap (which itself fails soft to an empty urlset).
  let plantPages = 1;
  let complete = true;
  try {
    const first = await api.plants({ limit: 1 });
    plantPages = Math.max(1, Math.ceil((first.total ?? 0) / PLANTS_PER_SITEMAP));
  } catch {
    plantPages = 1;
    complete = false;
  }
  for (let i = 0; i < plantPages; i++) {
    children.push(`${SITEMAP_ORIGIN}/sitemap-plants-${i}.xml`);
  }

  return sitemapResponse(renderSitemapIndex(children), complete);
};
