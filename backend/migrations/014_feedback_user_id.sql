-- 在 feedback 表加 user_id 欄位，讓站內回饋能對應到實際帳號
-- (處理「金幣不見了」這類客服需要查帳號的情境)
ALTER TABLE feedback ADD COLUMN IF NOT EXISTS user_id UUID;

-- 加 index 方便依 user_id 查詢
CREATE INDEX IF NOT EXISTS feedback_user_id_idx ON feedback(user_id);
