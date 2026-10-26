/* DREV Assist — Manager dashboard.
 *
 * Security notes:
 *  - Every value that came from a customer submission is rendered with
 *    textContent or through escapeHtml() — never raw into innerHTML.
 *    (The previous version interpolated customer fields directly, which
 *    was a stored-XSS hole into the admin's browser.)
 *  - The admin key lives only in memory; it is never persisted to
 *    browser storage of any kind.
 */
'use strict';

const API = '/api/assist/admin';
let adminKey = '';
let allRequests = [];
let activeFilter = 'all';
let searchTerm = '';
let expandedId = null;
let autoTimer = null;
let dmap = null, mapReady = false, sim = null, liveTimer = null, replayTimer = null;
let mapMode = 'live', replayMinute = 720, tickCount = 0;

const svcNames = {
  'mobile-ev-charge': 'Mobile EV Charge',
  'fuel-delivery': 'Fuel Delivery',
  'jump-start': 'Jump Start',
  'flat-tire': 'Flat Tire',
  'lockout': 'Lockout',
  'tow-coordination': 'Tow Coordination',
  'collision-incident': 'Collision Incident',
  'other-roadside': 'Other Roadside',
  'v2h-planning': 'V2H Planning',
  'home-charger-install': 'Charger Install',
  'home-charger-repair': 'Charger Repair',
  'panel-battery-review': 'Panel Review',
  'outage-readiness': 'Outage Readiness',
  'other-home': 'Other Home',
};

const nextMap = {
  submitted: ['reviewed', 'cancelled'],
  reviewed: ['dispatched', 'cancelled'],
  dispatched: ['complete', 'cancelled'],
  complete: [],
  cancelled: [],
};

const $ = id => document.getElementById(id);

function escapeHtml(v) {
  return String(v ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
/* tel: hrefs only ever get digits and a leading +. */
function telHref(phone) { return 'tel:' + String(phone).replace(/[^\d+]/g, ''); }

function relTime(iso) {
  const d = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(d)) return '';
  const m = Math.floor(d / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

function toast(msg, isError = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (isError ? ' error' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

function renderCard(r) {
  const nexts = (nextMap[r.status] || []).map(s => {
    const cls = s === 'dispatched' ? 'a-dispatch' : s === 'complete' ? 'a-complete' : s === 'cancelled' ? 'a-cancel' : '';
    return `<button class="act-btn ${cls}" data-id="${escapeHtml(r.id)}" data-status="${s}">${s.toUpperCase()}</button>`;
  }).join('');

  const cust = [];
  if (r.customer_name) cust.push(`<span class="req-cust-item"><strong>${escapeHtml(r.customer_name)}</strong></span>`);
  if (r.customer_phone) cust.push(`<span class="req-cust-item"><a href="${escapeHtml(telHref(r.customer_phone))}">${escapeHtml(r.customer_phone)}</a></span>`);
  if (r.customer_email) cust.push(`<span class="req-cust-item">${escapeHtml(r.customer_email)}</span>`);
  if (r.vehicle) cust.push(`<span class="req-cust-item">${escapeHtml(r.vehicle)}</span>`);

  const expanded = expandedId === r.id;
  const mapsUrl = Number.isFinite(r.location_lat) && Number.isFinite(r.location_lng)
    ? `https://www.google.com/maps?q=${encodeURIComponent(r.location_lat + ',' + r.location_lng)}`
    : null;
  const detail = expanded ? `<div class="req-detail">
      <div class="d-row"><strong>Full ID:</strong> ${escapeHtml(r.id)}</div>
      ${r.intake_notes ? `<div class="d-row"><strong>Notes:</strong> ${escapeHtml(r.intake_notes)}</div>` : ''}
      ${mapsUrl ? `<div class="d-row"><strong>Pin:</strong> <a href="${mapsUrl}" target="_blank" rel="noopener">Open in Maps (${escapeHtml(r.location_lat)}, ${escapeHtml(r.location_lng)})</a></div>` : ''}
      ${r.member_plan_requested ? '<div class="d-row"><strong>Membership review requested</strong></div>' : ''}
      ${r.provider_label ? `<div class="d-row"><strong>Provider:</strong> ${escapeHtml(r.provider_label)}</div>` : ''}
      ${r.scheduled_window ? `<div class="d-row"><strong>Window:</strong> ${escapeHtml(r.scheduled_window)}</div>` : ''}
      <div class="detail-edit">
        <input id="prov-${escapeHtml(r.id)}" placeholder="Provider label" maxlength="120" value="${escapeHtml(r.provider_label || '')}"/>
        <input id="win-${escapeHtml(r.id)}" placeholder="Scheduled window (e.g. Today 3–5pm)" maxlength="120" value="${escapeHtml(r.scheduled_window || '')}"/>
        <button class="act-btn" data-save="${escapeHtml(r.id)}">SAVE DETAILS</button>
      </div>
    </div>` : '';

  return `<div class="req-card" id="rc-${escapeHtml(r.id)}" data-status="${escapeHtml(r.status)}" data-expand="${escapeHtml(r.id)}" title="Click to expand">
    <div class="req-left">
      <div class="req-top">
        <span class="req-id" title="${escapeHtml(r.id)}">${escapeHtml(String(r.id).slice(0, 8))}…</span>
        <span class="req-time">${escapeHtml(relTime(r.requested_at))}</span>
        <span class="cat-chip c-${escapeHtml(r.category)}">${escapeHtml(String(r.category || '').toUpperCase())}</span>
        ${r.powertrain ? `<span class="cat-chip c-roadside" style="color:var(--text-2)">${r.powertrain === 'ev' ? 'EV' : 'GAS'}</span>` : ''}
      </div>
      <div class="req-svc">${escapeHtml(svcNames[r.service_type] || r.service_type)}</div>
      ${r.location_label ? `<div class="req-loc">${escapeHtml(r.location_label)}</div>` : ''}
      ${cust.length ? `<div class="req-cust">${cust.join('')}</div>` : ''}
      ${r.intake_notes ? `<div class="req-notes">&ldquo;${escapeHtml(String(r.intake_notes).slice(0, 140))}${String(r.intake_notes).length > 140 ? '…' : ''}&rdquo;</div>` : ''}
    </div>
    <div class="req-right">
      <div class="status-badge s-${escapeHtml(r.status)}">${escapeHtml(String(r.status || '').toUpperCase())}</div>
      ${nexts ? `<div class="req-actions">${nexts}</div>` : ''}
    </div>
    ${detail}
  </div>`;
}

function updateCounts(reqs) {
  const c = { all: reqs.length, submitted: 0, reviewed: 0, dispatched: 0, complete: 0, cancelled: 0 };
  reqs.forEach(r => { if (c[r.status] !== undefined) c[r.status]++; });
  ['all', 'submitted', 'reviewed', 'dispatched', 'complete', 'cancelled'].forEach(k => {
    const el = $('c-' + k);
    if (el) el.textContent = c[k];
  });
}

function visibleRequests() {
  let list = activeFilter === 'all' ? allRequests : allRequests.filter(r => r.status === activeFilter);
  if (searchTerm) {
    const q = searchTerm.toLowerCase();
    list = list.filter(r => [r.id, r.customer_name, r.customer_phone, r.customer_email, r.location_label, r.vehicle, r.service_type]
      .some(v => String(v || '').toLowerCase().includes(q)));
  }
  return list;
}

function applyFilter(f) {
  activeFilter = f;
  document.querySelectorAll('.filter-row').forEach(r => r.classList.toggle('active', r.dataset.f === f));
  const filtered = visibleRequests();
  $('main-title').textContent = (f === 'all' ? 'ALL' : f.toUpperCase()) + ' REQUESTS (' + filtered.length + ')';
  const list = $('req-list');
  if (!filtered.length) {
    list.innerHTML = '<div class="empty-state"><div class="e-icon">○</div><div class="e-text">NO REQUESTS</div></div>';
    return;
  }
  list.innerHTML = filtered.map(renderCard).join('');
  refreshMapRequests();
}

async function adminFetch(params = '') {
  const res = await fetch(API + params, { headers: { Authorization: 'Bearer ' + adminKey } });
  if (res.status === 401) { logout(); throw new Error('Session expired — sign in again.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || ('Server error ' + res.status));
  return data;
}

async function loadRequests() {
  $('req-list').innerHTML = '<div class="spinner"></div>';
  try {
    const data = await adminFetch('?limit=200');
    allRequests = data.requests || [];
    updateCounts(allRequests);
    applyFilter(activeFilter);
  } catch (e) {
    const list = $('req-list');
    list.replaceChildren();
    const div = document.createElement('div');
    div.className = 'empty-state';
    const t = document.createElement('div');
    t.className = 'e-text';
    t.textContent = 'LOAD FAILED — ' + e.message;
    div.appendChild(t);
    list.appendChild(div);
  }
}

async function patchRequest(payload, okMsg) {
  const res = await fetch(API, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + adminKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { logout(); throw new Error('Session expired'); }
  if (!res.ok) throw new Error(data.error?.message || 'Server error');
  const idx = allRequests.findIndex(r => r.id === payload.id);
  if (idx >= 0 && data.request) allRequests[idx] = data.request;
  else if (idx >= 0 && payload.status) allRequests[idx].status = payload.status;
  updateCounts(allRequests);
  applyFilter(activeFilter);
  toast(okMsg);
}

async function updateStatus(id, status, btn) {
  if (status === 'cancelled' && !confirm('Cancel this request? The customer will see it as cancelled.')) return;
  btn.disabled = true;
  try {
    await patchRequest({ id, status }, 'UPDATED → ' + status.toUpperCase());
  } catch (e) {
    toast('ERROR: ' + e.message, true);
  }
}

function logout() {
  adminKey = '';
  allRequests = [];
  expandedId = null;
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
  if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
  stopReplay();
  $('auto-refresh').checked = false;
  $('dash').classList.add('hidden');
  $('login-wrap').classList.remove('hidden');
  $('key-input').value = '';
  $('login-err').textContent = '';
}


/* ── 3D dispatch map + 4D replay ─────────────────────────
   Providers are a simulated feed (labelled as such) until a real GPS
   source is connected; request pins are the real queue from D1.
   Replay shows demand over 24h — real request times when there are
   enough of them, seeded demo data otherwise (also labelled).   */
function setLiveMeta(text) { const el = $('live-meta'); if (el) el.textContent = text; }

async function initDispatchMap() {
  if (dmap) { dmap.resize(); return; }
  const fallback = $('map-fallback');
  if (!window.mapboxgl || !window.DrevLive) {
    if (fallback) fallback.textContent = 'MAP LIBRARY UNAVAILABLE — QUEUE BELOW STILL WORKS';
    return;
  }
  let token = '';
  try { token = (await (await fetch('/api/assist/config')).json()).token || ''; } catch (_) {}
  if (!token) {
    if (fallback) fallback.textContent = 'SET MAPBOX_TOKEN TO ENABLE THE DISPATCH MAP — QUEUE BELOW STILL WORKS';
    setLiveMeta('map token not configured');
    return;
  }
  mapboxgl.accessToken = token;
  sim = DrevLive.createSimulation(11);
  dmap = new mapboxgl.Map({
    container: 'dispatch-map', style: 'mapbox://styles/mapbox/navigation-night-v1',
    center: [-80.843, 35.227], zoom: 10.5, pitch: 55, bearing: -15, antialias: true, attributionControl: false,
  });
  dmap.addControl(new mapboxgl.AttributionControl({ compact: true }), 'bottom-right');

  dmap.on('load', () => {
    mapReady = true;
    fallback?.remove();
    try {
      dmap.setFog({ color: 'rgb(8,18,32)', 'high-color': 'rgb(3,8,15)', 'space-color': 'rgb(3,8,15)', 'star-intensity': 0.8 });
      dmap.addSource('mapbox-dem', { type: 'raster-dem', url: 'mapbox://mapbox.mapbox-terrain-dem-v1', tileSize: 512, maxzoom: 14 });
      dmap.setTerrain({ source: 'mapbox-dem', exaggeration: 1.25 });
      dmap.addLayer({ id: 'sky', type: 'sky', paint: { 'sky-type': 'atmosphere', 'sky-atmosphere-sun': [0, 90], 'sky-atmosphere-sun-intensity': 12 } });
    } catch (_) { /* terrain/sky decorative */ }

    const empty = { type: 'FeatureCollection', features: [] };
    for (const id of ['outages', 'demand', 'routes', 'requests', 'providers']) {
      dmap.addSource(id, { type: 'geojson', data: id === 'outages' ? DrevLive.outagesGeoJSON() : empty });
    }

    const firstLabel = dmap.getStyle().layers.find(l => l.type === 'symbol')?.id;
    try {
      dmap.addLayer({
        id: 'bldg-3d', source: 'composite', 'source-layer': 'building',
        filter: ['==', 'extrude', 'true'], type: 'fill-extrusion', minzoom: 12,
        paint: {
          'fill-extrusion-color': '#0d2138', 'fill-extrusion-opacity': 0.85,
          'fill-extrusion-height': ['coalesce', ['get', 'height'], 0],
          'fill-extrusion-base': ['coalesce', ['get', 'min_height'], 0],
        },
      }, firstLabel);
    } catch (_) {}

    dmap.addLayer({ id: 'outages-3d', type: 'fill-extrusion', source: 'outages', layout: { visibility: 'none' },
      paint: { 'fill-extrusion-color': '#ff6b2b', 'fill-extrusion-opacity': 0.4, 'fill-extrusion-height': ['get', 'height'], 'fill-extrusion-base': 0 } }, firstLabel);
    dmap.addLayer({ id: 'demand-heat', type: 'heatmap', source: 'demand',
      paint: { 'heatmap-radius': 34, 'heatmap-opacity': 0.75, 'heatmap-intensity': 1.1,
        'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(0,60,120,0)', 0.3, '#0077ff', 0.55, '#00c8ff', 0.75, '#ffd93d', 1, '#ff6b2b'] } }, firstLabel);
    dmap.addLayer({ id: 'routes-line', type: 'line', source: 'routes',
      paint: { 'line-color': '#00e5a0', 'line-width': 3, 'line-opacity': 0.65, 'line-dasharray': [2, 2] } });
    const statusColor = ['match', ['get', 'status'], 'submitted', '#ff9f43', 'reviewed', '#00c8ff', 'dispatched', '#ffd93d', '#5a8ea8'];
    dmap.addLayer({ id: 'requests-halo', type: 'circle', source: 'requests',
      paint: { 'circle-radius': 15, 'circle-color': statusColor, 'circle-opacity': 0.22 } });
    dmap.addLayer({ id: 'requests-dot', type: 'circle', source: 'requests',
      paint: { 'circle-radius': 7, 'circle-color': statusColor, 'circle-stroke-color': '#eaf7ff', 'circle-stroke-width': 1.5 } });
    dmap.addLayer({ id: 'providers-dot', type: 'circle', source: 'providers',
      paint: { 'circle-radius': 9, 'circle-color': '#00e5a0', 'circle-stroke-color': '#04241a', 'circle-stroke-width': 2 } });
    dmap.addLayer({ id: 'providers-label', type: 'symbol', source: 'providers',
      layout: { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 1.6], 'text-anchor': 'top', 'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'] },
      paint: { 'text-color': '#b9f4dd', 'text-halo-color': '#03080f', 'text-halo-width': 1 } });

    refreshMapRequests();
    updateDemandSource();
    setLiveMeta('live · simulated provider feed');

    if (liveTimer) clearInterval(liveTimer);
    liveTimer = setInterval(() => {
      if (!mapReady || !sim) return;
      sim.tick(1);
      tickCount++;
      try {
        dmap.getSource('providers')?.setData(DrevLive.providersGeoJSON(sim));
        dmap.getSource('routes')?.setData(DrevLive.routesGeoJSON(sim));
      } catch (_) {}
      const moving = sim.providers.filter(p => p.status === 'en_route').length;
      if (mapMode === 'live' && tickCount % 5 === 0) {
        setLiveMeta(`live · ${allRequests.filter(r => !['complete', 'cancelled'].includes(r.status)).length} open · ${moving} units moving · simulated feed`);
      }
      if (tickCount % 15 === 0) pollLive();
    }, 1000);

    const popupFor = (title, lines) => {
      const div = document.createElement('div');
      const t = document.createElement('div'); t.className = 'popup-title'; t.textContent = title;
      div.appendChild(t);
      for (const line of lines) { const d = document.createElement('div'); d.textContent = line; div.appendChild(d); }
      return div;
    };
    dmap.on('click', 'providers-dot', e => {
      const f = e.features?.[0]; if (!f) return;
      new mapboxgl.Popup().setLngLat(f.geometry.coordinates)
        .setDOMContent(popupFor(f.properties.label, [`Status: ${f.properties.status}`, `Heading to: ${f.properties.destination}`, 'Simulated feed — connect GPS for real units']))
        .addTo(dmap);
    });
    dmap.on('click', 'requests-dot', e => {
      const f = e.features?.[0]; if (!f) return;
      new mapboxgl.Popup().setLngLat(f.geometry.coordinates)
        .setDOMContent(popupFor(svcNames[f.properties.service] || f.properties.service, [`Status: ${f.properties.status}`, f.properties.label || 'Map-selected location', `ID: ${f.properties.id}`]))
        .addTo(dmap);
    });
    for (const layer of ['providers-dot', 'requests-dot']) {
      dmap.on('mouseenter', layer, () => { dmap.getCanvas().style.cursor = 'pointer'; });
      dmap.on('mouseleave', layer, () => { dmap.getCanvas().style.cursor = ''; });
    }
  });
}

function refreshMapRequests() {
  if (!mapReady || !dmap || !window.DrevLive) return;
  try { dmap.getSource('requests')?.setData(DrevLive.requestsGeoJSON(allRequests)); } catch (_) {}
  if (mapMode === 'live') updateDemandSource();
}

function demandEventsForReplay() {
  const real = allRequests
    .filter(r => Number.isFinite(r.location_lat) && Number.isFinite(r.location_lng) && r.requested_at)
    .map(r => {
      const d = new Date(r.requested_at);
      return { lng: r.location_lng, lat: r.location_lat, minute: d.getHours() * 60 + d.getMinutes(), service: r.service_type, area: '' };
    });
  return real.length >= 5 ? { events: real, simulated: false } : { events: DrevLive.generateDemand(7), simulated: true };
}

function updateDemandSource() {
  if (!mapReady || !dmap || !window.DrevLive) return;
  try {
    if (mapMode === 'live') {
      dmap.getSource('demand')?.setData(DrevLive.requestsGeoJSON(allRequests.filter(r => !['complete', 'cancelled'].includes(r.status))));
      $('clock-read').textContent = 'LIVE';
    } else {
      const { events, simulated } = demandEventsForReplay();
      const frame = DrevLive.demandFrame(events, replayMinute, 90);
      dmap.getSource('demand')?.setData(DrevLive.demandGeoJSON(frame));
      $('clock-read').textContent = DrevLive.fmtClock(replayMinute);
      setLiveMeta(`replay · ${frame.length} requests in window · ${simulated ? 'simulated demand (not enough real history yet)' : 'real request history'}`);
    }
  } catch (_) {}
}

async function pollLive() {
  if (!adminKey) return;
  try {
    const res = await fetch('/api/assist/live', { headers: { Authorization: 'Bearer ' + adminKey } });
    if (!res.ok) return;
    const data = await res.json();
    if (mapMode === 'live') setLiveMeta(`live · ${data.openTotal} open (${data.providers?.filter(p => p.status === 'en_route').length || 0} units moving) · simulated feed`);
  } catch (_) { /* map keeps animating locally */ }
}

function setMapMode(mode) {
  mapMode = mode;
  $('mode-live').classList.toggle('active', mode === 'live');
  $('mode-replay').classList.toggle('active', mode === 'replay');
  if (mode === 'live') stopReplay();
  updateDemandSource();
}

function stopReplay() {
  if (replayTimer) { clearInterval(replayTimer); replayTimer = null; }
  $('btn-play').textContent = '▶';
}

$('mode-live').addEventListener('click', () => setMapMode('live'));
$('mode-replay').addEventListener('click', () => setMapMode('replay'));
$('time-slider').addEventListener('input', e => {
  replayMinute = Number(e.target.value);
  if (mapMode !== 'replay') setMapMode('replay');
  updateDemandSource();
});
$('btn-play').addEventListener('click', () => {
  if (replayTimer) { stopReplay(); return; }
  if (mapMode !== 'replay') setMapMode('replay');
  $('btn-play').textContent = '⏸';
  replayTimer = setInterval(() => {
    replayMinute = (replayMinute + 10) % 1440;
    $('time-slider').value = replayMinute;
    updateDemandSource();
  }, 120);
});
$('btn-fly').addEventListener('click', () => {
  if (!dmap) return;
  dmap.flyTo({ center: [-80.843, 35.227], zoom: 13.5, pitch: 65, bearing: 35, duration: 3200, essential: true });
  setTimeout(() => dmap?.easeTo({ bearing: 95, duration: 6000 }), 3400);
});

const LAYER_MAP = { 'lyr-providers': ['providers-dot', 'providers-label', 'routes-line'], 'lyr-demand': ['demand-heat'], 'lyr-outages': ['outages-3d'] };
for (const [toggleId, layers] of Object.entries(LAYER_MAP)) {
  $(toggleId).addEventListener('change', e => {
    if (!mapReady || !dmap) return;
    for (const layer of layers) { try { dmap.setLayoutProperty(layer, 'visibility', e.target.checked ? 'visible' : 'none'); } catch (_) {} }
  });
}
$('lyr-3d').addEventListener('change', e => {
  if (!mapReady || !dmap) return;
  try {
    dmap.setLayoutProperty('bldg-3d', 'visibility', e.target.checked ? 'visible' : 'none');
    dmap.setTerrain(e.target.checked ? { source: 'mapbox-dem', exaggeration: 1.25 } : null);
  } catch (_) {}
});

/* ── Login flow ─────────────────────────────────────── */
async function doLogin() {
  const key = $('key-input').value.trim();
  if (!key) return;
  const btn = $('login-btn');
  btn.disabled = true;
  btn.textContent = 'CHECKING…';
  try {
    adminKey = key;
    const data = await adminFetch('?limit=200');
    allRequests = data.requests || [];
    $('login-wrap').classList.add('hidden');
    $('dash').classList.remove('hidden');
    updateCounts(allRequests);
    applyFilter('all');
    initDispatchMap();
  } catch (e) {
    adminKey = '';
    $('login-err').textContent = e.message.includes('expired') || e.message.includes('Unauthorized')
      ? 'Invalid access key.' : e.message;
  }
  btn.disabled = false;
  btn.textContent = 'ACCESS DASHBOARD';
}

$('login-btn').addEventListener('click', doLogin);
$('key-input').addEventListener('keypress', e => { if (e.key === 'Enter') doLogin(); });

/* ── Filters / search / auto-refresh ──────────────────── */
$('sb-filters').addEventListener('click', e => {
  const row = e.target.closest('.filter-row');
  if (row) applyFilter(row.dataset.f);
});

let searchDebounce;
$('search-input').addEventListener('input', e => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => { searchTerm = e.target.value.trim(); applyFilter(activeFilter); }, 150);
});

$('auto-refresh').addEventListener('change', e => {
  if (autoTimer) clearInterval(autoTimer);
  autoTimer = e.target.checked ? setInterval(() => { if (adminKey) loadRequests(); }, 30000) : null;
});

/* ── Card actions: expand, status, save details (delegated) ── */
$('req-list').addEventListener('click', async e => {
  const saveBtn = e.target.closest('[data-save]');
  if (saveBtn) {
    const id = saveBtn.dataset.save;
    try {
      await patchRequest({
        id,
        providerLabel: $('prov-' + id)?.value.trim() || undefined,
        scheduledWindow: $('win-' + id)?.value.trim() || undefined,
      }, 'DETAILS SAVED');
    } catch (err) { toast('ERROR: ' + err.message, true); }
    return;
  }
  const btn = e.target.closest('.act-btn');
  if (btn) { updateStatus(btn.dataset.id, btn.dataset.status, btn); return; }
  if (e.target.closest('a, input, .req-detail')) return;
  const card = e.target.closest('[data-expand]');
  if (card) {
    expandedId = expandedId === card.dataset.expand ? null : card.dataset.expand;
    applyFilter(activeFilter);
  }
});

$('refresh-btn').addEventListener('click', loadRequests);
$('logout-btn').addEventListener('click', logout);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && adminKey) { /* keep dashboard open; Escape reserved */ } });
