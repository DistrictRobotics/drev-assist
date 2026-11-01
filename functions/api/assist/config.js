/* GET /api/assist/config — the handful of values the browser needs.
   Both are public by design: the Mapbox token (restrict its allowed URLs in
   Mapbox) and the VAPID public key, which the browser subscribes with. The
   VAPID *private* key never appears here. */
import { json } from '../assist/_shared.js';
import { vapidPublicKey } from './_push.js';

export async function onRequestGet({ env }) {
  return json(
    {
      token: env.MAPBOX_TOKEN || '',
      vapidPublicKey: vapidPublicKey(env),
    },
    200,
    { headers: { 'Cache-Control': 'public, max-age=300' } },
  );
}
