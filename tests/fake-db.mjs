/* Minimal in-memory fake for the subset of the D1 API the Functions use.
   Pattern-matches the SQL strings in functions/api/assist/*.js — it is a
   test double, not a SQL engine. */
const ACTIVE_TECH_STATUSES = ['dispatched', 'en_route', 'arrived'];

export class FakeDB {
  constructor() {
    this.requests = [];
    this.events = [];
    this.rateLimits = new Map();
    this.customers = [];
    this.vehicles = [];
    this.homes = [];
    this.technicians = [];
    this.techSessions = [];
    this.pushSubs = [];
  }

  /* D1 returns only the columns the query names. The fake has to do the same,
     otherwise a test cannot tell "we don't select customer_email" from
     "we select it and hope". */
  #project(sql, row) {
    if (!row) return row;
    if (!/^SELECT\s/i.test(sql) || sql.includes('*')) return row;
    const m = sql.match(/^SELECT\s+([\s\S]+?)\s+FROM\s/i);
    if (!m) return row;
    const list = m[1];
    if (list.includes('(') || /\sAS\s/i.test(list)) return row;
    const cols = list.split(',').map(s => s.trim().split(/\s+/).pop()).filter(Boolean);
    const out = {};
    for (const c of cols) if (c in row) out[c] = row[c];
    return out;
  }

  prepare(rawSql) {
    const sql = rawSql.trim();
    const db = this;
    let params = [];
    const stmt = {
      bind(...p) { params = p; return stmt; },
      async first() {
        if (sql.includes("SELECT 1")) return { '1': 1 };
        if (sql.includes('assist_rate_limits')) {
          const row = db.rateLimits.get(params[0]);
          return row ? { count: row.count } : null;
        }
        if (sql.includes('COUNT(*)')) {
          return { n: db.#filtered(sql, params).length };
        }
        if (sql.includes('FROM assist_service_requests')) {
          let row;
          if (sql.includes('idempotency_key')) row = db.requests.find(r => r.idempotency_key === params[0]);
          else if (sql.includes('WHERE id = ?')) row = db.requests.find(r => r.id === params[0]);
          else if (sql.includes('customer_id = ?')) row = db.requests.find(r => r.customer_id === params[0]);
          else row = db.requests[0];
          return db.#project(sql, row || null);
        }
        if (sql.includes('FROM assist_customers')) return db.customers.find(c => c.id === params[0]) || null;
        if (sql.includes('FROM assist_technicians')) {
          if (sql.includes('access_code_hash = ?')) {
            return db.technicians.find(t => t.access_code_hash === params[0] && t.active === 1) || null;
          }
          return db.#project(sql, db.technicians.find(t => t.id === params[0]
            && (!sql.includes('active = 1') || t.active === 1)) || null);
        }
        if (sql.includes('COUNT(*)') && sql.includes('assist_push_subscriptions')) {
          return { n: db.pushSubs.filter(s => s.tech_id === params[0]).length };
        }
        if (sql.includes('FROM assist_tech_sessions')) {
          return db.techSessions.find(s => s.token_hash === params[0]) || null;
        }
        return null;
      },
      async all() {
        if (sql.includes('FROM assist_push_subscriptions')) {
          const rows = db.pushSubs.filter(s => s.tech_id === params[0]);
          return { results: rows.map(r => db.#project(sql, r)) };
        }
        if (sql.includes('FROM assist_technicians')) {
          const rows = [...db.technicians].sort((a, b) => (b.active - a.active) || String(a.name).localeCompare(String(b.name)));
          return { results: rows.map(r => db.#project(sql, r)) };
        }
        if (sql.includes('FROM assist_service_requests') && sql.includes('assigned_tech_id = ?')) {
          /* A technician's own board: active jobs, or recent history. */
          const wanted = sql.includes("'complete'") ? ['complete', 'cancelled'] : ACTIVE_TECH_STATUSES;
          let rows = db.requests.filter(r => r.assigned_tech_id === params[0] && wanted.includes(r.status));
          rows = sql.includes('ORDER BY requested_at ASC')
            ? rows.sort((a, b) => String(a.requested_at).localeCompare(String(b.requested_at)))
            : rows.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))).slice(0, 10);
          return { results: rows.map(r => db.#project(sql, r)) };
        }
        if (sql.includes('FROM assist_service_requests')) {
          let rows = db.#filtered(sql, params);
          rows = [...rows].sort((a, b) => String(b.requested_at).localeCompare(String(a.requested_at)));
          // LIMIT ? OFFSET ? are the last bound params when present.
          if (sql.includes('LIMIT ? OFFSET ?')) {
            const limit = params[params.length - 2], offset = params[params.length - 1];
            rows = rows.slice(offset, offset + limit);
          } else if (sql.includes('LIMIT 50') || sql.includes('LIMIT 200')) {
            rows = rows.slice(0, sql.includes('LIMIT 50') ? 50 : 200);
          }
          return { results: rows.map(r => db.#project(sql, r)) };
        }
        if (sql.includes('FROM assist_vehicles')) return { results: db.vehicles.filter(v => v.customer_id === params[0]) };
        if (sql.includes('FROM assist_homes')) return { results: db.homes.filter(h => h.customer_id === params[0]) };
        return { results: [] };
      },
      async run() {
        let changes = 0;
        if (sql.startsWith('INSERT INTO assist_service_requests')) {
          const cols = sql.match(/\(([^)]+)\)/)[1].split(',').map(s => s.trim());
          const row = {};
          cols.forEach((c, i) => { row[c] = params[i]; });
          row.status = row.status || 'submitted';
          // SQL literal 'submitted' is not a bound param — align indexes:
          if (cols.includes('status') && typeof params[3] !== 'string') { /* handled by literal offset below */ }
          db.requests.push(db.#normalizeRequest(sql, cols, params));
          changes = 1;
        } else if (sql.startsWith('INSERT INTO assist_request_events')) {
          if (params.length >= 7) {
            db.events.push({ id: params[0], request_id: params[1], actor: params[2], from_status: params[3], to_status: params[4], note: params[5], created_at: params[6] });
          } else {
            db.events.push({ id: params[0], request_id: params[1], actor: params[2], from_status: params.length > 5 ? params[3] : null, to_status: params.length > 5 ? params[4] : params[3], note: null, created_at: params[params.length - 1] });
          }
          changes = 1;
        } else if (sql.startsWith('INSERT INTO assist_rate_limits')) {
          const existing = db.rateLimits.get(params[0]);
          if (existing) existing.count++; else db.rateLimits.set(params[0], { count: 1, window_start: params[1] });
          changes = 1;
        } else if (sql.startsWith('DELETE FROM assist_rate_limits')) {
          for (const [k, v] of db.rateLimits) if (v.window_start < params[0]) db.rateLimits.delete(k);
        } else if (sql.startsWith('INSERT INTO assist_customers')) {
          if (!db.customers.find(c => c.id === params[0])) db.customers.push({ id: params[0], display_name: null, phone: null, email: null, created_at: new Date().toISOString() });
          changes = 1;
        } else if (sql.startsWith('INSERT INTO assist_vehicles')) {
          db.vehicles.push({ id: params[0], customer_id: params[1], make: params[2], model: params[3], year: params[4], powertrain: params[5], plate_last_four: params[6] });
          changes = 1;
        } else if (sql.startsWith('INSERT INTO assist_homes')) {
          db.homes.push({ id: params[0], customer_id: params[1], label: params[2], address_line1: params[3], city: params[4], region: params[5], postal_code: params[6] });
          changes = 1;
        } else if (sql.startsWith('INSERT INTO assist_technicians')) {
          db.technicians.push({
            id: params[0], name: params[1], unit: params[2], phone: params[3],
            access_code_hash: params[4], active: 1,
            created_at: new Date().toISOString(), last_seen_at: null,
          });
          changes = 1;
        } else if (sql.startsWith('UPDATE assist_technicians SET last_seen_at')) {
          const tech = db.technicians.find(t => t.id === params[1]);
          if (tech) { tech.last_seen_at = params[0]; changes = 1; }
        } else if (sql.startsWith('UPDATE assist_technicians SET access_code_hash')) {
          const tech = db.technicians.find(t => t.id === params[1]);
          if (tech) { tech.access_code_hash = params[0]; changes = 1; }
        } else if (sql.startsWith('INSERT INTO assist_push_subscriptions')) {
          const existing = db.pushSubs.findIndex(s => s.endpoint === params[0]);
          const row = { endpoint: params[0], tech_id: params[1], p256dh: params[2], auth: params[3], user_agent: params[4], created_at: new Date().toISOString() };
          if (existing >= 0) db.pushSubs[existing] = row; else db.pushSubs.push(row);
          changes = 1;
        } else if (sql.startsWith('DELETE FROM assist_push_subscriptions WHERE endpoint = ? AND tech_id = ?')) {
          const before = db.pushSubs.length;
          db.pushSubs = db.pushSubs.filter(s => !(s.endpoint === params[0] && s.tech_id === params[1]));
          changes = before - db.pushSubs.length;
        } else if (sql.startsWith('DELETE FROM assist_push_subscriptions WHERE endpoint = ?')) {
          const before = db.pushSubs.length;
          db.pushSubs = db.pushSubs.filter(s => s.endpoint !== params[0]);
          changes = before - db.pushSubs.length;
        } else if (sql.startsWith('INSERT INTO assist_tech_sessions')) {
          db.techSessions.push({ token_hash: params[0], tech_id: params[1], expires_at: params[2] });
          changes = 1;
        } else if (sql.startsWith('DELETE FROM assist_tech_sessions WHERE expires_at <')) {
          const before = db.techSessions.length;
          db.techSessions = db.techSessions.filter(s => !(Number(s.expires_at) < params[0]));
          changes = before - db.techSessions.length;
        } else if (sql.startsWith('DELETE FROM assist_tech_sessions WHERE token_hash')) {
          const before = db.techSessions.length;
          db.techSessions = db.techSessions.filter(s => s.token_hash !== params[0]);
          changes = before - db.techSessions.length;
        } else if (sql.startsWith('DELETE FROM assist_tech_sessions WHERE tech_id')) {
          const before = db.techSessions.length;
          db.techSessions = db.techSessions.filter(s => s.tech_id !== params[0]);
          changes = before - db.techSessions.length;
        } else if (sql.startsWith('UPDATE assist_service_requests')) {
          const id = params[params.length - 1];
          const row = db.requests.find(r => r.id === id);
          if (row) {
            row.status = params[0];
            if (sql.includes('provider_label')) {
              row.provider_label = params[1];
              row.scheduled_window = params[2];
              row.updated_at = params[params.length - 2];
              if (sql.includes('assigned_tech_id')) row.assigned_tech_id = params[3];
            } else {
              row.updated_at = params[1];
            }
            if (sql.includes('assigned_dispatcher_id')) row.assigned_dispatcher_id = params[3];
            changes = 1;
          }
        } else if (sql.startsWith('UPDATE assist_customers')) {
          const c = db.customers.find(x => x.id === params[4]);
          if (c) { if (params[0]) c.display_name = params[0]; if (params[1]) c.phone = params[1]; if (params[2]) c.email = params[2]; changes = 1; }
        } else if (sql.startsWith('DELETE FROM assist_vehicles')) {
          const before = db.vehicles.length;
          db.vehicles = db.vehicles.filter(v => !(v.id === params[0] && v.customer_id === params[1]));
          changes = before - db.vehicles.length;
        } else if (sql.startsWith('DELETE FROM assist_homes')) {
          const before = db.homes.length;
          db.homes = db.homes.filter(h => !(h.id === params[0] && h.customer_id === params[1]));
          changes = before - db.homes.length;
        }
        return { meta: { changes } };
      },
    };
    return stmt;
  }

  #filtered(sql, params) {
    let rows = [...this.requests];
    let p = 0;
    if (sql.includes('status = ?') && sql.includes('WHERE')) { rows = rows.filter(r => r.status === params[p++]); }
    if (sql.includes('NOT IN')) rows = rows.filter(r => !['complete', 'cancelled'].includes(r.status));
    if (sql.includes('LIKE')) {
      const q = String(params[p] || '').replace(/%/g, '').toLowerCase();
      rows = rows.filter(r => [r.id, r.customer_name, r.customer_phone, r.location_label].some(v => String(v || '').toLowerCase().includes(q)));
      p += 4;
    }
    if (sql.includes('customer_id = ?')) rows = rows.filter(r => r.customer_id === params[0]);
    return rows;
  }

  #normalizeRequest(sql, cols, params) {
    // The INSERT lists status as the SQL literal 'submitted', so bound params
    // shift after the third column. Rebuild by matching the column list that
    // appears in VALUES placeholders only — simpler: map known columns in order.
    const order = ['id', 'category', 'service_type', 'location_label', 'location_lat', 'location_lng',
      'powertrain', 'vehicle', 'intake_notes', 'member_plan_requested',
      'customer_name', 'customer_phone', 'customer_email', 'customer_id',
      'idempotency_key', 'requested_at', 'updated_at'];
    const row = { status: 'submitted', provider_label: null, scheduled_window: null };
    order.forEach((c, i) => { row[c] = params[i] ?? null; });
    return row;
  }
}

export function ctx(env, { method = 'GET', url = 'https://assist.test/api/assist/requests', body, headers = {}, params = {} } = {}) {
  const req = new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined || method === 'GET' ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  return { request: req, env, params, waitUntil() {} };
}
