// Injects the Mapbox public token into the page at the edge so it never
// has to live in the repo, where GitHub push protection rejects it.
// Also guarantees baseline security headers on every response, including
// API routes (which bypass the static `_headers` file in some setups).
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

export async function onRequest({ request, env, next }) {
  const res = await next();
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    if (!headers.has(k)) headers.set(k, v);
  }
  if (new URL(request.url).pathname.startsWith('/api/') && !headers.has('Cache-Control')) {
    headers.set('Cache-Control', 'no-store');
  }
  const secured = new Response(res.body, { status: res.status, statusText: res.statusText, headers });

  if (!env.MAPBOX_TOKEN) return secured;
  if (!/^text\/html/.test(secured.headers.get('content-type') || '')) return secured;

  return new HTMLRewriter()
    .on('meta[name="mapbox-token"]', {
      element: el => el.setAttribute('content', env.MAPBOX_TOKEN),
    })
    .transform(secured);
}
