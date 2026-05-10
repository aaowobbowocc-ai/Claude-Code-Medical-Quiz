-- 在 reports 表加 user_id 欄位（題目錯誤回報定位帳號）
ALTER TABLE reports ADD COLUMN IF NOT EXISTS user_id UUID;
CREATE INDEX IF NOT EXISTS reports_user_id_idx ON reports(user_id);
