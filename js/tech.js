/* DREV Assist — Field app (technician).
 *
 * Security notes:
 *  - Every customer-supplied value is written with textContent. There is no
 *    innerHTML anywhere in this file, so a name or note containing markup is
 *    displayed as text and cannot execute on a technician's phone.
 *  - The shift token lives in sessionStorage, never localStorage: it dies
 *    with the tab, which matters on a shared cab device.
 *  - The server decides scope. This app asks for "my jobs"; it never filters
 *    someone else's list down on the client.
 *  - Phone numbers are stripped to digits before becoming a tel: link, and
 *    map links are built from numbers only.
 */
'use strict';

const TOKEN_KEY = 'drev-tech-token';
const REFRESH_MS = 20000;

let token = '';
let tech = null;
let jobs = [];
let recent = [];
let timer = null;
let bannerTimer = null;

const $ = id => document.getElementById(id);

const SERVICE_LABELS = {
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

const STATE_LABEL = {
  dispatched: 'DISPATCHED',
  en_route: 'EN ROUTE',
  arrived: 'ON SITE',
  complete: 'COMPLETE',
  cancelled: 'CANCELLED',
};

/* The one button that matters, per state. */
const NEXT_STEP = {
  dispatched: { to: 'en_route', label: 'START DRIVE', cls: '' },
  en_route: { to: 'arrived', label: "I'VE ARRIVED", cls: 'a-arrived' },
  arrived: { to: 'complete', label: 'COMPLETE JOB', cls: 'a-complete' },
};

/* ── tiny DOM helpers (no innerHTML, ever) ─────────────────── */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function telHref(phone) {
  const digits = String(phone ?? '').replace(/[^\d+]/g, '');
  return digits.length >= 7 ? 'tel:' + digits : null;
}

function mapsHref(lat, lng) {
  const a = Number(lat), b = Number(lng);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return `https://www.google.com/maps/dir/?api=1&destination=${a},${b}`;
}

function relTime(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '';
  const min = Math.round(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  return hr < 24 ? `${hr} hr ago` : `${Math.round(hr / 24)} d ago`;
}

/* ── API ──────────────────────────────────────────────────── */
async function api(method, body) {
  const res = await fetch('/api/assist/tech', {
    method,
    headers: {
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    endShift('Your shift ended. Sign in again with your access code.');
    throw new Error(data?.error?.message || 'Session expired.');
  }
  if (!res.ok) throw new Error(data?.error?.message || `Request failed (${res.status}).`);
  return data;
}

/* ── Sign in / out ────────────────────────────────────────── */
async function signIn(code) {
  const res = await fetch('/api/assist/tech', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'login', code }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || 'Could not sign in.');
  token = data.token;
  tech = data.tech;
  try { sessionStorage.setItem(TOKEN_KEY, token); } catch (_) {}
  return data.tech;
}

function endShift(message) {
  token = '';
  tech = null;
  jobs = [];
  recent = [];
  try { sessionStorage.removeItem(TOKEN_KEY); } catch (_) {}
  if (timer) { clearInterval(timer); timer = null; }
  $('app').classList.add('hidden');
  $('login').classList.remove('hidden');
  $('code-input').value = '';
  if (message) {
    $('login-error').textContent = message;
    $('login-error').classList.remove('hidden');
  }
}

async function signOut() {
  if (token) {
    try {
      await fetch('/api/assist/tech', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'logout' }),
      });
    } catch (_) { /* signing out locally is what matters */ }
  }
  endShift('');
  $('login-error').classList.add('hidden');
}

/* ── Banner ───────────────────────────────────────────────── */
function say(message, kind) {
  const b = $('banner');
  b.textContent = message;
  b.className = 'banner' + (kind ? ' is-' + kind : '');
  if (bannerTimer) clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => b.classList.add('hidden'), 6000);
}

/* ── Render ───────────────────────────────────────────────── */
function metaRow(key, valueNode) {
  const row = el('div', 'row');
  row.append(el('span', 'k', key), valueNode);
  valueNode.classList.add('v');
  return row;
}

function buildJob(job, { active }) {
  const card = el('article', 'job s-' + job.status);

  const top = el('div', 'job-top');
  top.append(
    el('div', 'svc', SERVICE_LABELS[job.service_type] || job.service_type),
    el('span', 'state s-' + job.status, STATE_LABEL[job.status] || job.status),
  );
  card.append(top);

  const meta = el('div', 'job-meta');
  if (job.customer_name) meta.append(metaRow('CUSTOMER', el('span', '', job.customer_name)));

  const phoneHref = telHref(job.customer_phone);
  if (phoneHref) {
    const call = el('a', 'call', '📞 ' + job.customer_phone);
    call.href = phoneHref;
    meta.append(metaRow('CALL', call));
  }

  if (job.location_label) {
    const where = el('div');
    where.append(el('div', '', job.location_label));
    const maps = mapsHref(job.location_lat, job.location_lng);
    if (maps) {
      const link = el('a', 'maps', '↗ OPEN IN MAPS');
      link.href = maps;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      where.append(link);
    }
    meta.append(metaRow('WHERE', where));
  }
  if (job.vehicle) meta.append(metaRow('VEHICLE', el('span', '', job.vehicle)));
  card.append(meta);

  if (job.intake_notes) card.append(el('div', 'notes', job.intake_notes));

  if (active) {
    const next = NEXT_STEP[job.status];
    if (next) {
      const note = el('textarea', 'note-in');
      note.placeholder = next.to === 'complete'
        ? 'What did you do? (optional — shows on the customer record)'
        : 'Anything dispatch should know? (optional)';
      note.maxLength = 500;
      note.rows = 2;
      card.append(note);

      const btn = el('button', 'advance ' + next.cls, next.label);
      btn.type = 'button';
      btn.addEventListener('click', () => advance(job, next, btn, note));
      card.append(btn);
    }
    card.append(el('div', 'job-foot', `Assigned ${relTime(job.requested_at)} · ref ${String(job.id).slice(0, 8)}`));
  } else {
    card.append(el('div', 'job-foot', `${STATE_LABEL[job.status] || job.status} · ${relTime(job.updated_at || job.requested_at)}`));
  }
  return card;
}

function render() {
  $('tech-who').textContent = tech?.name || 'Technician';
  $('tech-unit').textContent = [tech?.unit, tech?.phone].filter(Boolean).join(' · ') || 'Field';
  $('active-count').textContent = String(jobs.length);

  const list = $('jobs');
  list.replaceChildren();
  if (!jobs.length) {
    list.append(el('div', 'empty', 'No jobs assigned. Dispatch will push work here — this page refreshes itself.'));
  } else {
    for (const job of jobs) list.append(buildJob(job, { active: true }));
  }

  const rlist = $('recent');
  rlist.replaceChildren();
  if (!recent.length) {
    $('recent-sec').classList.add('hidden');
  } else {
    $('recent-sec').classList.remove('hidden');
    for (const job of recent) {
      const row = el('div', 'mini');
      row.append(
        el('span', '', SERVICE_LABELS[job.service_type] || job.service_type),
        el('span', 'm-status', STATE_LABEL[job.status] || job.status),
      );
      rlist.append(row);
    }
  }

  $('stamp').textContent = 'Updated ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    + ' · refreshes every ' + Math.round(REFRESH_MS / 1000) + 's';
}

async function refresh({ quiet = false } = {}) {
  try {
    const data = await api('GET');
    tech = data.tech || tech;
    jobs = Array.isArray(data.jobs) ? data.jobs : [];
    recent = Array.isArray(data.recent) ? data.recent : [];
    if (window.DrevPush && data.push) window.DrevPush.applyServerInfo(data.push);
    render();
    await refreshAlerts();
    alertsHint();
    if (!quiet) $('banner').classList.add('hidden');
  } catch (e) {
    if (!token) return; // already back at sign-in
    say(e.message || 'Could not refresh jobs.', 'error');
  }
}

/* ── The only write this app performs ────────────────────── */
async function advance(job, next, btn, noteEl) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'SAVING…';
  try {
    const data = await api('PATCH', {
      id: job.id,
      status: next.to,
      ...(noteEl?.value.trim() ? { note: noteEl.value.trim() } : {}),
    });
    if (data.tech) tech = data.tech;
    const label = STATE_LABEL[next.to] || next.to;
    say(next.to === 'complete'
      ? 'Job closed. Nice work — the customer sees it immediately.'
      : `Marked ${label.toLowerCase()}. The customer's tracking view updates on its own.`,
      'ok');
    await refresh({ quiet: true });
  } catch (e) {
    say(e.message || 'Could not update the job.', 'error');
    btn.disabled = false;
    btn.textContent = original;
  }
}

/* ── Job alerts ─────────────────────────────────────────────
   States come from js/push.js; the copy stays honest. "On" only ever means
   the server has this device's subscription and reports it. */
const ALERT_COPY = {
  unsupported:  ['Job alerts', 'This browser cannot show notifications. Keep the board open during your shift.', 'HIDE', true],
  'not-configured': ['Job alerts', 'Alerts are not set up on this deployment yet. The board still refreshes itself.', 'HIDE', true],
  blocked:      ['Alerts blocked', 'Allow notifications for this site in your browser settings, then reload.', 'BLOCKED', true],
  default:      ['Job alerts', 'Get a notification the moment dispatch assigns you a job.', 'TURN ON', false],
  off:          ['Job alerts', 'Alerts are off on this device.', 'TURN ON', false],
  subscribed:   ['Alerts on', 'You will get a notification here when a job is assigned. Tap SEND TEST to check.', 'SEND TEST', false],
};

async function refreshAlerts() {
  const strip = $('alerts');
  if (!strip) return;
  const btn = $('alerts-btn');
  const state = (window.DrevPush && (await window.DrevPush.status().catch(() => 'unsupported'))) || 'unsupported';
  const [title, sub, label, disabled] = ALERT_COPY[state] || ALERT_COPY.default;

  strip.classList.remove('hidden', 'is-on', 'is-off', 'is-warn');
  strip.classList.add(state === 'subscribed' ? 'is-on' : (state === 'blocked' || state === 'not-configured') ? 'is-warn' : 'is-off');
  strip.dataset.state = state;
  $('alerts-title').textContent = title;
  $('alerts-sub').textContent = sub;
  $('alerts-icon').textContent = state === 'subscribed' ? '🔔' : state === 'blocked' || state === 'not-configured' ? '🔕' : '🔔';
  btn.textContent = label;
  btn.disabled = disabled;
  btn.dataset.action = state === 'subscribed' ? 'test' : 'enable';
  btn.classList.toggle('hidden', label === 'HIDE');
}

async function onAlertsClick() {
  const btn = $('alerts-btn');
  if (!window.DrevPush) return;
  const action = btn.dataset.action;
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = action === 'test' ? 'SENDING…' : 'TURNING ON…';
  try {
    if (action === 'test') {
      await window.DrevPush.test(token);
      say('Test alert sent. If nothing appears, check this site\'s notification settings.', 'ok');
    } else {
      await window.DrevPush.enable(token);
      say('Job alerts are on for this device.', 'ok');
    }
  } catch (e) {
    say(e.message || 'Could not change alert settings.', 'error');
  }
  btn.textContent = original;
  btn.disabled = false;
  await refreshAlerts();
}

/**
 * Tell a technician why alerts are not on, without them hunting for a switch:
 * an installed-looking phone with alerts off is the single most common way a
 * missed job happens.
 */
function alertsHint() {
  const strip = $('alerts');
  if (!strip || strip.dataset.state !== 'off' && strip.dataset.state !== 'default') return;
  if (jobs.length > 0) {
    $('alerts-sub').textContent = 'Alerts are off — you will not be notified about new jobs unless this page is open.';
  }
}

/* ── Boot ─────────────────────────────────────────────────── */
function startPolling() {
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    if (document.hidden || !token) return; // no point polling a backgrounded phone
    refresh({ quiet: true });
  }, REFRESH_MS);
}

async function enterApp() {
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
  await refresh({ quiet: true });
  startPolling();
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('login-btn');
  const code = $('code-input').value.trim();
  $('login-error').classList.add('hidden');
  if (!code) {
    $('login-error').textContent = 'Enter the access code dispatch gave you.';
    $('login-error').classList.remove('hidden');
    return;
  }
  btn.disabled = true;
  btn.textContent = 'SIGNING IN…';
  try {
    await signIn(code);
    await enterApp();
  } catch (err) {
    $('login-error').textContent = err.message || 'Could not sign in.';
    $('login-error').classList.remove('hidden');
  }
  btn.disabled = false;
  btn.textContent = 'START SHIFT';
});

$('alerts-btn')?.addEventListener('click', onAlertsClick);
$('refresh-btn').addEventListener('click', () => refresh());

/* The push service rotated our subscription: re-register quietly so the
   tech does not go deaf mid-shift. */
window.addEventListener('drevpush:resubscribe', async () => {
  if (!token || !window.DrevPush) return;
  try {
    await window.DrevPush.enable(token);
    say('Alerts re-registered on this device.', 'ok');
  } catch (_) { /* the strip already shows the real state */ }
  refreshAlerts();
});
$('logout-btn').addEventListener('click', signOut);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && token) refresh({ quiet: true });
});

(async function boot() {
  try { token = sessionStorage.getItem(TOKEN_KEY) || ''; } catch (_) { token = ''; }
  if (!token) return;
  try {
    await enterApp();
  } catch (_) {
    endShift('Your shift ended. Sign in again with your access code.');
  }
})();
