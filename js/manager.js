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
  $('auto-refresh').checked = false;
  $('dash').classList.add('hidden');
  $('login-wrap').classList.remove('hidden');
  $('key-input').value = '';
  $('login-err').textContent = '';
}

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
