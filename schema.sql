CREATE TABLE IF NOT EXISTS assist_service_requests (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  service_type TEXT NOT NULL,
  status TEXT DEFAULT 'submitted',
  location_label TEXT,
  location_lat REAL,
  location_lng REAL,
  powertrain TEXT,
  vehicle TEXT,
  intake_notes TEXT,
  member_plan_requested INTEGER DEFAULT 0,
  customer_name TEXT,
  customer_phone TEXT,
  customer_email TEXT,
  customer_id TEXT,
  assigned_dispatcher_id TEXT,
  provider_label TEXT,
  scheduled_window TEXT,
  requested_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_requests_status ON assist_service_requests(status);
CREATE INDEX IF NOT EXISTS idx_requests_customer ON assist_service_requests(customer_id);
