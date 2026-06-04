-- 對戰結果記錄（用於「我的數據」勝率/連勝統計）
-- 每場對戰結束時，為每個「有帳號(user_id)」的玩家寫一列。
-- AI 玩家、純訪客(無 user_id) 不記錄。
CREATE TABLE IF NOT EXISTS game_results (
  id            bigserial PRIMARY KEY,
  user_id       uuid NOT NULL,
  room_code     text,
  exam          text,
  score         int  DEFAULT 0,
  rank          int,            -- 1 = 第一名（含 AI 一起排名）
  total_players int,            -- 該場總人數（含 AI）
  won           boolean DEFAULT false,
  played_at     timestamptz DEFAULT now()
);

-- 查某人最近戰績（算勝率/連勝）用
CREATE INDEX IF NOT EXISTS idx_game_results_user_time
  ON game_results (user_id, played_at DESC);
