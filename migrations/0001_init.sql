-- The ledger: one row per email the worker handled.
CREATE TABLE IF NOT EXISTS mail (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,            -- ISO timestamp
  to_addr TEXT,                -- envelope recipient, e.g. jobs+acme@example.com
  tag TEXT,                    -- the +tag of to_addr ("acme"), empty if none
  from_addr TEXT,
  subject TEXT,
  message_id TEXT,             -- without angle brackets
  watch TEXT,                  -- watch name, NULL for unmatched mail
  category TEXT,               -- category, or uncertain / error / default
  confidence REAL,             -- Jev probability of the chosen category
  probs TEXT,                  -- JSON of all category probabilities
  action TEXT,                 -- comma flags: forwarded, dropped, notified
  forwarded_to TEXT,
  fields TEXT,                 -- JSON of extracted fields
  summary TEXT,                -- the note text the writer produced
  notified TEXT,               -- JSON {channel: "ok" | error}
  cpu_ms REAL,
  error TEXT,
  r2_key TEXT                  -- raw .eml in R2, NULL when not retained
);
CREATE INDEX IF NOT EXISTS mail_at ON mail (at);
CREATE INDEX IF NOT EXISTS mail_watch ON mail (watch, at);

-- Alerts about the watcher's own failures. sent: sent / throttled / failed: <reason>.
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT,
  sent TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS alerts_kind ON alerts (kind, at);

-- Scheduled job runs.
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  job TEXT NOT NULL,           -- selftest / digest
  ok INTEGER NOT NULL,
  detail TEXT
);
