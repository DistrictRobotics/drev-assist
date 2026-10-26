// Injects the Mapbox public token into the page at the edge so it never
// has to live in the repo, where GitHub push protection rejects it.
export async function onRequest({ request, env, next }) {
  const res = await next();
  if (!env.MAPBOX_TOKEN) return res;
  if (!/^text\/html/.test(res.headers.get('content-type') || '')) return res;

  return new HTMLRewriter()
    .on('meta[name="mapbox-token"]', {
      element: el => el.setAttribute('content', env.MAPBOX_TOKEN),
    })
    .transform(res);
}
