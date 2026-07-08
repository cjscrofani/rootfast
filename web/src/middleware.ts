import { defineMiddleware } from 'astro:middleware';

/**
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

export const onRequest = defineMiddleware(async (_context, next) => {
  const response = await next();
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    if (!response.headers.has(key)) response.headers.set(key, value);
  }
  return response;
});
