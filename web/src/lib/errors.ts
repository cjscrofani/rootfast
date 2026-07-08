/**
 * Self-contained error-page responses for SSR routes.
 *
 * These deliberately do NOT depend on the API or on any component that fetches
 * data — they must render correctly precisely when the upstream API is down.
 * Used to fail soft (503 + Retry-After) on transient upstream errors instead
 * of throwing, which would surface a bare platform 500.
 */

function htmlPage(opts: {
  status: number;
  title: string;
  heading: string;
  message: string;
  retryAfter?: number;
}): Response {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(opts.title)} · rootfast</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: #faf6ee; color: #2b2a26;
         font-family: ui-sans-serif, system-ui, sans-serif; padding: 2rem; }
  main { max-width: 34rem; text-align: center; }
  h1 { font-family: ui-serif, Georgia, serif; font-size: 1.75rem; margin: 0 0 .75rem; }
  p { line-height: 1.6; margin: 0 0 1.5rem; color: #55524a; }
  a { color: #2d4f1e; }
  @media (prefers-color-scheme: dark) {
    body { background: #16150f; color: #e8e4d8; }
    p { color: #b7b2a3; } a { color: #9ec982; }
  }
</style>
</head>
<body>
<main>
  <h1>${esc(opts.heading)}</h1>
  <p>${esc(opts.message)}</p>
  <p><a href="/">Return to rootfast</a></p>
</main>
</body>
</html>`;
  const headers: Record<string, string> = {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  };
  if (opts.retryAfter) headers['retry-after'] = String(opts.retryAfter);
  return new Response(body, { status: opts.status, headers });
}

/** 503 for a transient upstream failure — safe to retry. */
export function serviceUnavailable(what = 'This page'): Response {
  return htmlPage({
    status: 503,
    title: 'Temporarily unavailable',
    heading: 'Temporarily unavailable',
    message: `${what} couldn’t be loaded because the data service is not responding right now. Please try again in a moment.`,
    retryAfter: 30,
  });
}

/** 404 for a resource that doesn't exist. */
export function notFoundPage(message: string): Response {
  return htmlPage({
    status: 404,
    title: 'Not found',
    heading: 'Not found',
    message,
  });
}
