-- ==========================================================================
-- 國考知識王 — 所有 Supabase migrations 合併版
-- 一次貼進 Supabase SQL Editor 執行即可。所有語句都有 IF NOT EXISTS,
-- 重複執行安全、不會破壞既有資料。
-- ==========================================================================


-- ==========================================================================
-- 001_ai_explanations.sql
-- AI 解析快取:跨 exam 共用同一份憲法題解析,省 Claude API 呼叫。
-- ==========================================================================

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


-- ==========================================================================
-- 002_ai_explanation_voting.sql
-- 社群對 AI 解析投票: pending → verified / retracted 生命週期。
-- ==========================================================================

ALTER TABLE ai_explanations
  ADD COLUMN IF NOT EXISTS upvotes INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS downvotes INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'verified', 'retracted')),
  ADD COLUMN IF NOT EXISTS retracted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS retracted_fingerprint TEXT;

ALTER TABLE ai_explanations
  ALTER COLUMN explanation_md DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ai_explanations_status
  ON ai_explanations (status);

CREATE TABLE IF NOT EXISTS ai_votes (
  id BIGSERIAL PRIMARY KEY,
  cache_key TEXT NOT NULL,
  device_id TEXT NOT NULL,
  user_id TEXT,
  ip_hash TEXT,
  value SMALLINT NOT NULL CHECK (value IN (-1, 1)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 若既有 ai_votes 是舊版本,補齊可能缺少的欄位
ALTER TABLE ai_votes
  ADD COLUMN IF NOT EXISTS cache_key TEXT,
  ADD COLUMN IF NOT EXISTS device_id TEXT,
  ADD COLUMN IF NOT EXISTS user_id TEXT,
  ADD COLUMN IF NOT EXISTS ip_hash TEXT,
  ADD COLUMN IF NOT EXISTS value SMALLINT,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

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


-- ==========================================================================
-- 003_community_maintenance.sql
-- 社群維護: deprecation_reports (回報過時法條) + user_achievements (徽章)
-- ==========================================================================

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

DROP POLICY IF EXISTS "user_achievements_public_read" ON user_achievements;
CREATE POLICY "user_achievements_public_read"
  ON user_achievements FOR SELECT
  USING (true);


-- ==========================================================================
-- 004_leaderboard_exam_id.sql
-- 排行榜加 exam_id 欄位,支援類別隔離 (medical/law/civil)
-- ==========================================================================

ALTER TABLE leaderboard
  ADD COLUMN IF NOT EXISTS exam_id TEXT;

CREATE INDEX IF NOT EXISTS idx_leaderboard_week_exam
  ON leaderboard (week, exam_id) WHERE exam_id IS NOT NULL;


-- ==========================================================================
-- 005_leaderboard_user_id.sql
-- 排行榜連結 auth.users,顯示 legal_guardian 等徽章用
-- ==========================================================================

ALTER TABLE leaderboard
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_leaderboard_user
  ON leaderboard (user_id) WHERE user_id IS NOT NULL;


-- ==========================================================================
-- 完成。執行後到 Table Editor 應看到:
--   ai_explanations, ai_votes, deprecation_reports, user_achievements
--   leaderboard (加了 exam_id, user_id 兩欄)
-- ==========================================================================
