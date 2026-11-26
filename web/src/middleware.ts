import { defineMiddleware } from 'astro:middleware';
import { setApiFetcher, type ApiFetcher } from '@/lib/api';

/**
 * Per-request plumbing for the server-rendered routes: the API service
 * binding, the rendered-page cache, the pages.dev redirect, and the security
 * headers described below.
 *
 * Security headers for every response the Worker serves.
 *
 * The Cloudflare adapter runs in advanced mode (a bundled `_worker.js`), and
 * Cloudflare Pages only applies the `public/_headers` file to genuine static
 * assets — not to pages served through the Worker. Setting the headers here in
 * middleware covers the SSR routes (plant / state / county / sitemaps / search)
 * that `_headers` cannot reach.
 *
 * CSP origins reflect what the site actually loads:
 *   - api.rootfast.org        client-side search fetches (connect-src)
 *   - fonts.googleapis.com    font stylesheet (style-src)
 *   - fonts.gstatic.com       font files (font-src)
 *   - https: images           iNaturalist photos (various hosts) + data: favicon
 *   - challenges.cloudflare.com / forms.golddustweb.com  contact-page embed
 *
 * 'unsafe-inline' is kept for script/style: the site uses inline event handlers
 * and inline <style set:html> on the map pages. The SearchIsland innerHTML is
 * separately hardened with attribute/text escaping, so the CSP is defense in
 * depth rather than the sole XSS control.
 */
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'self'",
  "img-src 'self' data: https:",
  "font-src 'self' https://fonts.gstatic.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com https://forms.golddustweb.com",
  "connect-src 'self' https://api.rootfast.org",
  "frame-src 'self' https://challenges.cloudflare.com https://forms.golddustweb.com",
  "form-action 'self' https://forms.golddustweb.com",
].join('; ');

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
};

/** The production alias Pages gives every project. It serves the same site
 *  as rootfast.org, so search engines index both; send it to the real domain.
 *  Preview deployments (`<hash>.rootfast-web.pages.dev`) are left alone. */
const PAGES_ALIAS = 'rootfast-web.pages.dev';
const CANONICAL_ORIGIN = 'https://rootfast.org';

/** Set at build time (astro.config.mjs). Part of every cache key, so a new
 *  deployment starts with an empty page cache. */
declare const __BUILD_ID__: string;
const BUILD_ID: string = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev';

/** Every query parameter a page reads (grep `searchParams.get` under
 *  src/pages). Anything else — `?fbclid=…`, `?utm_source=…`, `?x=123` — is
 *  ignored by the pages, so it is left out of the cache key: junk parameters
 *  cannot force a fresh render. Keep this list in step with the pages. */
const PAGE_PARAMS = new Set(['page', 'nativity', 'sort', 'state', 'county', 'zip', 'q']);

/** Cache key for a rendered page: build id, origin, path without a trailing
 *  slash, and the known parameters sorted by name (first value of each). */
export function pageCacheKey(url: URL, buildId: string = BUILD_ID): string {
  const seen = new Set<string>();
  const params: [string, string][] = [];
  for (const [k, v] of url.searchParams) {
    if (!PAGE_PARAMS.has(k) || seen.has(k)) continue;
    seen.add(k);
    params.push([k, v]);
  }
  params.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const qs = new URLSearchParams(params);
  qs.append('__b', buildId);
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
  return `${url.origin}${path}?${qs.toString()}`;
}

/** Only successful pages that declared a shared-cache lifetime are kept. */
function isCacheablePage(res: Response): boolean {
  const cc = res.headers.get('cache-control') ?? '';
  return res.status === 200 && /s-maxage=[1-9]/.test(cc) && !cc.includes('no-store');
}

/** Free-text search has an unbounded key space; it is not worth caching. */
function isCacheablePath(pathname: string): boolean {
  return pathname !== '/search' && pathname !== '/search/';
}

function applySecurityHeaders(headers: Headers): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (!headers.has(name)) headers.set(name, value);
  }
}

interface Runtime {
  env?: { API?: ApiFetcher };
  ctx?: { waitUntil(p: Promise<unknown>): void };
  caches?: { default?: Cache };
}

export const onRequest = defineMiddleware(async (context, next) => {
  const { request, url } = context;
  const runtime = (context.locals as { runtime?: Runtime }).runtime;

  if (url.hostname === PAGES_ALIAS) {
    return Response.redirect(`${CANONICAL_ORIGIN}${url.pathname}${url.search}`, 301);
  }

  // Server-rendered pages talk to the API over its service binding. Not in
  // `astro dev`: there the adapter's platform proxy offers a binding too, but
  // it only works with a local `wrangler dev` of the API running, and it
  // would ignore PUBLIC_API_BASE_URL.
  if (!import.meta.env.DEV) setApiFetcher(runtime?.env?.API);

  // Rendered-page cache. Pages set `s-maxage` on themselves, but Cloudflare
  // does not cache a Function's output on its own — every view re-rendered
  // the page and re-queried the API. Serving a stored copy costs about a
  // few milliseconds and no API calls. The cache is per Cloudflare location,
  // and a cache hit is still a Function invocation: this saves CPU and
  // database reads, not request count.
  const cache = request.method === 'GET' && isCacheablePath(url.pathname)
    ? (runtime?.caches?.default ?? (globalThis as { caches?: { default?: Cache } }).caches?.default ?? null)
    : null;
  const key = cache ? pageCacheKey(url) : null;
  if (cache && key) {
    const hit = await cache.match(key).catch(() => undefined);
    // A cached Response has read-only headers and Astro still writes to the
    // response it is handed back, so return a mutable copy.
    if (hit) {
      const headers = new Headers(hit.headers);
      applySecurityHeaders(headers);
      return new Response(hit.body, { status: hit.status, headers });
    }
  }

  const response = await next();
  applySecurityHeaders(response.headers);

  if (cache && key && isCacheablePage(response)) {
    const put = cache.put(key, response.clone()).catch(() => {});
    if (runtime?.ctx) runtime.ctx.waitUntil(put);
  }
  return response;
});
