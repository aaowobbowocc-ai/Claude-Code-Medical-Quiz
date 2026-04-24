-- site_stats: persistent server stats (Render free-tier FS is ephemeral).
--
-- Backend snapshots the in-memory stats object to Supabase every 5 minutes
-- and loads it back on startup. This survives redeploys and restarts, so
-- aiDaily / dailyVisits / cumulative counters stay intact long-term.

CREATE TABLE IF NOT EXISTS site_stats (
  key TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE site_stats ENABLE ROW LEVEL SECURITY;
-- No public policies; only service role (backend SUPABASE_KEY) can read/write.
