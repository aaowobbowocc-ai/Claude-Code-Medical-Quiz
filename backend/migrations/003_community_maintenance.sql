-- Community maintenance tables (Plan D.6).
--
-- deprecation_reports: users flag shared-bank questions whose legal
--   basis has been amended. Admin reviews → flips the question's
--   `is_deprecated: true` in the shared bank JSON → writes a
--   `user_achievements` row for the reporter.
--
-- user_achievements: gamification for crowdsourced maintenance. Only
--   `legal_guardian` is wired this phase; `exam_pioneer` /
--   `disputed_hunter` are reserved slots for later.
--
-- Both tables are per-user: SELECT restricted to the owning user,
-- INSERT for deprecation_reports allowed to any authenticated user
-- (it's a report about shared content, not personal data), writes to
-- user_achievements only via service role.

CREATE TABLE IF NOT EXISTS deprecation_reports (
  id BIGSERIAL PRIMARY KEY,
  shared_bank_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  reporter_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  new_answer_suggestion TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_deprecation_reports_bank_q
  ON deprecation_reports (shared_bank_id, question_id);

CREATE INDEX IF NOT EXISTS idx_deprecation_reports_reporter
  ON deprecation_reports (reporter_user_id) WHERE reporter_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_deprecation_reports_status
  ON deprecation_reports (status);

ALTER TABLE deprecation_reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "deprecation_reports_owner_read" ON deprecation_reports;
CREATE POLICY "deprecation_reports_owner_read"
  ON deprecation_reports FOR SELECT
  USING (auth.uid() = reporter_user_id);

DROP POLICY IF EXISTS "deprecation_reports_auth_insert" ON deprecation_reports;
CREATE POLICY "deprecation_reports_auth_insert"
  ON deprecation_reports FOR INSERT
  WITH CHECK (auth.uid() = reporter_user_id);

-- Updates (status flips, reviewed_at) go through service role only.

CREATE TABLE IF NOT EXISTS user_achievements (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  achievement_id TEXT NOT NULL
    CHECK (achievement_id IN ('legal_guardian', 'exam_pioneer', 'disputed_hunter')),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  count INTEGER NOT NULL DEFAULT 1,
  UNIQUE (user_id, achievement_id)
);

CREATE INDEX IF NOT EXISTS idx_user_achievements_user
  ON user_achievements (user_id);

ALTER TABLE user_achievements ENABLE ROW LEVEL SECURITY;

-- Achievements are public-ish (display on Leaderboard); anyone can
-- read anyone's badges. Writes stay service-role only.
DROP POLICY IF EXISTS "user_achievements_public_read" ON user_achievements;
CREATE POLICY "user_achievements_public_read"
  ON user_achievements FOR SELECT
  USING (true);
