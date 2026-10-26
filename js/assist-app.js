/* =========================================================
   DREV Assist — customer app
   Real Mapbox GL JS · Charlotte NC · Sheet physics

   Honesty rules enforced here:
   - The green "submitted" state appears ONLY after the server confirms
     the request was stored (HTTP 201). Anything else is shown as
     NOT SENT with a clearly-labelled local reference — never as success.
   - What is sent is a frozen snapshot shown in the review dialog first;
     the form is never re-read mid-send.
   - Retries reuse the same Idempotency-Key, so a flaky connection
     cannot create duplicate requests.
   ========================================================= */
'use strict';

let TOKEN = document.querySelector('meta[name="mapbox-token"]')?.content || '';
const CENTER = [-80.843, 35.227];
const NC_BBOX = [-84.3, 33.8, -75.4, 36.6];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const $ = id => document.getElementById(id);
const rm = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* Fallback copy — refreshed from GET /api/assist/services when reachable,
   so guidance never drifts from the server-side catalogue. */
let SERVICE_GUIDANCE = {
  'mobile-ev-charge': 'Stay with the vehicle if safe. Note your battery % and nearest cross-street.',
  'jump-start': 'Turn off lights and accessories. Note any clicking or dashboard warnings.',
  'flat-tire': 'Pull fully off the roadway if possible. Tell us if you have a spare and which tire is flat.',
  'tow-coordination': 'Tell us where the vehicle needs to go and whether it can roll / be put in neutral.',
  'lockout': 'Have photo ID ready — the provider must verify you own or rent the vehicle.',
  'fuel-delivery': 'Confirm your fuel type (regular / premium / diesel) and stay in a safe spot.',
  'collision-incident': 'Not emergency services — call 911 for injuries. Move to safety and exchange info if safe to do so.',
  'other-roadside': 'Describe the problem in the Situation box so a dispatcher can route it correctly.',
  'home-charger-install': 'Photos of your panel and parking spot help. Note the distance from panel to vehicle.',
  'home-charger-repair': 'Note the charger brand/model and any error lights or breaker trips.',
  'v2h-planning': 'Tell us your vehicle model and what you want powered during an outage.',
  'panel-battery-review': 'A photo of your panel label (amperage, open slots) speeds up the review.',
  'outage-readiness': 'List the loads that matter most (medical, refrigeration, heating) and outage history.',
  'other-home': 'Describe your goal and current setup in the Situation box.',
};
const SERVICE_LABELS = {
  'mobile-ev-charge': 'Mobile EV Charge', 'jump-start': 'Jump Start', 'flat-tire': 'Flat Tire',
  'tow-coordination': 'Tow Coordination', 'lockout': 'Lockout', 'fuel-delivery': 'Fuel Delivery',
  'collision-incident': 'Collision Incident', 'other-roadside': 'Other Roadside',
  'home-charger-install': 'Charger Install', 'home-charger-repair': 'Charger Repair',
  'v2h-planning': 'V2H Planning', 'panel-battery-review': 'Panel / Battery Review',
  'outage-readiness': 'Outage Readiness', 'other-home': 'Other Home Energy',
};

/* ── State ──────────────────────────────────────────────── */
let map, geocoder;
let pickupLng = CENTER[0], pickupLat = CENTER[1], pickupAddr = 'Charlotte, NC';
let activeCategory = 'roadside', activeSvc = 'mobile-ev-charge', activePowertrain = 'ev';
let reverseSeq = 0, reverseCtrl = null;
let satellite = false;
let busy = false;
let pendingSnapshot = null;   // frozen review snapshot awaiting / retrying a send
let trackedId = null;         // request id currently shown in the tracker
let trackedRequest = null;    // last status payload (may carry a provider feed)
let tracking = null;          // active live-tracking session
let lastFocused = null;

/* ── Map ────────────────────────────────────────────────── */
function initMap() {
  if (!window.mapboxgl) return;
  mapboxgl.accessToken = TOKEN;

  map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/navigation-night-v1',
    center: CENTER,
    zoom: 14,
    pitch: 58,
    bearing: -15,
    antialias: true,
    maxPitch: 85,
    attributionControl: false,
  });

  map.addControl(new mapboxgl.AttributionControl({ compact: true }), 'bottom-left');

  map.on('load', () => {
    try {
      map.setFog({ color: 'rgb(8,18,32)', 'high-color': 'rgb(3,8,15)', 'space-color': 'rgb(3,8,15)', 'star-intensity': 0.9 });
      const labelLayer = map.getStyle().layers.find(l => l.type === 'symbol' && l.layout?.['text-field']);
      map.addLayer({
        id: 'drev-3d',
        source: 'composite',
        'source-layer': 'building',
        filter: ['==', 'extrude', 'true'],
        type: 'fill-extrusion',
        minzoom: 13,
        paint: {
          'fill-extrusion-color': '#0a1e32',
          'fill-extrusion-height': ['coalesce', ['get', 'height'], 0],
          'fill-extrusion-base': ['coalesce', ['get', 'min_height'], 0],
          'fill-extrusion-opacity': 0.88,
        },
      }, labelLayer?.id);
    } catch (_) { /* 3D buildings are decorative */ }

    reverseGeocode(CENTER[0], CENTER[1]);
  });

  map.on('movestart', () => {
    $('pickup-pin').classList.add('dragging');
    setAddrBadge('MOVING', false);
  });

  map.on('moveend', () => {
    $('pickup-pin').classList.remove('dragging');
    const c = map.getCenter();
    pickupLng = c.lng; pickupLat = c.lat;
    invalidateLocationConfirmation();
    reverseGeocode(c.lng, c.lat);
  });
}

/* Moving the pin invalidates the "this is where help should come" check. */
function invalidateLocationConfirmation() {
  const chk = $('chk-location');
  if (chk) chk.checked = false;
}

/* ── Geocoder ───────────────────────────────────────────── */
function initGeocoder() {
  if (!window.MapboxGeocoder) return;
  geocoder = new MapboxGeocoder({
    accessToken: TOKEN,
    mapboxgl,
    countries: 'us',
    bbox: NC_BBOX,
    proximity: { longitude: CENTER[0], latitude: CENTER[1] },
    placeholder: 'Search address in North Carolina',
    marker: false,
    flyTo: { speed: 1.6, curve: 1.4, pitch: 58, bearing: -15 },
  });
  $('geocoder-wrap').appendChild(geocoder.onAdd(map));
  geocoder.on('result', e => {
    const [lng, lat] = e.result.center;
    pickupLng = lng; pickupLat = lat;
    pickupAddr = e.result.place_name;
    invalidateLocationConfirmation();
    setAddrText(pickupAddr);
    setAddrBadge('SET', true);
  });
}

/* ── Reverse geocode ────────────────────────────────────── */
async function reverseGeocode(lng, lat) {
  const seq = ++reverseSeq;
  reverseCtrl?.abort();
  reverseCtrl = new AbortController();
  try {
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json?access_token=${encodeURIComponent(TOKEN)}&country=us&limit=1`;
    const r = await fetch(url, { signal: reverseCtrl.signal });
    if (!r.ok) throw new Error();
    const d = await r.json();
    if (seq !== reverseSeq) return;
    pickupAddr = d.features?.[0]?.place_name || `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    setAddrText(pickupAddr);
    setAddrBadge('SET', true);
  } catch (e) {
    if (e.name !== 'AbortError' && seq === reverseSeq) {
      setAddrText(`${lat.toFixed(4)}, ${lng.toFixed(4)}`);
      setAddrBadge('PIN', false);
    }
  }
}

function setAddrText(text) { $('addr-text').textContent = text; }
function setAddrBadge(label, ok) {
  const el = $('addr-accuracy');
  el.textContent = label;
  el.className = 'addr-badge' + (ok ? ' set' : '');
}

/* ── Pin positioning ────────────────────────────────────── */
function positionPin() {
  if (!map) return;
  const r = map.getCanvas().getBoundingClientRect();
  const pin = $('pickup-pin');
  pin.style.left = (r.left + r.width / 2) + 'px';
  pin.style.top = (r.top + r.height / 2) + 'px';
}
window.addEventListener('resize', positionPin);

/* ── Bottom sheet physics ───────────────────────────────── */
const sheet = $('sheet');
const handleRow = $('sheet-handle-row');

const SNAP_PEEK = 72;
const SNAP_MID = () => Math.min(360, window.innerHeight * 0.55);
const SNAP_FULL = () => window.innerHeight * 0.92;

let currentSnap = 'mid';
let dragging = false;
let dragStartY = 0, dragStartH = 0;
let velY = 0, lastY = 0, lastT = 0;

function snapTo(name, animate = true) {
  currentSnap = name;
  if (animate) {
    sheet.classList.add('animate');
    setTimeout(() => sheet.classList.remove('animate'), 360);
  }
  sheet.dataset.snap = name;

  const h = name === 'full' ? SNAP_FULL() : name === 'peek' ? SNAP_PEEK : SNAP_MID();
  sheet.style.height = h + 'px';

  if (map) {
    const lock = name === 'full';
    map.scrollZoom[lock ? 'disable' : 'enable']();
    map.dragPan[lock ? 'disable' : 'enable']();
    map.touchZoomRotate[lock ? 'disable' : 'enable']();
  }

  $('geocoder-wrap').classList.toggle('visible', name !== 'peek');
  $('map-fabs').style.bottom = (h + 24) + 'px';
}

handleRow.addEventListener('click', () => {
  if (dragging) return;
  snapTo(currentSnap === 'peek' ? 'mid' : currentSnap === 'mid' ? 'full' : 'mid');
});

handleRow.addEventListener('pointerdown', e => {
  dragging = true;
  dragStartY = e.clientY;
  dragStartH = sheet.getBoundingClientRect().height;
  velY = 0; lastY = e.clientY; lastT = Date.now();
  handleRow.setPointerCapture(e.pointerId);
  e.preventDefault();
}, { passive: false });

handleRow.addEventListener('pointermove', e => {
  if (!dragging) return;
  const dy = dragStartY - e.clientY;
  const h = Math.max(SNAP_PEEK, Math.min(SNAP_FULL(), dragStartH + dy));
  sheet.style.height = h + 'px';
  sheet.classList.remove('animate');
  sheet.dataset.snap = '';

  const now = Date.now();
  if (now > lastT) velY = (lastY - e.clientY) / (now - lastT) * 100;
  lastY = e.clientY; lastT = now;
}, { passive: true });

function endDrag() {
  if (!dragging) return;
  dragging = false;
  const h = sheet.getBoundingClientRect().height;
  const mid = SNAP_MID();
  const full = SNAP_FULL();
  let target = 'mid';
  if (velY > 22 || h > mid + (full - mid) * 0.55) target = 'full';
  else if (velY < -22 || h < mid * 0.45) target = 'peek';
  snapTo(target);
}
handleRow.addEventListener('pointerup', endDrag);
handleRow.addEventListener('pointercancel', () => { dragging = false; snapTo(currentSnap); });

$('sheet-addr-row').addEventListener('click', () => {
  if (currentSnap === 'peek') snapTo('mid');
  else $('geocoder-wrap').querySelector('input')?.focus();
});

/* ── Category toggle ────────────────────────────────────── */
$('cat-toggle').addEventListener('click', e => {
  const btn = e.target.closest('.cat-btn');
  if (!btn || btn.dataset.cat === activeCategory) return;
  activeCategory = btn.dataset.cat;
  document.querySelectorAll('.cat-btn').forEach(b => {
    const on = b.dataset.cat === activeCategory;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  });
  $('sec-roadside').classList.toggle('hidden', activeCategory !== 'roadside');
  $('sec-home').classList.toggle('hidden', activeCategory !== 'home');
  $('roadside-fields').classList.toggle('hidden', activeCategory !== 'roadside');
  $('home-fields').classList.toggle('hidden', activeCategory !== 'home');
  $('mode-toggle').textContent = activeCategory === 'roadside' ? 'ROADSIDE' : 'HOME ENERGY';
  $('inp-notes').placeholder = activeCategory === 'roadside'
    ? 'Battery %, warning lights, road conditions…'
    : 'Describe what you need — current setup, concerns, timeline…';
  /* Required markers differ: home consults accept email instead of phone. */
  document.querySelector('label[for="inp-name"]').textContent = activeCategory === 'roadside' ? 'YOUR NAME *' : 'YOUR NAME';
  document.querySelector('label[for="inp-phone"]').textContent = activeCategory === 'roadside' ? 'PHONE *' : 'PHONE';

  const first = document.querySelector(`.svc-card[data-cat="${activeCategory}"]`);
  if (first) selectCard(first);
});

$('mode-toggle').addEventListener('click', () => {
  const next = activeCategory === 'roadside' ? 'home' : 'roadside';
  document.querySelector(`.cat-btn[data-cat="${next}"]`)?.click();
});

/* ── Powertrain toggle (single handler) ─────────────────── */
$('pt-toggle').addEventListener('click', e => {
  const btn = e.target.closest('.pt-btn');
  if (!btn || btn.dataset.pt === activePowertrain) return;
  activePowertrain = btn.dataset.pt;
  document.querySelectorAll('#pt-toggle .pt-btn').forEach(b => {
    const on = b.dataset.pt === activePowertrain;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
  filterRoadside(activePowertrain);
});

function filterRoadside(pt) {
  $('svc-grid-roadside').querySelectorAll('.svc-card').forEach(card => {
    const only = card.dataset.ptOnly;
    const dim = !!(only && only !== pt);
    card.classList.toggle('pt-dimmed', dim);
    card.disabled = dim;
    if (dim) { card.classList.remove('active'); card.setAttribute('aria-pressed', 'false'); }
  });
  if (!$('svc-grid-roadside').querySelector('.svc-card.active:not(:disabled)')) {
    const first = $('svc-grid-roadside').querySelector('.svc-card:not(:disabled)');
    if (first) selectCard(first);
  }
}

/* Home energy pill groups */
['pill-property', 'pill-panel', 'pill-existing'].forEach(id => {
  const el = $(id);
  if (!el) return;
  el.addEventListener('click', e => {
    const btn = e.target.closest('.pill');
    if (!btn) return;
    el.querySelectorAll('.pill').forEach(b => { b.classList.remove('active'); b.setAttribute('aria-pressed', 'false'); });
    btn.classList.add('active');
    btn.setAttribute('aria-pressed', 'true');
  });
});

/* ── Service selection ──────────────────────────────────── */
document.querySelectorAll('.svc-grid').forEach(grid => {
  grid.addEventListener('click', e => {
    const card = e.target.closest('.svc-card');
    if (!card || card.disabled) return;
    selectCard(card);
    if (currentSnap !== 'full') snapTo('full');
  });
});

function selectCard(card) {
  const cat = card.dataset.cat;
  document.querySelectorAll(`.svc-card[data-cat="${cat}"]`).forEach(c => {
    c.classList.remove('active');
    c.setAttribute('aria-pressed', 'false');
  });
  card.classList.add('active');
  card.setAttribute('aria-pressed', 'true');
  activeSvc = card.dataset.svc;
  $('collision-block').classList.toggle('hidden', activeSvc !== 'collision-incident');
  $('svc-guidance').textContent = SERVICE_GUIDANCE[activeSvc] || '';
}

/* ── Notes counter ──────────────────────────────────────── */
$('inp-notes').addEventListener('input', () => {
  $('notes-count').textContent = $('inp-notes').value.length;
});

/* ── Overlay helpers (focus in / focus back) ────────────── */
function openOverlay(el) {
  lastFocused = document.activeElement;
  el.classList.remove('hidden');
  el.querySelector('button:not([disabled])')?.focus();
}
function closeOverlay(el) {
  el.classList.add('hidden');
  if (lastFocused?.focus) lastFocused.focus();
}

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || busy) return;
  if (!$('review-overlay').classList.contains('hidden')) closeOverlay($('review-overlay'));
  else if (!$('profile-modal').classList.contains('hidden')) closeProfile();
  else if (!$('confirm-overlay').classList.contains('hidden')) closeOverlay($('confirm-overlay'));
});

/* ── Profile modal ──────────────────────────────────────── */
$('profile-btn').addEventListener('click', () => {
  openOverlay($('profile-modal'));
  document.body.style.overflow = 'hidden';
  const last = localStorage.getItem('drev-last-request');
  if (last && !$('inp-track').value) $('inp-track').value = last;
});

function closeProfile() {
  $('profile-modal').classList.add('hidden');
  document.body.style.overflow = '';
  if (lastFocused?.focus) lastFocused.focus();
}
$('profile-close').addEventListener('click', closeProfile);
$('profile-backdrop').addEventListener('click', closeProfile);

/* ── Tracking (DOM built with textContent — no innerHTML) ── */
async function checkStatus() {
  const id = $('inp-track').value.trim();
  const result = $('track-result');
  const cancelBtn = $('btn-cancel-req');
  const liveBtn = $('btn-live-track');
  cancelBtn.classList.add('hidden');
  liveBtn.classList.add('hidden');
  trackedId = null;
  trackedRequest = null;

  const show = (text, cls) => {
    result.replaceChildren();
    result.textContent = text;
    result.className = 'track-result ' + cls;
    result.classList.remove('hidden');
  };

  if (!UUID_RE.test(id)) { show('Enter the full reference ID from your confirmation (it looks like a long code with dashes).', 'track-err'); return; }
  show('Checking…', 'track-loading');
  try {
    const res = await fetch(`/api/assist/status/${encodeURIComponent(id)}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) { show(res.status === 404 ? 'Request not found. Check the ID.' : 'Could not check status right now.', 'track-err'); return; }
    const r = (await res.json()).request;
    trackedId = r.id;
    result.replaceChildren();
    const svc = document.createElement('span');
    svc.className = 'track-svc';
    svc.textContent = SERVICE_LABELS[r.serviceType] || r.serviceType;
    const st = document.createElement('span');
    st.className = `track-status ts-${r.status}`;
    st.textContent = r.status.toUpperCase();
    const meta = document.createElement('span');
    meta.style.cssText = 'font-size:12px;color:var(--text-2)';
    meta.textContent = `Submitted ${new Date(r.requestedAt).toLocaleDateString()}`
      + (r.providerLabel ? ` · Provider: ${r.providerLabel}` : '')
      + (r.scheduledWindow ? ` · Window: ${r.scheduledWindow}` : '');
    result.append(svc, document.createTextNode(' — '), st, document.createElement('br'), meta);
    result.className = 'track-result track-ok';
    result.classList.remove('hidden');
    if (r.cancellable) cancelBtn.classList.remove('hidden');
    if (r.status === 'dispatched') { trackedRequest = r; liveBtn.classList.remove('hidden'); }
  } catch {
    show('Could not reach the server. Check your connection.', 'track-err');
  }
}
$('btn-track').addEventListener('click', checkStatus);
$('inp-track').addEventListener('keypress', e => { if (e.key === 'Enter') checkStatus(); });

$('btn-cancel-req').addEventListener('click', async () => {
  if (!trackedId || busy) return;
  if (!confirm('Cancel this request? A dispatcher will stop working on it.')) return;
  busy = true;
  try {
    const res = await fetch(`/api/assist/status/${encodeURIComponent(trackedId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'cancel' }),
    });
    if (!res.ok) throw new Error();
    await checkStatus();
  } catch {
    const result = $('track-result');
    result.textContent = 'Could not cancel right now — please call dispatch.';
    result.className = 'track-result track-err';
  }
  busy = false;
});


/* ── Live tracking: 3D follow-cam over the provider feed ──
   Position comes from the status API's providerFeed when present
   (currently a clearly-labelled simulation until a real GPS feed is
   connected); movement between polls is interpolated along a route so
   the provider glides instead of teleporting.                    */
$('btn-live-track').addEventListener('click', () => { if (trackedRequest) startLiveTracking(trackedRequest); });
$('th-exit').addEventListener('click', () => stopLiveTracking());

function startLiveTracking(req) {
  stopLiveTracking();
  if (!map || !window.DrevLive) { showBanner('Live map is unavailable on this device.', 'info'); return; }
  closeProfile();
  snapTo('peek');

  const target = { lng: pickupLng, lat: pickupLat };
  const feed = req.providerFeed || null;
  const start = feed?.position
    ? { lng: feed.position.lng, lat: feed.position.lat }
    : { lng: target.lng - 0.035, lat: target.lat + 0.025 };
  const route = DrevLive.routeBetween(start, target, 7);
  const fromProgress = feed?.progress || 0;

  tracking = {
    route, target, reqId: req.id,
    startedAt: Date.now(),
    durationMs: Math.max(15000, 90000 * (1 - fromProgress)),
    fromProgress, lastCam: 0, poll: null, raf: 0,
  };

  const routeFC = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: route.map(p => [p.lng, p.lat]) }, properties: {} }] };
  const pointFC = pos => ({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [pos.lng, pos.lat] }, properties: {} }] });
  try {
    if (!map.getSource('track-route')) {
      map.addSource('track-route', { type: 'geojson', data: routeFC });
      map.addLayer({ id: 'track-route', type: 'line', source: 'track-route', paint: { 'line-color': '#00c8ff', 'line-width': 4, 'line-opacity': 0.85 } });
    } else map.getSource('track-route').setData(routeFC);
    if (!map.getSource('track-dest')) {
      map.addSource('track-dest', { type: 'geojson', data: pointFC(target) });
      map.addLayer({ id: 'track-dest', type: 'circle', source: 'track-dest', paint: { 'circle-radius': 8, 'circle-color': '#00c8ff', 'circle-stroke-color': '#eaf7ff', 'circle-stroke-width': 2 } });
    } else map.getSource('track-dest').setData(pointFC(target));
    if (!map.getSource('track-provider')) {
      map.addSource('track-provider', { type: 'geojson', data: pointFC(start) });
      map.addLayer({ id: 'track-provider', type: 'circle', source: 'track-provider', paint: { 'circle-radius': 10, 'circle-color': '#ffd93d', 'circle-stroke-color': '#0a1420', 'circle-stroke-width': 2 } });
    } else map.getSource('track-provider').setData(pointFC(start));
  } catch (_) { /* layers are decorative if the style is mid-switch */ }

  $('th-badge').textContent = feed && feed.simulated === false ? 'LIVE FEED' : 'SIMULATED LIVE FEED';
  $('th-title').textContent = (req.providerLabel || feed?.label || 'Provider') + ' en route';
  $('tracking-hud').classList.remove('hidden');

  const step = () => {
    if (!tracking) return;
    const elapsed = Date.now() - tracking.startedAt;
    const progress = Math.min(1, tracking.fromProgress + (1 - tracking.fromProgress) * (elapsed / tracking.durationMs));
    const pos = DrevLive.pointAlongRoute(tracking.route, DrevLive.easeInOut(progress));
    try { map.getSource('track-provider')?.setData(pointFC(pos)); } catch (_) {}
    const remainingKm = tracking.route.totalKm * (1 - progress);
    $('th-bar').style.width = Math.round(progress * 100) + '%';
    $('th-meta').textContent = progress >= 1
      ? 'Provider has arrived at the pin. Meet them outside if it is safe.'
      : `${remainingKm.toFixed(1)} km away · heading ${Math.round(pos.bearing || 0)}° · position is ${feed?.simulated === false ? 'live' : 'simulated for demo'}`;
    if (progress >= 1) { $('th-title').textContent = 'Provider arrived'; return; }
    if (Date.now() - tracking.lastCam > 2000) {
      tracking.lastCam = Date.now();
      map.easeTo({ center: [pos.lng, pos.lat], zoom: 15, pitch: 60, bearing: pos.bearing || 0, duration: rm ? 0 : 1600 });
    }
    tracking.raf = requestAnimationFrame(step);
  };
  tracking.raf = requestAnimationFrame(step);

  /* Keep the journey honest: if dispatch changes the status, tracking ends. */
  tracking.poll = setInterval(async () => {
    try {
      const res = await fetch(`/api/assist/status/${encodeURIComponent(tracking.reqId)}`);
      if (!res.ok) return;
      const r = (await res.json()).request;
      if (r.status !== 'dispatched') {
        $('th-title').textContent = r.status === 'complete' ? 'Job complete — thank you' : `Status: ${r.status}`;
        $('th-meta').textContent = 'Tracking ended because the request status changed.';
        clearInterval(tracking.poll);
      }
    } catch (_) { /* a missed poll just means we keep interpolating */ }
  }, 10000);
}

function stopLiveTracking() {
  if (tracking) {
    cancelAnimationFrame(tracking.raf);
    if (tracking.poll) clearInterval(tracking.poll);
    tracking = null;
  }
  $('tracking-hud')?.classList.add('hidden');
  if (map) {
    for (const id of ['track-provider', 'track-dest', 'track-route']) {
      try { if (map.getLayer(id)) map.removeLayer(id); } catch (_) {}
      try { if (map.getSource(id)) map.removeSource(id); } catch (_) {}
    }
  }
}

/* ── Membership checkout (handlers bound here, no inline onclick) ── */
document.querySelectorAll('[data-plan]').forEach(btn => {
  btn.addEventListener('click', () => subscribePlan(btn.dataset.plan, btn));
});

async function subscribePlan(plan, btn) {
  const note = $('plan-note');
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = 'LOADING…';
  note.classList.add('hidden');
  try {
    const res = await fetch('/api/assist/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan }),
    });
    const data = await res.json().catch(() => ({}));
    if (data.checkoutUrl) { window.location.href = data.checkoutUrl; return; }
    note.textContent = data.error?.message || 'Could not start checkout.';
    note.classList.remove('hidden');
  } catch {
    note.textContent = 'Network error — please try again.';
    note.classList.remove('hidden');
  }
  btn.disabled = false;
  btn.textContent = 'SUBSCRIBE';
}

/* ── FABs ───────────────────────────────────────────────── */
$('locate-btn').addEventListener('click', () => {
  if (!navigator.geolocation) { map?.flyTo({ center: CENTER, zoom: 14, pitch: 58, bearing: -15, speed: 1.4 }); return; }
  navigator.geolocation.getCurrentPosition(
    pos => map?.flyTo({ center: [pos.coords.longitude, pos.coords.latitude], zoom: 16, pitch: 58, bearing: -15, speed: 1.4 }),
    () => map?.flyTo({ center: CENTER, zoom: 14, pitch: 58, bearing: -15, speed: 1.4 }),
    { enableHighAccuracy: true, timeout: 10000 },
  );
});

$('compass-btn').addEventListener('click', () => {
  map?.easeTo({ bearing: -15, pitch: 58, duration: rm ? 0 : 500 });
});

$('satellite-btn').addEventListener('click', () => {
  if (!map?.isStyleLoaded()) return;
  satellite = !satellite;
  $('satellite-btn').setAttribute('aria-pressed', String(satellite));
  try {
    if (!map.getSource('drev-sat')) {
      map.addSource('drev-sat', { type: 'raster', url: 'mapbox://mapbox.satellite', tileSize: 256 });
      const first = map.getStyle().layers.find(l => l.type !== 'background');
      map.addLayer({ id: 'drev-sat', type: 'raster', source: 'drev-sat', layout: { visibility: 'none' } }, first?.id);
    }
    map.setLayoutProperty('drev-sat', 'visibility', satellite ? 'visible' : 'none');
    map.getStyle().layers.forEach(l => {
      if (['fill', 'line', 'background'].includes(l.type)) {
        map.setLayoutProperty(l.id, 'visibility', satellite ? 'none' : 'visible');
      }
    });
    if (!satellite) map.setLayoutProperty('drev-sat', 'visibility', 'none');
  } catch (_) { /* satellite is decorative */ }
});

/* ── Validation + frozen review snapshot ────────────────── */
function fetchWithTimeout(url, opts = {}, ms = 12000) {
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
    return fetch(url, { ...opts, signal: AbortSignal.timeout(ms) });
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

function showFormError(message, focusEl) {
  const el = $('form-error');
  el.textContent = message;
  el.classList.remove('hidden');
  document.querySelectorAll('.form-input.invalid').forEach(i => i.classList.remove('invalid'));
  if (focusEl) { focusEl.classList.add('invalid'); focusEl.focus(); }
  snapTo('full');
}
function clearFormError() {
  $('form-error').classList.add('hidden');
  document.querySelectorAll('.form-input.invalid').forEach(i => i.classList.remove('invalid'));
}

function validateAndSnapshot() {
  clearFormError();
  const isHome = activeCategory === 'home';
  const name = $('inp-name').value.trim();
  const phone = $('inp-phone').value.trim();
  const email = $('inp-email').value.trim();
  const vehicle = $('inp-vehicle').value.trim();
  const notes = $('inp-notes').value.trim();

  if (!activeSvc) { showFormError('Choose a service first.'); return null; }
  if (!isHome && !name) { showFormError('Please enter your name so the dispatcher can reach you.', $('inp-name')); return null; }
  if (!isHome && !phone) { showFormError('Please enter a phone number for roadside dispatch.', $('inp-phone')); return null; }
  if (phone && phone.replace(/\D/g, '').length < 7) { showFormError('That phone number looks too short.', $('inp-phone')); return null; }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showFormError('That email address looks invalid.', $('inp-email')); return null; }
  if (isHome && !phone && !email) { showFormError('Add a phone number or email so we can follow up.', $('inp-phone')); return null; }
  if (!isHome && !vehicle) { showFormError('Please describe your vehicle.', $('inp-vehicle')); return null; }
  if (!$('chk-location').checked) {
    showFormError('Confirm the map pin is where help should come — drag the map to adjust it, then tick the confirmation box.');
    $('chk-location').focus();
    return null;
  }

  const homeMeta = isHome ? [
    'Property: ' + (document.querySelector('#pill-property .pill.active')?.dataset.val || 'house'),
    'Panel: ' + (document.querySelector('#pill-panel .pill.active')?.dataset.val || 'unknown'),
    'Existing: ' + (document.querySelector('#pill-existing .pill.active')?.dataset.val || 'none'),
  ].join(' | ') : '';

  return Object.freeze({
    idempotencyKey: crypto.randomUUID ? crypto.randomUUID() : localRef(),
    category: activeCategory,
    serviceType: activeSvc,
    locationLabel: pickupAddr,
    locationLatitude: pickupLat,
    locationLongitude: pickupLng,
    powertrain: isHome ? '' : activePowertrain,
    vehicle: isHome ? (document.querySelector('#pill-property .pill.active')?.dataset.val || '') : vehicle,
    notes: isHome ? (homeMeta + (notes ? ' — ' + notes : '')) : notes,
    customerName: name,
    customerPhone: phone,
    customerEmail: email,
    memberPlanRequested: $('chk-member').checked,
  });
}

function openReview(snapshot) {
  pendingSnapshot = snapshot;
  $('review-error').classList.add('hidden');
  const list = $('review-list');
  list.replaceChildren();
  const rows = [
    ['SERVICE', SERVICE_LABELS[snapshot.serviceType] || snapshot.serviceType],
    ['LOCATION', snapshot.locationLabel],
    ['NAME', snapshot.customerName || '—'],
    ['PHONE', snapshot.customerPhone || '—'],
    ...(snapshot.customerEmail ? [['EMAIL', snapshot.customerEmail]] : []),
    [snapshot.category === 'home' ? 'PROPERTY' : 'VEHICLE', snapshot.vehicle || '—'],
    ...(snapshot.notes ? [['SITUATION', snapshot.notes]] : []),
    ['MEMBERSHIP', snapshot.memberPlanRequested ? 'Include review' : 'No'],
  ];
  const [w, s, e, n] = NC_BBOX;
  if (snapshot.locationLongitude < w || snapshot.locationLongitude > e
      || snapshot.locationLatitude < s || snapshot.locationLatitude > n) {
    rows.push(['COVERAGE', 'Pin is outside North Carolina — a dispatcher will confirm coverage.']);
  }
  for (const [k, v] of rows) {
    const div = document.createElement('div');
    div.className = 'rv-row';
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    div.append(dt, dd);
    list.appendChild(div);
  }
  openOverlay($('review-overlay'));
}

$('sheet-cta').addEventListener('click', () => {
  if (busy) return;
  const snapshot = validateAndSnapshot();
  if (snapshot) openReview(snapshot);
});
$('review-back').addEventListener('click', () => { if (!busy) closeOverlay($('review-overlay')); });
$('review-send').addEventListener('click', () => { if (pendingSnapshot) sendRequest(pendingSnapshot); });

function localRef() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return 'LOCAL-' + [...bytes].map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

async function sendRequest(snapshot) {
  if (busy) return;
  busy = true;
  const sendBtn = $('review-send');
  const backBtn = $('review-back');
  sendBtn.disabled = true; backBtn.disabled = true;
  $('review-send-label').textContent = 'SENDING…';
  $('review-error').classList.add('hidden');

  const showReviewError = msg => {
    const el = $('review-error');
    el.textContent = msg;
    el.classList.remove('hidden');
  };

  try {
    const res = await fetchWithTimeout('/api/assist/requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': snapshot.idempotencyKey },
      body: JSON.stringify(snapshot),
    }, 12000);
    const data = await res.json().catch(() => ({}));

    if (res.ok && data.request?.id) {
      closeOverlay($('review-overlay'));
      try { localStorage.setItem('drev-last-request', data.request.id); } catch (_) {}
      try { sessionStorage.removeItem('drev-assist-pending'); } catch (_) {}
      showResult({
        sent: true,
        title: 'REQUEST SUBMITTED',
        body: 'Your review request has been received and stored. A dispatcher will evaluate it and contact you — this is not yet a confirmed job or ETA.',
        ref: data.request.id,
      });
      resetFormAfterSend();
      return;
    }

    if (res.status === 400 || res.status === 409) {
      showReviewError(data.error?.message || 'Please check the details and try again.');
      return;
    }
    if (res.status === 429) {
      showReviewError('Too many attempts — wait a few minutes, then send again. Your review is kept.');
      return;
    }
    // 503 / 5xx / anything else: the request was NOT stored. Say so plainly.
    closeOverlay($('review-overlay'));
    showNotSent(snapshot, data.error?.message);
  } catch {
    closeOverlay($('review-overlay'));
    showNotSent(snapshot);
  } finally {
    busy = false;
    sendBtn.disabled = false; backBtn.disabled = false;
    $('review-send-label').textContent = 'SEND REQUEST';
    const cta = $('sheet-cta');
    cta.disabled = false;
    $('cta-label').textContent = 'REVIEW REQUEST';
  }
}

function showNotSent(snapshot, serverMessage) {
  const ref = localRef();
  try {
    /* Minimal local summary only — no vehicle, notes, or contact details. */
    sessionStorage.setItem('drev-assist-pending', JSON.stringify({
      id: ref, at: new Date().toISOString(), category: snapshot.category, svc: snapshot.serviceType, sent: false,
    }));
  } catch (_) {}
  showResult({
    sent: false,
    title: 'REQUEST NOT SENT',
    body: (serverMessage
      ? `The service could not accept your request: ${serverMessage} `
      : 'We could not reach the service, so nothing was submitted. ')
      + 'Check your connection and try again. The reference below is local only — dispatch has not seen this.',
    ref,
  });
}

function showResult({ sent, title, body, ref }) {
  const ring = $('confirm-ring');
  ring.classList.toggle('not-sent', !sent);
  $('confirm-icon-use').setAttribute('href', sent ? '#ic-check' : '#ic-alert');
  $('confirm-title').textContent = title;
  $('confirm-body').textContent = body;
  $('confirm-id').textContent = (sent ? '' : 'NOT SENT · ') + ref;
  $('confirm-id').dataset.ref = ref;
  $('confirm-notice').textContent = sent
    ? 'Review request — not a confirmed job or guaranteed ETA. Save this reference to track or cancel.'
    : 'This is a local reference only. Nothing has been dispatched.';
  $('confirm-close-label').textContent = sent ? 'TRACK STATUS' : 'CLOSE';
  $('confirm-retry').classList.toggle('hidden', sent);
  pendingSnapshot = sent ? null : pendingSnapshot;
  openOverlay($('confirm-overlay'));
}

function resetFormAfterSend() {
  $('inp-notes').value = '';
  $('notes-count').textContent = '0';
  $('chk-member').checked = false;
  invalidateLocationConfirmation();
}

$('confirm-copy').addEventListener('click', async () => {
  const ref = $('confirm-id').dataset.ref;
  if (!ref) return;
  try {
    await navigator.clipboard.writeText(ref);
    $('confirm-copy').textContent = 'COPIED ✓';
    setTimeout(() => { $('confirm-copy').textContent = 'COPY REFERENCE'; }, 2000);
  } catch { /* clipboard unavailable — the ref stays visible to copy manually */ }
});

$('confirm-retry').addEventListener('click', () => {
  closeOverlay($('confirm-overlay'));
  if (pendingSnapshot) openReview(pendingSnapshot);
});

$('confirm-close').addEventListener('click', () => {
  const wasSent = !$('confirm-ring').classList.contains('not-sent');
  closeOverlay($('confirm-overlay'));
  snapTo('mid');
  if (wasSent) {
    const ref = $('confirm-id').dataset.ref;
    openOverlay($('profile-modal'));
    document.body.style.overflow = 'hidden';
    if (ref) { $('inp-track').value = ref; checkStatus(); }
  }
});

/* ── Checkout return handler ────────────────────────────── */
function checkCheckoutReturn() {
  const p = new URLSearchParams(location.search);
  const status = p.get('assist_checkout');
  if (!status) return;
  history.replaceState({}, '', location.pathname);
  if (status === 'success') {
    const plan = (p.get('plan') || 'membership').toUpperCase().replace(/[^A-Z -]/g, '');
    showBanner(`Your DREV Assist ${plan} membership is active. Welcome!`, 'success');
    openOverlay($('profile-modal'));
    document.body.style.overflow = 'hidden';
  }
}

function showBanner(msg, type = 'info') {
  let b = $('assist-banner');
  if (!b) {
    b = document.createElement('div');
    b.id = 'assist-banner';
    b.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:9999;padding:10px 20px;border-radius:8px;font-size:13px;font-weight:600;letter-spacing:.05em;pointer-events:none;transition:opacity .4s';
    document.body.appendChild(b);
  }
  b.textContent = msg;
  b.style.background = type === 'success' ? '#0af0a0' : '#1ad4ff';
  b.style.color = '#03080f';
  b.style.opacity = '1';
  clearTimeout(b._t);
  b._t = setTimeout(() => { b.style.opacity = '0'; }, 5000);
}

/* ── Boot ───────────────────────────────────────────────── */
async function refreshCatalogue() {
  try {
    const res = await fetch('/api/assist/services');
    if (!res.ok) return;
    const data = await res.json();
    for (const s of data.services || []) {
      if (s.guidance) SERVICE_GUIDANCE[s.id] = s.guidance;
      if (s.label) SERVICE_LABELS[s.id] = s.label;
    }
    if (activeSvc) $('svc-guidance').textContent = SERVICE_GUIDANCE[activeSvc] || '';
  } catch { /* offline fallback copy above still applies */ }
}

window.addEventListener('load', async () => {
  if (!TOKEN) {
    try {
      const cfg = await fetch('/api/assist/config').then(r => r.json());
      TOKEN = cfg.token || '';
    } catch (_) {}
  }
  initMap();
  initGeocoder();
  positionPin();
  snapTo('mid', false);
  /* Initial service guidance + pressed states */
  const active = document.querySelector('.svc-card.active');
  if (active) selectCard(active);
  const last = (() => { try { return localStorage.getItem('drev-last-request'); } catch { return null; } })();
  if (last) $('inp-track').value = last;
  checkCheckoutReturn();
  refreshCatalogue();
});
