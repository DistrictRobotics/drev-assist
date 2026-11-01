-- 0004: field technicians — per-tech identity, and two new job states.
--
-- Why the table rebuild: SQLite cannot ALTER a CHECK constraint, and
-- assist_service_requests.status is constrained to the original five values.
-- The tech workflow needs `en_route` and `arrived` between dispatched and
-- complete, so the table is rebuilt in place with the widened constraint and
-- the new assigned_tech_id column. Existing rows keep their ids and data.
--
-- Apply with: npx wrangler d1 migrations apply drev-assist-db
-- (or `npx wrangler d1 execute drev-assist-db --local --file migrations/0004_technicians.sql`)

PRAGMA foreign_keys = OFF;

BEGIN;

CREATE TABLE assist_service_requests_new (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL CHECK (category IN ('roadside','home')),
  service_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted','reviewed','dispatched','en_route','arrived','complete','cancelled')),
  location_label TEXT,
  location_lat REAL,
  location_lng REAL,
  powertrain TEXT CHECK (powertrain IS NULL OR powertrain IN ('ev','ice')),
  vehicle TEXT,
  intake_notes TEXT,
  member_plan_requested INTEGER NOT NULL DEFAULT 0,
  customer_name TEXT,
  customer_phone TEXT,
  customer_email TEXT,
  customer_id TEXT,
  assigned_dispatcher_id TEXT,
  assigned_tech_id TEXT,            -- assist_technicians.id (NULL until a tech is dispatched)
  provider_label TEXT,
  scheduled_window TEXT,
  idempotency_key TEXT,
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO assist_service_requests_new (
  id, category, service_type, status, location_label, location_lat, location_lng,
  powertrain, vehicle, intake_notes, member_plan_requested, customer_name,
  customer_phone, customer_email, customer_id, assigned_dispatcher_id,
  provider_label, scheduled_window, idempotency_key, requested_at, updated_at
)
SELECT
  id, category, service_type, status, location_label, location_lat, location_lng,
  powertrain, vehicle, intake_notes, member_plan_requested, customer_name,
  customer_phone, customer_email, customer_id, assigned_dispatcher_id,
  provider_label, scheduled_window, idempotency_key, requested_at, updated_at
FROM assist_service_requests;

DROP TABLE assist_service_requests;
ALTER TABLE assist_service_requests_new RENAME TO assist_service_requests;

-- Indexes were dropped with the old table.
CREATE INDEX IF NOT EXISTS idx_requests_status ON assist_service_requests(status);
CREATE INDEX IF NOT EXISTS idx_requests_customer ON assist_service_requests(customer_id);
CREATE INDEX IF NOT EXISTS idx_requests_requested ON assist_service_requests(requested_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_requests_idempotency
  ON assist_service_requests(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_requests_tech
  ON assist_service_requests(assigned_tech_id, status);

-- Field technicians. Access codes are stored only as SHA-256 digests, so a
-- database leak does not hand over working logins. Mint one with
-- `node tools/add-tech.mjs --name "Maya R" --unit "Unit 1"`.
CREATE TABLE IF NOT EXISTS assist_technicians (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  unit TEXT,
  phone TEXT,
  access_code_hash TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT
);

-- Short-lived shift sessions. Only the token digest is stored; expiry is
-- enforced in the API, and the row count stays small (24h TTL).
CREATE TABLE IF NOT EXISTS assist_tech_sessions (
  token_hash TEXT PRIMARY KEY,
  tech_id TEXT NOT NULL REFERENCES assist_technicians(id),
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tech_sessions_expiry ON assist_tech_sessions(expires_at);

COMMIT;

PRAGMA foreign_keys = ON;
