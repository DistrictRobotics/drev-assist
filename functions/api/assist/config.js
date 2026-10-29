/* GET /api/assist/config — public Mapbox token for the browser.
   The token is public by design; restrict its allowed URLs in Mapbox. */
import { json } from './_shared.js';

export async function onRequestGet({ env }) {
  return json(
    { token: env.MAPBOX_TOKEN || '' },
    200,
    { headers: { 'Cache-Control': 'public, max-age=300' } },
  );
}
