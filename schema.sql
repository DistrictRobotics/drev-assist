-- DREV Assist — full D1 schema for a fresh database.
-- Existing databases: apply migrations/ in order instead of re-running this.

CREATE TABLE IF NOT EXISTS assist_service_requests (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL CHECK (category IN ('roadside','home')),
  service_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','reviewed','dispatched','complete','cancelled')),
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
  provider_label TEXT,
  scheduled_window TEXT,
  idempotency_key TEXT,
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_requests_status ON assist_service_requests(status);
CREATE INDEX IF NOT EXISTS idx_requests_customer ON assist_service_requests(customer_id);
CREATE INDEX IF NOT EXISTS idx_requests_requested ON assist_service_requests(requested_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_requests_idempotency
  ON assist_service_requests(idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Audit trail: one row per status change / dispatcher action.
CREATE TABLE IF NOT EXISTS assist_request_events (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES assist_service_requests(id),
  actor TEXT NOT NULL,               -- 'customer' | 'admin' | 'dispatcher' | 'system'
  from_status TEXT,
  to_status TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_request ON assist_request_events(request_id, created_at);

-- Fixed-window rate limiting; bucket contains a SHA-256 hash of the IP, never the IP.
CREATE TABLE IF NOT EXISTS assist_rate_limits (
  bucket TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL
);

-- Authenticated customer profile (keyed by the verified JWT `sub`).
CREATE TABLE IF NOT EXISTS assist_customers (
  id TEXT PRIMARY KEY,               -- JWT sub
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

CREATE TABLE IF NOT EXISTS assist_members (
  id                      TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  stripe_customer_id      TEXT UNIQUE NOT NULL,
  stripe_subscription_id  TEXT,
  email                   TEXT,
  plan                    TEXT NOT NULL CHECK(plan IN ('essential','flex')),
  status                  TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','cancelled','paused')),
  created_at              TEXT NOT NULL,
  updated_at              TEXT
);
CREATE INDEX IF NOT EXISTS idx_members_email ON assist_members(email);
