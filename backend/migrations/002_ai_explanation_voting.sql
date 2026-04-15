-- Community voting on AI-generated explanations.
--
-- Extends ai_explanations with a lifecycle: pending → verified → retracted.
--   pending   — Fresh AI generation. Served with "🤖 尚未驗證" label. Charged
--               at half price (75 coins) to encourage early reviewers.
--   verified  — Accumulated upvotes >= 3. Shown as "📝 參考解答(社群認證)" and
--               served for free to any reader (attracts new viewers, spreads
--               cost of the original generation).
--   retracted — Accumulated downvotes crossed the asymmetric threshold (see
--               backend/ai.js). explanation_md is cleared so the next reader
--               triggers a fresh generation with higher temperature (tracked
--               via retracted_fingerprint to detect AI repeating the same bad
--               answer).
--
-- Retraction rules (enforced in backend/ai.js, not in SQL):
--   pending  → retracted when downvotes >= 3
--   verified → retracted when downvotes >= max(3, upvotes / 2)
--
-- Voting dedupe happens in backend/ai.js via the ai_votes table below. RLS is
-- public SELECT only; mutations go through service role.

ALTER TABLE ai_explanations
  ADD COLUMN IF NOT EXISTS upvotes INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS downvotes INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'verified', 'retracted')),
  ADD COLUMN IF NOT EXISTS retracted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS retracted_fingerprint TEXT;

-- Retraction clears explanation_md so the next reader triggers a fresh Claude
-- call. Migration 001 declared the column NOT NULL, so drop the constraint
-- before the app tries to UPDATE ... SET explanation_md = NULL.
ALTER TABLE ai_explanations
  ALTER COLUMN explanation_md DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ai_explanations_status
  ON ai_explanations (status);

-- One row per (cache_key, voter). Voter identity is the tuple (device_id,
-- user_id, ip_hash) — any one matching prior row blocks the second vote.
-- The unique index on (cache_key, device_id) is the hard check; user_id and
-- ip_hash duplicates are caught by the app layer.
CREATE TABLE IF NOT EXISTS ai_votes (
  id BIGSERIAL PRIMARY KEY,
  cache_key TEXT NOT NULL,
  device_id TEXT NOT NULL,
  user_id TEXT,
  ip_hash TEXT,
  value SMALLINT NOT NULL CHECK (value IN (-1, 1)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_votes_cache_device
  ON ai_votes (cache_key, device_id);

CREATE INDEX IF NOT EXISTS idx_ai_votes_cache_key
  ON ai_votes (cache_key);

CREATE INDEX IF NOT EXISTS idx_ai_votes_user
  ON ai_votes (cache_key, user_id) WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ai_votes_ip
  ON ai_votes (cache_key, ip_hash, created_at) WHERE ip_hash IS NOT NULL;

ALTER TABLE ai_votes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ai_votes_public_read" ON ai_votes;
CREATE POLICY "ai_votes_public_read"
  ON ai_votes FOR SELECT
  USING (true);

-- No INSERT/UPDATE/DELETE policy → writes only via service role.
