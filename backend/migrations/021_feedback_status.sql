-- 021_feedback_status.sql
-- 使用者回饋加上處理狀態。
--
-- 背景：reports（題目回報）在 020 已經有 status 了，但 feedback（功能建議／
-- 一般回饋）沒有。結果每次「處理一下回饋」都得把 112 筆從頭讀一遍，
-- 分不出哪些早就做過——實際上要靠翻 git log 找「上次處理到哪」才知道。
--
-- status 值（刻意與 reports 不同，回饋多是建議而非 bug）：
--   new       剛進來，還沒看（預設）
--   done      已處理（修了 bug、或做了這個功能）
--   planned   認同但排程未做
--   declined  決定不做（要在 resolution 寫原因）
--   duplicate 與其他回饋重複（在 resolution 寫指向哪一筆）
--   invalid   查證後不是問題

ALTER TABLE feedback
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'new',
  ADD COLUMN IF NOT EXISTS resolution text,          -- 處理結論，人看的
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz,
  ADD COLUMN IF NOT EXISTS commit_sha text;          -- 對應的 commit，方便回溯

-- 只有 new 需要被撈出來處理
CREATE INDEX IF NOT EXISTS feedback_new_idx
  ON feedback (created_at DESC)
  WHERE status = 'new';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'feedback_status_check'
  ) THEN
    ALTER TABLE feedback ADD CONSTRAINT feedback_status_check
      CHECK (status IN ('new', 'done', 'planned', 'declined', 'duplicate', 'invalid'));
  END IF;
END $$;
