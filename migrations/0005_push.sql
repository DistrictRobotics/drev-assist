-- 0005: Web Push subscriptions for job alerts.
--
-- One row per browser/device a technician has enabled alerts on. Only the
-- three values the push service needs are stored: the endpoint URL and the
-- subscription's own P-256 public key + auth secret. Those are credentials
-- for delivering to that device — they are useless to anyone else, but the
-- row is scoped to a technician and deleted the moment the push service
-- reports the endpoint gone (404/410) or the technician signs out.
--
-- Apply with: npx wrangler d1 execute drev-assist-db --local --file migrations/0005_push.sql

CREATE TABLE IF NOT EXISTS assist_push_subscriptions (
  endpoint TEXT PRIMARY KEY,          -- push service URL (unique per device)
  tech_id TEXT NOT NULL REFERENCES assist_technicians(id),
  p256dh TEXT NOT NULL,               -- subscription public key (base64url)
  auth TEXT NOT NULL,                 -- subscription auth secret (base64url)
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_push_tech ON assist_push_subscriptions(tech_id);
