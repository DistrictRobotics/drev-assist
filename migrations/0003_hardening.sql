-- 0003: real persistence for profile/vehicles/homes, audit trail,
-- rate limiting, idempotent submissions, status vocabulary enforcement.
-- Apply with: npx wrangler d1 migrations apply drev-assist-db

ALTER TABLE assist_service_requests ADD COLUMN idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_requests_idempotency
  ON assist_service_requests(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_requests_requested ON assist_service_requests(requested_at DESC);

CREATE TABLE IF NOT EXISTS assist_request_events (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES assist_service_requests(id),
  actor TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_request ON assist_request_events(request_id, created_at);

CREATE TABLE IF NOT EXISTS assist_rate_limits (
  bucket TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS assist_customers (
  id TEXT PRIMARY KEY,
  display_name TEXT,
  phone TEXT,
  email TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS assist_vehicles (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES assist_customers(id),
  make TEXT NOT NULL,
  model TEXT,
  year INTEGER,
  powertrain TEXT CHECK (powertrain IS NULL OR powertrain IN ('ev','ice')),
  plate_last_four TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_vehicles_customer ON assist_vehicles(customer_id);

CREATE TABLE IF NOT EXISTS assist_homes (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES assist_customers(id),
  label TEXT,
  address_line1 TEXT NOT NULL,
  city TEXT,
  region TEXT NOT NULL,
  postal_code TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_homes_customer ON assist_homes(customer_id);
