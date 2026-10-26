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
