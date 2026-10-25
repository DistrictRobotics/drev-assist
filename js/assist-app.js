/* =========================================================
   DREV Assist — Production app JS
   Real Mapbox GL JS · Charlotte NC · Sheet physics
   ========================================================= */
'use strict';

let TOKEN = document.querySelector('meta[name="mapbox-token"]')?.content || '';
const CENTER = [-80.843, 35.227];
const NC_BBOX = [-84.3, 33.8, -75.4, 36.6];

const $ = id => document.getElementById(id);
const rm = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ── State ──────────────────────────────────────────────── */
let map, geocoder;
let pickupLng = CENTER[0], pickupLat = CENTER[1], pickupAddr = 'Charlotte, NC';
let activeCategory = 'roadside', activeSvc = 'mobile-ev-charge';
let reverseSeq = 0, reverseCtrl = null;
let satellite = false;
let busy = false;

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
          'fill-extrusion-base':   ['coalesce', ['get', 'min_height'], 0],
          'fill-extrusion-opacity': 0.88,
        },
      }, labelLayer?.id);
    } catch (_) {}

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
    reverseGeocode(c.lng, c.lat);
  });
}

/* ── Geocoder ───────────────────────────────────────────── */
function initGeocoder() {
  if (!window.MapboxGeocoder) return;
  geocoder = new MapboxGeocoder({
    accessToken: TOKEN,
    mapboxgl: mapboxgl,
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
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json?access_token=${TOKEN}&country=us&limit=1`;
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
  const canvas = map.getCanvas();
  const r = canvas.getBoundingClientRect();
  const pin = $('pickup-pin');
  pin.style.left = (r.left + r.width  / 2) + 'px';
  pin.style.top  = (r.top  + r.height / 2) + 'px';
}
window.addEventListener('resize', positionPin);

/* ── Bottom sheet physics ───────────────────────────────── */
const sheet     = $('sheet');
const handleRow = $('sheet-handle-row');

const SNAP_PEEK = 72;
const SNAP_MID  = () => Math.min(360, window.innerHeight * 0.55);
const SNAP_FULL = () => window.innerHeight * 0.92;

let currentSnap  = 'mid';
let dragging     = false;
let dragStartY   = 0, dragStartH = 0;
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

  /* Lock map when full */
  if (map) {
    const lock = name === 'full';
    map.scrollZoom[lock ? 'disable' : 'enable']();
    map.dragPan[lock ? 'disable' : 'enable']();
    map.touchZoomRotate[lock ? 'disable' : 'enable']();
  }

  /* Show/hide geocoder */
  $('geocoder-wrap').classList.toggle('visible', name !== 'peek');

  /* Shift FABs above sheet */
  const fabBottom = h + 24;
  $('map-fabs').style.bottom = fabBottom + 'px';
}

handleRow.addEventListener('click', () => {
  if (dragging) return;
  if (currentSnap === 'peek') snapTo('mid');
  else if (currentSnap === 'mid') snapTo('full');
  else snapTo('mid');
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
  const h  = Math.max(SNAP_PEEK, Math.min(SNAP_FULL(), dragStartH + dy));
  sheet.style.height = h + 'px';
  sheet.classList.remove('animate');
  sheet.dataset.snap  = '';

  const now = Date.now();
  if (now > lastT) velY = (lastY - e.clientY) / (now - lastT) * 100;
  lastY = e.clientY; lastT = now;
}, { passive: true });

handleRow.addEventListener('pointerup', () => {
  if (!dragging) return;
  dragging = false;
  const h    = sheet.getBoundingClientRect().height;
  const mid  = SNAP_MID();
  const full = SNAP_FULL();
  let target = 'mid';
  if      (velY > 22 || h > mid + (full - mid) * 0.55) target = 'full';
  else if (velY < -22 || h < mid * 0.45)               target = 'peek';
  snapTo(target);
});

handleRow.addEventListener('pointercancel', () => {
  dragging = false;
  snapTo(currentSnap);
});

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
  $('mode-toggle').textContent = activeCategory === 'roadside' ? 'ROADSIDE' : 'HOME ENERGY';

  /* Select first card in new category */
  const first = document.querySelector(`.svc-card[data-cat="${activeCategory}"]`);
  if (first) selectCard(first);
});

$('mode-toggle').addEventListener('click', () => {
  const next = activeCategory === 'roadside' ? 'home' : 'roadside';
  document.querySelector(`.cat-btn[data-cat="${next}"]`)?.click();
});

/* ── Service selection ──────────────────────────────────── */
document.querySelectorAll('.svc-grid').forEach(grid => {
  grid.addEventListener('click', e => {
    const card = e.target.closest('.svc-card');
    if (!card) return;
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
}

/* ── Pill group (powertrain) ────────────────────────────── */
$('pill-powertrain').addEventListener('click', e => {
  const btn = e.target.closest('.pill');
  if (!btn) return;
  document.querySelectorAll('#pill-powertrain .pill').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
});

/* ── FABs ───────────────────────────────────────────────── */
$('locate-btn').addEventListener('click', () => {
  if (!navigator.geolocation) { map?.flyTo({ center: CENTER, zoom: 14, pitch: 58, bearing: -15, speed: 1.4 }); return; }
  navigator.geolocation.getCurrentPosition(
    pos => map?.flyTo({ center: [pos.coords.longitude, pos.coords.latitude], zoom: 16, pitch: 58, bearing: -15, speed: 1.4 }),
    ()  => map?.flyTo({ center: CENTER, zoom: 14, pitch: 58, bearing: -15, speed: 1.4 }),
    { enableHighAccuracy: true, timeout: 10000 }
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
  } catch (_) {}
});

/* ── Submit ─────────────────────────────────────────────── */
$('sheet-cta').addEventListener('click', submitRequest);

async function submitRequest() {
  if (busy) return;
  if (!activeSvc) return;

  busy = true;
  const cta   = $('sheet-cta');
  const label = $('cta-label');
  cta.disabled = true;
  label.textContent = 'SUBMITTING…';

  const payload = {
    category:          activeCategory,
    serviceType:       activeSvc,
    locationLabel:     pickupAddr,
    locationLatitude:  pickupLat,
    locationLongitude: pickupLng,
    powertrain:        document.querySelector('#pill-powertrain .pill.active')?.dataset.val || '',
    vehicle:           $('inp-vehicle').value.trim(),
    notes:             $('inp-notes').value.trim(),
    memberPlanRequested: $('chk-member').checked,
  };

  let refId = null;

  try {
    const res = await fetch('/api/assist/requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(12000),
    });

    if (res.ok) {
      const data = await res.json();
      refId = data.request?.id || data.requestId || data.id;
    } else if (res.status === 503) {
      refId = localRef();
    } else {
      throw new Error(`HTTP ${res.status}`);
    }
  } catch (err) {
    refId = localRef();
    try {
      sessionStorage.setItem('drev-assist-pending', JSON.stringify({
        id: refId, at: new Date().toISOString(), category: payload.category, svc: payload.serviceType,
      }));
    } catch (_) {}
  }

  showConfirmation(refId || localRef());
}

function localRef() {
  return 'REQ-' + Math.random().toString(36).slice(2, 10).toUpperCase();
}

function showConfirmation(id) {
  $('confirm-id').textContent = id;
  $('confirm-overlay').classList.remove('hidden');
  busy = false;
}

$('confirm-close').addEventListener('click', () => {
  $('confirm-overlay').classList.add('hidden');
  snapTo('mid');
  const cta = $('sheet-cta');
  cta.disabled = false;
  $('cta-label').textContent = 'REQUEST REVIEW';
});

/* ── Boot ───────────────────────────────────────────────── */
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
});
