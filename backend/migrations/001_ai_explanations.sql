-- Read-through cache for AI question explanations.
--
-- Cache keys:
--   shared:<bankId>:<questionId>  — shared bank questions; reused across all
--     exams that include the bank. e.g. civil-senior-general and
--     civil-junior-general both query the same row for a 憲法 question.
--   exam:<examId>:<questionId>    — exam-owned questions (existing 14 medical
--     exams + future exam-specific banks).
--
-- Read path (backend/ai.js): query by cache_key → hit returns explanation_md
-- and increments hit_count → no Claude API call. Miss falls through to Claude
-- and inserts the result.
--
-- RLS: SELECT is public so frontend can theoretically read directly; INSERT/
-- UPDATE/DELETE require the service role (backend writes via service key).

CREATE TABLE IF NOT EXISTS ai_explanations (
  id BIGSERIAL PRIMARY KEY,
  cache_key TEXT UNIQUE NOT NULL,
  explanation_md TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  hit_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_ai_explanations_cache_key
  ON ai_explanations (cache_key);

ALTER TABLE ai_explanations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ai_explanations_public_read" ON ai_explanations;
CREATE POLICY "ai_explanations_public_read"
  ON ai_explanations FOR SELECT
  USING (true);

-- No INSERT/UPDATE/DELETE policy → writes only via service role.
