export async function onRequestGet({ env }) {
  return Response.json({ token: env.MAPBOX_TOKEN || '' });
}
