/* =========================================================
   DREV Assist — realtime layer (shared browser core)

   Generates the live picture used by the manager dispatch map and the
   customer tracking view:
     • simulated provider units moving along plausible routes (DEMO feed —
       labelled as simulated everywhere it is shown; swap the source for a
       real GPS/dispatch feed and the rendering code does not change)
     • a 24h demand replay dataset (4D: 3D map + time scrubber)
     • demo outage zones for the home-energy view

   Pure, seeded and deterministic so demos and tests are repeatable.
   Attaches `DrevLive` to the global; also importable in Node for tests.
   ========================================================= */
(function attach(global) {
  'use strict';

  /* ── Deterministic RNG ────────────────────────────────── */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function next() {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ── Charlotte geography ──────────────────────────────── */
  const HOTSPOTS = [
    { name: 'Uptown',        lng: -80.8431, lat: 35.2271, weight: 5 },
    { name: 'South End',     lng: -80.8590, lat: 35.2120, weight: 4 },
    { name: 'NoDa',          lng: -80.7960, lat: 35.2470, weight: 3 },
    { name: 'Plaza Midwood', lng: -80.7930, lat: 35.2200, weight: 3 },
    { name: 'University',    lng: -80.7350, lat: 35.3070, weight: 3 },
    { name: 'SouthPark',     lng: -80.8250, lat: 35.1600, weight: 2 },
    { name: 'Airport',       lng: -80.9430, lat: 35.2140, weight: 2 },
    { name: 'Ballantyne',    lng: -80.8200, lat: 35.0530, weight: 2 },
  ];

  const SERVICES = [
    'mobile-ev-charge', 'jump-start', 'flat-tire', 'tow-coordination',
    'lockout', 'fuel-delivery', 'other-roadside', 'collision-incident',
  ];

  /* ── Geo math ─────────────────────────────────────────── */
  const toRad = d => (d * Math.PI) / 180;
  function haversineKm(a, b) {
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const s = Math.sin(dLat / 2) ** 2
      + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
  }
  function bearingDeg(a, b) {
    const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
    const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat))
      - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeInOut = t => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2);

  /**
   * A gently bowed route between two points (reads as street-following at
   * demo zoom levels; a real deployment swaps this for Mapbox Directions).
   * Returns [{lng, lat}, …] with cumulative distances.
   */
  function routeBetween(from, to, seed = 1) {
    const rand = mulberry32(seed);
    const segments = 24;
    const bow = (rand() - 0.5) * 0.012; // perpendicular offset, degrees
    const dx = to.lng - from.lng;
    const dy = to.lat - from.lat;
    const pts = [];
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const bend = Math.sin(t * Math.PI) * bow;
      pts.push({ lng: lerp(from.lng, to.lng, t) - dy * bend * 4, lat: lerp(from.lat, to.lat, t) + dx * bend * 4 });
    }
    let total = 0;
    pts.forEach((p, i) => {
      if (i > 0) total += haversineKm(pts[i - 1], p);
      p.distKm = total;
    });
    pts.totalKm = total;
    return pts;
  }

  function pointAlongRoute(route, fraction) {
    const target = route.totalKm * Math.min(Math.max(fraction, 0), 1);
    let i = 1;
    while (i < route.length - 1 && route[i].distKm < target) i++;
    const prev = route[i - 1];
    const next = route[i];
    const span = (next.distKm - prev.distKm) || 1;
    const t = (target - prev.distKm) / span;
    const pos = { lng: lerp(prev.lng, next.lng, t), lat: lerp(prev.lat, next.lat, t) };
    return { ...pos, bearing: bearingDeg(prev, next) };
  }

  /* ── Provider simulation (demo feed) ──────────────────── */
  const PROVIDER_SEED = [
    { id: 'unit-1', label: 'Unit 1 · EV Service Van', home: 0, skills: ['mobile-ev-charge', 'jump-start', 'lockout'] },
    { id: 'unit-2', label: 'Unit 2 · Tire & Battery', home: 1, skills: ['flat-tire', 'jump-start', 'fuel-delivery'] },
    { id: 'unit-3', label: 'Unit 3 · Tow Coordinator', home: 3, skills: ['tow-coordination', 'collision-incident'] },
    { id: 'unit-4', label: 'Unit 4 · EV Service Van', home: 4, skills: ['mobile-ev-charge', 'jump-start'] },
    { id: 'unit-5', label: 'Unit 5 · Roadside Tech', home: 5, skills: ['flat-tire', 'lockout', 'other-roadside'] },
    { id: 'unit-6', label: 'Unit 6 · Fuel & Jump', home: 6, skills: ['fuel-delivery', 'jump-start'] },
  ];
  const DEMO_SPEED = 10; // time acceleration so movement is visible in demos

  function createSimulation(seed = 42) {
    const rand = mulberry32(seed);
    const providers = PROVIDER_SEED.map((p, i) => {
      const home = HOTSPOTS[p.home];
      const target = HOTSPOTS[(p.home + 2 + i) % HOTSPOTS.length];
      return {
        ...p,
        status: i % 3 === 0 ? 'available' : 'en_route',
        from: { lng: home.lng, lat: home.lat },
        to: { lng: target.lng, lat: target.lat, name: target.name },
        progress: rand() * 0.6,
        route: routeBetween(home, target, seed + i),
        jobService: p.skills[i % p.skills.length],
        dwellSec: 0,
      };
    });

    function retarget(pv, idx) {
      const rand2 = mulberry32(seed + idx * 97 + Math.floor(pv.progress * 1000) + providers.length);
      const dest = HOTSPOTS[Math.floor(rand2() * HOTSPOTS.length)];
      pv.from = { ...pv.to };
      pv.to = { lng: dest.lng, lat: dest.lat, name: dest.name };
      pv.route = routeBetween(pv.from, pv.to, seed + idx * 13 + dest.lng * 1000);
      pv.progress = 0;
      pv.status = pv.status === 'available' ? 'en_route' : pv.status;
      pv.jobService = pv.skills[Math.floor(rand2() * pv.skills.length)];
    }

    return {
      providers,
      /* Advance the world by `seconds` of wall time (demo-accelerated). */
      tick(seconds) {
        const dt = seconds * DEMO_SPEED;
        providers.forEach((pv, i) => {
          if (pv.status === 'available') {
            pv.dwellSec += dt;
            if (pv.dwellSec > 45) { pv.dwellSec = 0; pv.status = 'en_route'; retarget(pv, i); }
            return;
          }
          if (pv.status === 'in_service') {
            pv.dwellSec += dt;
            if (pv.dwellSec > 60) { pv.dwellSec = 0; pv.status = 'available'; }
            return;
          }
          // en_route: ~28 km/h average across the route
          const speedKms = 28 / 3600;
          pv.progress += (speedKms * dt) / Math.max(pv.route.totalKm, 0.1);
          if (pv.progress >= 1) {
            pv.progress = 1;
            pv.status = 'in_service';
            pv.dwellSec = 0;
          }
        });
      },
      position(pv) {
        if (pv.status === 'available' || pv.status === 'in_service') {
          const at = pv.status === 'available' ? pv.from : pv.to;
          return { lng: at.lng, lat: at.lat, bearing: 0 };
        }
        return pointAlongRoute(pv.route, easeInOut(pv.progress));
      },
    };
  }

  function providersGeoJSON(sim) {
    return {
      type: 'FeatureCollection',
      features: sim.providers.map(pv => {
        const pos = sim.position(pv);
        return {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [pos.lng, pos.lat] },
          properties: {
            id: pv.id, label: pv.label, status: pv.status,
            service: pv.jobService, destination: pv.to.name, bearing: Math.round(pos.bearing || 0),
          },
        };
      }),
    };
  }

  function routesGeoJSON(sim) {
    return {
      type: 'FeatureCollection',
      features: sim.providers
        .filter(pv => pv.status === 'en_route')
        .map(pv => ({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: pv.route.map(p => [p.lng, p.lat]) },
          properties: { id: pv.id, status: pv.status },
        })),
    };
  }

  function requestsGeoJSON(requests) {
    return {
      type: 'FeatureCollection',
      features: (requests || [])
        .filter(r => Number.isFinite(r.location_lat) && Number.isFinite(r.location_lng))
        .map(r => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [r.location_lng, r.location_lat] },
          properties: {
            id: r.id, status: r.status, service: r.service_type,
            category: r.category, label: r.location_label || '',
          },
        })),
    };
  }

  /* ── 4D demand replay ─────────────────────────────────── */
  const HOUR_WEIGHTS = [1, 1, 1, 1, 1, 2, 4, 7, 9, 6, 4, 4, 5, 4, 4, 5, 7, 9, 8, 6, 4, 3, 2, 1]; // rush-hour peaks
  function pickWeighted(rand, items, weightOf) {
    const total = items.reduce((s, it) => s + weightOf(it), 0);
    let x = rand() * total;
    for (const it of items) { x -= weightOf(it); if (x <= 0) return it; }
    return items[items.length - 1];
  }

  function generateDemand(seed = 7, count = 220) {
    const rand = mulberry32(seed);
    const hours = HOUR_WEIGHTS.map((w, h) => ({ h, w }));
    const events = [];
    for (let i = 0; i < count; i++) {
      const { h } = pickWeighted(rand, hours, x => x.w);
      const spot = pickWeighted(rand, HOTSPOTS, x => x.weight);
      events.push({
        lng: spot.lng + (rand() - 0.5) * 0.045,
        lat: spot.lat + (rand() - 0.5) * 0.035,
        minute: Math.min(1439, h * 60 + Math.floor(rand() * 60)),
        service: SERVICES[Math.floor(rand() * SERVICES.length)],
        area: spot.name,
      });
    }
    return events.sort((a, b) => a.minute - b.minute);
  }

  /** Events in the trailing `windowMin` minutes ending at `minute`. */
  function demandFrame(events, minute, windowMin = 90) {
    return events.filter(e => e.minute <= minute && e.minute > minute - windowMin);
  }

  function demandGeoJSON(events) {
    return {
      type: 'FeatureCollection',
      features: events.map(e => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [e.lng, e.lat] },
        properties: { service: e.service, area: e.area, minute: e.minute },
      })),
    };
  }

  const fmtClock = minute => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(Math.floor(minute % 60)).padStart(2, '0')}`;

  /* ── Demo outage zones (home energy) ──────────────────── */
  function polygonAround(center, radiusDeg, seed) {
    const rand = mulberry32(seed);
    const coords = [];
    const n = 9;
    for (let i = 0; i <= n; i++) {
      const ang = (i / n) * Math.PI * 2;
      const r = radiusDeg * (0.75 + rand() * 0.5);
      coords.push([center.lng + Math.cos(ang) * r, center.lat + Math.sin(ang) * r * 0.8]);
    }
    return coords;
  }

  const OUTAGE_ZONES = [
    { id: 'out-1', area: 'NoDa / Plaza Midwood', center: HOTSPOTS[2], customers: 1240, restoreHrs: 3, cause: 'Feeder fault (demo)' },
    { id: 'out-2', area: 'University area', center: HOTSPOTS[4], customers: 480, restoreHrs: 1.5, cause: 'Planned maintenance (demo)' },
    { id: 'out-3', area: 'Airport corridor', center: HOTSPOTS[6], customers: 210, restoreHrs: 5, cause: 'Storm damage (demo)' },
  ];

  function outagesGeoJSON() {
    return {
      type: 'FeatureCollection',
      features: OUTAGE_ZONES.map((z, i) => ({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [polygonAround(z.center, 0.028, 100 + i)] },
        properties: {
          id: z.id, area: z.area, customers: z.customers,
          restoreHrs: z.restoreHrs, cause: z.cause, demo: true,
          height: Math.max(60, z.customers / 4),
        },
      })),
    };
  }

  const api = {
    HOTSPOTS, SERVICES, OUTAGE_ZONES,
    mulberry32, haversineKm, bearingDeg, routeBetween, pointAlongRoute, easeInOut,
    createSimulation, providersGeoJSON, routesGeoJSON, requestsGeoJSON,
    generateDemand, demandFrame, demandGeoJSON, fmtClock, outagesGeoJSON,
  };

  global.DrevLive = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
