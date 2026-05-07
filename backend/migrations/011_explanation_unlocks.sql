-- Per-user paid explanation unlocks.
--
-- When a user pays for an AI explanation (full or pending price), record the
-- unlock so subsequent views (anywhere — practice, favorites, browse, mock,
-- review, on any device the user is logged into) are free.
--
-- The frontend mirrors this in localStorage for anonymous / fast-path access.
-- On login (Supabase auth state → session.user.id), the frontend POSTs the
-- local unlocks to /ai/unlocks/sync and pulls the server set back; merging
-- both gives cross-device persistence for logged-in users.
--
-- exam_id is informational only (lets us show "you've unlocked X explanations
-- for medlab" in account stats); the (user_id, question_id) unique key is what
-- matters. question_id is text because IDs vary in format (numeric for some
-- exams, "112030_paper1_5" style strings for others, shared-bank composite
-- IDs, etc.).

CREATE TABLE IF NOT EXISTS user_explanation_unlocks (
  user_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  exam_id TEXT,
  paid_amount INTEGER NOT NULL DEFAULT 0,
  unlocked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, question_id)
);

CREATE INDEX IF NOT EXISTS idx_user_explanation_unlocks_user
  ON user_explanation_unlocks (user_id);

ALTER TABLE user_explanation_unlocks ENABLE ROW LEVEL SECURITY;

-- Backend writes via the service role key (bypasses RLS), so we don't need
-- permissive policies for clients. We do allow logged-in users to read their
-- own rows in case we ever expose a debug endpoint.
DROP POLICY IF EXISTS "users read own unlocks" ON user_explanation_unlocks;
CREATE POLICY "users read own unlocks"
  ON user_explanation_unlocks
  FOR SELECT
  USING (auth.uid()::text = user_id);
