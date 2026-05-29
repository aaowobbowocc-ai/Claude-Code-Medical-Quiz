-- 017_badges.sql
-- 徽章系統（Phase 1 Monetization 補強）— 單一 equip，顯示在名字旁
-- 顯示位置：Leaderboard、PvP 房間玩家卡（之後可擴充 profile 頁）
--
-- 30 顆徽章池：common 12 + rare 10 + epic 5 + limited 3

CREATE TABLE IF NOT EXISTS badges (
  id            text PRIMARY KEY,         -- 'night_owl' / 'iv_coffee'
  name          text NOT NULL,            -- 「夜貓子」
  description   text,                     -- 「凌晨 0-5 點答題的考生」
  tier          text NOT NULL,            -- common/rare/epic/limited
  icon          text NOT NULL,            -- emoji
  unlock_type   text NOT NULL,            -- 'coins' | 'admin'（achievement 之後再加）
  price_coins   integer DEFAULT 0,
  sort_order    integer DEFAULT 0,
  enabled       boolean DEFAULT true,
  created_at    timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_badges (
  user_id       uuid NOT NULL,
  badge_id      text NOT NULL REFERENCES badges(id),
  source        text NOT NULL,            -- 'purchase' | 'admin' | 'event'
  acquired_at   timestamptz DEFAULT now(),
  PRIMARY KEY (user_id, badge_id)
);

CREATE INDEX IF NOT EXISTS idx_user_badges_user ON user_badges(user_id);

-- 單一 equip：在 profiles 加一欄
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS equipped_badge_id text REFERENCES badges(id);

-- ── Seed：30 顆徽章 ─────────────────────────────────────────────────
INSERT INTO badges (id, name, description, tier, icon, unlock_type, price_coins, sort_order) VALUES
  -- common × 12（500-1000 幣，2-4 個廣告買得起）
  ('studious',       '用功型',       '每天都來刷題的好學生', 'common', '📚', 'coins', 500,  10),
  ('night_owl',      '夜貓子',       '凌晨 0-5 點愛讀書',   'common', '🌙', 'coins', 500,  11),
  ('caffeine',       '咖啡因依賴',   '沒咖啡不能讀書',     'common', '☕', 'coins', 800,  12),
  ('gamer_studier',  '邊讀邊玩',     '一邊滑手機一邊備考',   'common', '🎮', 'coins', 800,  13),
  ('no_sleep',       '三天沒睡',     '已經忘記睡覺是什麼',   'common', '🛌', 'coins', 1000, 14),
  ('sprinter',       '衝刺中',       '考前最後直線',        'common', '🚀', 'coins', 800,  15),
  ('zen',            '佛系考生',     '看開了，盡力就好',     'common', '🧘', 'coins', 500,  16),
  ('grinder',        '重複刷',       '同一題刷到會為止',     'common', '📌', 'coins', 800,  17),
  ('login_7day',     '七日連登',     '連續登入 7 天',       'common', '🔥', 'coins', 1000, 18),
  ('persistent',     '不放棄',       '失敗多次也要重來',     'common', '💪', 'coins', 800,  19),
  ('lunchbox',       '便當族',       '考試一定要吃便當',     'common', '🍙', 'coins', 500,  20),
  ('note_maniac',    '筆記狂',       '寫滿整本筆記本',       'common', '📝', 'coins', 800,  21),

  -- rare × 10（3000 幣，10 個廣告）
  ('sacred_tablet',  '神主牌守護',   '考場必帶神主牌',       'rare', '📿', 'coins', 3000, 30),
  ('iv_coffee',      'IV 咖啡',      '咖啡直接靜脈注射',     'rare', '💊', 'coins', 3000, 31),
  ('brain_overflow', '腦袋滿出來',   '裝太多知識溢出',       'rare', '🧠', 'coins', 3000, 32),
  ('osce_survivor',  'OSCE 倖存',    '從 OSCE 戰場活著回來', 'rare', '🙇', 'coins', 3000, 33),
  ('osce_warrior',   'OSCE 戰士',    '專業 OSCE 殺手',      'rare', '🦉', 'coins', 3000, 34),
  ('osce_speedrun',  'OSCE 速通',    'OSCE 一輪過',         'rare', '🏃', 'coins', 3000, 35),
  ('full_corpse',    '全屍',         '考完還有完整意識',     'rare', '💀', 'coins', 3000, 36),
  ('retake_king',    '補考王',       '熟悉每個補考流程',     'rare', '🥲', 'coins', 3000, 37),
  ('highlight_king', '重點王',       '螢光筆顏色超過 5 種',  'rare', '📐', 'coins', 3000, 38),
  ('self_torture',   '自虐狂',       '故意挑最難的科目刷',   'rare', '🤡', 'coins', 3000, 39),

  -- epic × 5（10000 幣 — 之後可改 achievement 解鎖）
  ('exam_god',       '考神附體',     '考運爆棚的傳奇',       'epic', '👑', 'coins', 10000, 50),
  ('perfect_95',     '全卷 95%+',    '單卷正確率 95% 以上', 'epic', '🏆', 'coins', 10000, 51),
  ('grind_1000',     '連刷 1000 題', '一次解 1000 題',     'epic', '📈', 'coins', 10000, 52),
  ('weak_savior',    '弱科救贖',     '弱項科目升到 80%',   'epic', '🎯', 'coins', 10000, 53),
  ('monthly_top',    '月榜第一',     '月排行榜冠軍',         'epic', '🥇', 'coins', 10000, 54),

  -- limited × 3（價格 0，admin/event 發放）
  ('graduate_2026',  '115 上岸',     '考過 115 年國考',     'limited', '🎓', 'admin', 0, 100),
  ('lunar_2027',     '2027 春節',    '2027 春節活動限定',   'limited', '🐉', 'admin', 0, 101),
  ('exam_season',    '考季限定',     '考季活動參與獎勵',     'limited', '🌸', 'admin', 0, 102)
ON CONFLICT (id) DO NOTHING;
