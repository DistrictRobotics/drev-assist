/* Server-side simulated provider feed.
 *
 * Until a real GPS/dispatch feed is connected, the live API serves a
 * deterministic simulation: provider positions are a pure function of the
 * clock (and, for a dispatched job, of the request's own timestamps), so
 * every client sees the same picture and no state has to be stored.
 * Responses always carry `simulated: true` — see the honesty rules.
 *
 * Swap `providersSnapshot` / `providerPositionFor` for real telemetry
 * later; the response shapes are the contract the maps render against.
 */

export const HOTSPOTS = [
  { name: 'Uptown', lng: -80.8431, lat: 35.2271 },
  { name: 'South End', lng: -80.8590, lat: 35.2120 },
  { name: 'NoDa', lng: -80.7960, lat: 35.2470 },
  { name: 'Plaza Midwood', lng: -80.7930, lat: 35.2200 },
  { name: 'University', lng: -80.7350, lat: 35.3070 },
  { name: 'SouthPark', lng: -80.8250, lat: 35.1600 },
  { name: 'Airport', lng: -80.9430, lat: 35.2140 },
  { name: 'Ballantyne', lng: -80.8200, lat: 35.0530 },
];

const toRad = d => (d * Math.PI) / 180;
export function bearingDeg(a, b) {
  const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat))
    - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
const lerp = (a, b, t) => a + (b - a) * t;
const easeInOut = t => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2);

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < String(s).length; i++) { h ^= String(s).charCodeAt(i); h = Math.imul(h, 16777619); }
  return Math.abs(h);
}

/** Where is the (simulated) provider for this dispatched request right now? */
export function providerPositionFor(request, nowMs = Date.now()) {
  const start = HOTSPOTS[hashStr(request.id) % HOTSPOTS.length];
  const target = { lng: Number(request.location_lng), lat: Number(request.location_lat) };
  if (!Number.isFinite(target.lng) || !Number.isFinite(target.lat)) return null;

  const dispatchedAt = Date.parse(request.updated_at || request.requested_at) || nowMs;
  const TRIP_MS = 12 * 60 * 1000; // simulated 12-minute approach
  const raw = Math.min(Math.max((nowMs - dispatchedAt) / TRIP_MS, 0), 1);
  const t = easeInOut(raw);

  // Gentle bow so the path does not cut through blocks in a straight line.
  const bend = Math.sin(t * Math.PI) * 0.008;
  const dx = target.lng - start.lng;
  const dy = target.lat - start.lat;
  const pos = {
    lng: lerp(start.lng, target.lng, t) - dy * bend * 4,
    lat: lerp(start.lat, target.lat, t) + dx * bend * 4,
  };
  return {
    simulated: true,
    label: request.provider_label || 'Assigned provider',
    position: pos,
    bearing: Math.round(bearingDeg(pos, target)),
    progress: Math.round(raw * 100) / 100,
    arrived: raw >= 1,
    updatedAt: new Date(nowMs).toISOString(),
  };
}

const UNITS = [
  { id: 'unit-1', label: 'Unit 1 · EV Service Van', home: 0 },
  { id: 'unit-2', label: 'Unit 2 · Tire & Battery', home: 1 },
  { id: 'unit-3', label: 'Unit 3 · Tow Coordinator', home: 3 },
  { id: 'unit-4', label: 'Unit 4 · EV Service Van', home: 4 },
  { id: 'unit-5', label: 'Unit 5 · Roadside Tech', home: 5 },
  { id: 'unit-6', label: 'Unit 6 · Fuel & Jump', home: 6 },
];

/** Fleet snapshot: each unit loops between hotspots on an 18-minute cycle. */
export function providersSnapshot(nowMs = Date.now()) {
  const CYCLE_MS = 18 * 60 * 1000;
  return UNITS.map((u, i) => {
    const phase = ((nowMs / CYCLE_MS) + i / UNITS.length) % 1;
    const leg = Math.floor(((nowMs / CYCLE_MS) + i / UNITS.length)) ;
    const from = HOTSPOTS[(u.home + leg) % HOTSPOTS.length];
    const to = HOTSPOTS[(u.home + leg + 2) % HOTSPOTS.length];
    const moving = phase < 0.8; // 80% driving, 20% on a job / staged
    const t = moving ? easeInOut(phase / 0.8) : 1;
    const anchor = moving ? to : to;
    const pos = moving
      ? { lng: lerp(from.lng, to.lng, t), lat: lerp(from.lat, to.lat, t) }
      : { lng: anchor.lng, lat: anchor.lat };
    return {
      id: u.id, label: u.label, simulated: true,
      status: moving ? 'en_route' : 'in_service',
      position: pos,
      bearing: moving ? Math.round(bearingDeg(pos, to)) : 0,
      destination: to.name,
    };
  });
}

export const OUTAGE_ZONES = [
  { id: 'out-1', area: 'NoDa / Plaza Midwood', customers: 1240, restoreHrs: 3, cause: 'Feeder fault (demo)', demo: true },
  { id: 'out-2', area: 'University area', customers: 480, restoreHrs: 1.5, cause: 'Planned maintenance (demo)', demo: true },
  { id: 'out-3', area: 'Airport corridor', customers: 210, restoreHrs: 5, cause: 'Storm damage (demo)', demo: true },
];
