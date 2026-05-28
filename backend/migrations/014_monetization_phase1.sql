-- 2026-05-28: Phase 1 monetization 功能 (邊框 / AI 無限 / 頭像 / 感謝榜)
-- 全部 schema 一次建好，搭配 frontend feature flag，先建表不啟用功能。
--
-- 執行方式：複製整段到 Supabase SQL Editor → Run

-- ─── 1. 邊框 / Frames ─────────────────────────────────────────────────
-- 邊框 catalog（管理員預先 INSERT）
CREATE TABLE IF NOT EXISTS frames (
  id            text PRIMARY KEY,            -- 例：'gold', 'rainbow'
  name          text NOT NULL,                -- 顯示名稱「黃金邊框」
  tier          text NOT NULL,                -- 'common'/'rare'/'epic'/'legendary'
  price_coins   integer DEFAULT 0,            -- 金幣價，0 = 不能用金幣買
  price_ntd     integer DEFAULT 0,            -- 新台幣價，0 = 不賣 NTD
  css_class     text NOT NULL,                -- frontend CSS class name
  is_animated   boolean DEFAULT false,
  sort_order    integer DEFAULT 0,
  created_at    timestamptz DEFAULT now()
);

-- 使用者擁有的邊框
CREATE TABLE IF NOT EXISTS user_frames (
  user_id       uuid NOT NULL,
  frame_id      text NOT NULL REFERENCES frames(id),
  source        text NOT NULL,                -- 'coins'/'ntd'/'admin_grant'/'event'
  acquired_at   timestamptz DEFAULT now(),
  PRIMARY KEY (user_id, frame_id)
);

-- profiles 加裝備的邊框 ID
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS equipped_frame_id text REFERENCES frames(id);

CREATE INDEX IF NOT EXISTS idx_user_frames_user ON user_frames(user_id);

-- ─── 2. AI 解說無限包 / AI Unlimited ─────────────────────────────────
-- profiles 加「無限到期時間」timestamp（NULL = 沒買，> now() = 有效）
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS ai_unlimited_until timestamptz;

-- 購買紀錄（也記 freelifetime: 用 ai_unlimited_until = '2099-12-31' 表示永久）
CREATE TABLE IF NOT EXISTS ai_unlimited_purchases (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL,
  package_id    text NOT NULL,                -- '7day'/'30day'/'lifetime'
  duration_days integer,                       -- 對應的天數，lifetime 用 NULL
  amount_ntd    integer NOT NULL,
  payment_method text,                         -- 'ecpay'/'admin_grant'
  payment_ref   text,                          -- 對應的金流訂單編號
  granted_at    timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_unlimited_user ON ai_unlimited_purchases(user_id);

-- ─── 3. 頭像 / Avatars ─────────────────────────────────────────────────
-- 注意：profiles.avatar 已存在（目前是 emoji 字串）
-- 改成支援「avatar id 索引到 avatars table」OR「直接 emoji」（向下相容）
CREATE TABLE IF NOT EXISTS avatars (
  id            text PRIMARY KEY,            -- 'doctor_q' / 'easter_2026'
  name          text NOT NULL,                -- 「Q 版醫師」
  tier          text NOT NULL,                -- 'free'/'common'/'rare'/'limited'
  price_coins   integer DEFAULT 0,
  price_ntd     integer DEFAULT 0,
  icon          text NOT NULL,                -- emoji 或圖片 URL
  is_image      boolean DEFAULT false,        -- true = icon 是 URL
  sort_order    integer DEFAULT 0,
  created_at    timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_avatars (
  user_id       uuid NOT NULL,
  avatar_id     text NOT NULL REFERENCES avatars(id),
  source        text NOT NULL,                -- 'free'/'coins'/'ntd'/'admin_grant'
  acquired_at   timestamptz DEFAULT now(),
  PRIMARY KEY (user_id, avatar_id)
);

CREATE INDEX IF NOT EXISTS idx_user_avatars_user ON user_avatars(user_id);

-- ─── 4. 感謝榜 / Sponsor Wall ────────────────────────────────────────
-- 每筆贊助一行（不論金幣/NTD，但這張表主要記 NTD 贊助）
CREATE TABLE IF NOT EXISTS sponsors (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid,                          -- 可 NULL（不綁帳號的純贊助）
  display_name  text NOT NULL,                 -- 顯示名稱
  amount_ntd    integer NOT NULL,
  tier          text NOT NULL,                 -- 'coffee'/'meal'/'dinner'/'gold'/'diamond'
  anonymous     boolean DEFAULT false,
  message       text,                          -- 贊助訊息 (gold/diamond 才有)
  payment_method text,                          -- 'ecpay'/'jkopay'/'admin'
  payment_ref   text,
  created_at    timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sponsors_amount ON sponsors(amount_ntd DESC);
CREATE INDEX IF NOT EXISTS idx_sponsors_user ON sponsors(user_id);

-- ─── 5. 預先 INSERT catalog 資料 ──────────────────────────────────────

-- 邊框 catalog（CSS class 對應 frontend/src/styles/frames.css）
INSERT INTO frames (id, name, tier, price_coins, price_ntd, css_class, is_animated, sort_order) VALUES
  ('none',      '無邊框',       'free',      0,     0,   'frame-none',      false, 0),
  ('bronze',    '青銅邊框',     'common',    500,   0,   'frame-bronze',    false, 10),
  ('silver',    '白銀邊框',     'common',    2000,  0,   'frame-silver',    false, 20),
  ('gold',      '黃金邊框',     'rare',      8000,  0,   'frame-gold',      false, 30),
  ('diamond',   '鑽石邊框',     'epic',      30000, 0,   'frame-diamond',   false, 40),
  ('rainbow',   '彩虹動畫框',   'legendary', 0,     150, 'frame-rainbow',   true,  50),
  ('lunar2027', '新年限定金框', 'limited',   0,     0,   'frame-lunar2027', true,  60)
ON CONFLICT (id) DO NOTHING;

-- 頭像 catalog（暫先放預設 emoji，後續加自訂插畫）
INSERT INTO avatars (id, name, tier, price_coins, price_ntd, icon, is_image, sort_order) VALUES
  ('default_male',    '預設男醫師',   'free', 0, 0, '👨‍⚕️', false, 0),
  ('default_female',  '預設女醫師',   'free', 0, 0, '👩‍⚕️', false, 1),
  ('scientist',       '科學家',       'free', 0, 0, '🧑‍🔬', false, 2),
  ('graduate',        '畢業生',       'free', 0, 0, '🧑‍🎓', false, 3),
  ('nurse',           '護理師',       'free', 0, 0, '🧑‍⚕️', false, 4),
  ('pharmacist',      '藥劑師',       'free', 0, 0, '💊', false, 5),
  -- 付費限定
  ('crown_doctor',    '冠軍醫師',     'rare',   3000, 0,   '👑', false, 100),
  ('superhero',       '超級英雄',     'rare',   5000, 0,   '🦸', false, 101),
  ('ninja',           '忍者醫師',     'epic',   10000, 0,  '🥷', false, 110),
  -- 限定（暫不開放）
  ('lunar2027',       '新年限定',     'limited', 0, 50, '🧧', false, 200)
ON CONFLICT (id) DO NOTHING;

-- ─── 完成。下一步：在 Supabase 開啟 RLS（若有需要）─────────────────────
-- 暫時不開 RLS（讀取走 backend service-role key，寫入也是 backend 驗證後做）
