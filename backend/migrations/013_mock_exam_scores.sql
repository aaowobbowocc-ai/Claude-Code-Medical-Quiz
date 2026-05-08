-- Mock exam score leaderboard.
--
-- 跟現有 leaderboard 不同：那個是每週分數總和，這個是「特定模擬考」的單場成績。
-- 例如：醫師一階 113年第一次 醫學(一) → 看誰拿最高分。
--
-- 一個使用者可在同一場考多次（取最高分），所以用 (user_id, exam_id, year,
-- session, paper_id) 當 dedup key。

CREATE TABLE IF NOT EXISTS mock_exam_scores (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  player_name TEXT NOT NULL,
  exam_id TEXT NOT NULL,           -- doctor1, lawyer1, etc
  year TEXT,                       -- '113' for historical mock; NULL for random
  session TEXT,                    -- '第一次' / '第二次' / NULL
  paper_id TEXT,                   -- 'paper1' / null for whole-exam
  paper_name TEXT,                 -- '醫學(一)' / '隨機模擬'
  score INTEGER NOT NULL CHECK (score >= 0),
  max_score INTEGER NOT NULL CHECK (max_score > 0),
  total_questions INTEGER NOT NULL,
  correct_questions INTEGER NOT NULL,
  duration_seconds INTEGER,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  device_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_mock_scores_paper_score
  ON mock_exam_scores (exam_id, year, session, paper_id, score DESC, completed_at DESC);

CREATE INDEX IF NOT EXISTS idx_mock_scores_user
  ON mock_exam_scores (user_id, completed_at DESC) WHERE user_id IS NOT NULL;

-- RLS: anyone can read top scores; INSERT only via authenticated user or service role.
ALTER TABLE mock_exam_scores ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "mock_scores_public_read" ON mock_exam_scores;
CREATE POLICY "mock_scores_public_read"
  ON mock_exam_scores FOR SELECT
  USING (true);

DROP POLICY IF EXISTS "mock_scores_owner_insert" ON mock_exam_scores;
CREATE POLICY "mock_scores_owner_insert"
  ON mock_exam_scores FOR INSERT
  WITH CHECK (auth.uid() = user_id OR user_id IS NULL);
