-- 020_reports_status.sql
-- 題目回報加上處理狀態，讓回報不再石沉大海。
--
-- 背景：reports 表原本只有回報內容，沒有任何欄位記錄「處理了沒／結論是什麼」，
-- 導致每次要盤點都得人工重讀一遍 Discord，也無法回覆回報者。
--
-- status 值：
--   pending   剛進來，還沒看（預設）
--   fixed     已修正題目資料
--   invalid   查證後題目沒問題（回報者誤會）
--   wontfix   確實有問題但不修（例如缺影片、考選部原卷就長這樣）
--   blocked   要修但缺原始資料（例如舊年度考選部卷抓不到）

ALTER TABLE reports
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS resolution text,          -- 處理結論，人看的
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz,
  ADD COLUMN IF NOT EXISTS commit_sha text;          -- 對應的修復 commit，方便回溯

-- 只有 pending 需要被撈出來處理，做成 partial index
CREATE INDEX IF NOT EXISTS reports_pending_idx
  ON reports (created_at DESC)
  WHERE status = 'pending';

-- 已知值約束（用 CHECK 而非 enum，之後要加值不用改型別）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'reports_status_check'
  ) THEN
    ALTER TABLE reports ADD CONSTRAINT reports_status_check
      CHECK (status IN ('pending', 'fixed', 'invalid', 'wontfix', 'blocked'));
  END IF;
END $$;
