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
-- 006_claimed_rewards.sql
-- profiles.claimed_rewards: 防 changelog reward 跨裝置重領
-- ==========================================================================

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS claimed_rewards TEXT[] DEFAULT '{}';


-- ==========================================================================
-- 007_user_coin_grants.sql
-- 站長手動寄金幣的個人通知 (Admin 發放 → User claim → addCoins)
-- ==========================================================================

CREATE TABLE IF NOT EXISTS user_coin_grants (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  coins INTEGER NOT NULL CHECK (coins > 0),
  reason TEXT NOT NULL,
  from_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_user_coin_grants_unclaimed
  ON user_coin_grants (user_id) WHERE claimed_at IS NULL;

ALTER TABLE user_coin_grants ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_coin_grants_owner_read" ON user_coin_grants;
CREATE POLICY "user_coin_grants_owner_read"
  ON user_coin_grants FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "user_coin_grants_owner_claim" ON user_coin_grants;
CREATE POLICY "user_coin_grants_owner_claim"
  ON user_coin_grants FOR UPDATE
  USING (auth.uid() = user_id AND claimed_at IS NULL)
  WITH CHECK (auth.uid() = user_id);


-- ==========================================================================
-- 008_site_stats.sql
-- 持久化 server in-memory stats (Render free-tier FS 不穩,5 分鐘 snapshot 一次)
-- ==========================================================================

CREATE TABLE IF NOT EXISTS site_stats (
  key TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE site_stats ENABLE ROW LEVEL SECURITY;
-- 不開 public policy; 只有 backend service-role 讀寫。


-- ==========================================================================
-- 009_rag_schema.sql
-- 醫學/法律 RAG 知識庫 (Vertex AI text-embedding-004,768 維)
-- ==========================================================================

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS rag_documents (
  id          BIGSERIAL PRIMARY KEY,
  source      TEXT NOT NULL,
  url         TEXT NOT NULL,
  title       TEXT,
  language    TEXT,
  category    TEXT,
  content     TEXT,
  tokens      INT,
  metadata    JSONB,
  fetched_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(source, url)
);

CREATE INDEX IF NOT EXISTS rag_documents_source_idx   ON rag_documents (source);
CREATE INDEX IF NOT EXISTS rag_documents_language_idx ON rag_documents (language);
CREATE INDEX IF NOT EXISTS rag_documents_category_idx ON rag_documents (category);

CREATE TABLE IF NOT EXISTS rag_chunks (
  id            BIGSERIAL PRIMARY KEY,
  document_id   BIGINT REFERENCES rag_documents(id) ON DELETE CASCADE,
  chunk_index   INT NOT NULL,
  content       TEXT NOT NULL,
  embedding     vector(768),
  tokens        INT,
  metadata      JSONB,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS rag_chunks_document_id_idx ON rag_chunks (document_id);
-- 注意：ivfflat index 已被 010 取代為 hnsw（見下方），這裡先不建。

CREATE OR REPLACE FUNCTION rag_match_chunks(
  query_embedding vector(768),
  match_threshold float DEFAULT 0.5,
  match_count     int   DEFAULT 5,
  language_filter text  DEFAULT NULL
)
RETURNS TABLE (
  id           BIGINT,
  document_id  BIGINT,
  content      TEXT,
  metadata     JSONB,
  similarity   float
)
LANGUAGE sql STABLE AS $$
  SELECT
    c.id,
    c.document_id,
    c.content,
    c.metadata,
    1 - (c.embedding <=> query_embedding) AS similarity
  FROM rag_chunks c
  LEFT JOIN rag_documents d ON d.id = c.document_id
  WHERE
    c.embedding IS NOT NULL
    AND (language_filter IS NULL OR d.language = language_filter)
    AND 1 - (c.embedding <=> query_embedding) > match_threshold
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
$$;


-- ==========================================================================
-- 010_rag_fix_index.sql
-- ivfflat 在空表建會 centroids 亂跑;換 hnsw (pgvector ≥0.5 推薦)
-- ==========================================================================

DROP INDEX IF EXISTS rag_chunks_embedding_idx;

CREATE INDEX IF NOT EXISTS rag_chunks_embedding_idx
  ON rag_chunks
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

ANALYZE rag_chunks;


-- ==========================================================================
-- 011_explanation_unlocks.sql
-- 個人付費解鎖 AI 解說 (跨裝置)
-- ==========================================================================

CREATE TABLE IF NOT EXISTS user_explanation_unlocks (
  user_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  exam_id TEXT,
  paid_amount INTEGER NOT NULL DEFAULT 0,
  unlocked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, question_id)
);

CREATE INDEX IF NOT EXISTS idx_user_explanation_unlocks_user
  ON user_explanation_unlocks (user_id);

ALTER TABLE user_explanation_unlocks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users read own unlocks" ON user_explanation_unlocks;
CREATE POLICY "users read own unlocks"
  ON user_explanation_unlocks
  FOR SELECT
  USING (auth.uid()::text = user_id);


-- ==========================================================================
-- 012_coin_orders.sql
-- 街口/JKOPay 等金流訂單記帳 (immutable financial ledger)
-- ==========================================================================

CREATE TABLE IF NOT EXISTS coin_orders (
  id BIGSERIAL PRIMARY KEY,
  order_id TEXT UNIQUE NOT NULL,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  device_id TEXT,
  provider TEXT NOT NULL DEFAULT 'jkos',
  tier TEXT NOT NULL,
  amount_twd INTEGER NOT NULL CHECK (amount_twd > 0),
  coins INTEGER NOT NULL CHECK (coins > 0),
  status TEXT NOT NULL DEFAULT 'pending',
  provider_order_id TEXT,
  payment_url TEXT,
  paid_at TIMESTAMPTZ,
  refunded_at TIMESTAMPTZ,
  refund_reason TEXT,
  raw_callback JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_status CHECK (status IN ('pending','paid','failed','refunded','expired'))
);

CREATE INDEX IF NOT EXISTS idx_coin_orders_user ON coin_orders(user_id);
CREATE INDEX IF NOT EXISTS idx_coin_orders_status ON coin_orders(status);
CREATE INDEX IF NOT EXISTS idx_coin_orders_provider_order ON coin_orders(provider_order_id);

ALTER TABLE coin_orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "coin_orders_owner_read" ON coin_orders;
CREATE POLICY "coin_orders_owner_read"
  ON coin_orders FOR SELECT
  USING (auth.uid() = user_id);


-- ==========================================================================
-- 013_mock_exam_scores.sql
-- 模擬考單場高分榜 (跟週榜 leaderboard 區別)
-- ==========================================================================

CREATE TABLE IF NOT EXISTS mock_exam_scores (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  player_name TEXT NOT NULL,
  exam_id TEXT NOT NULL,
  year TEXT,
  session TEXT,
  paper_id TEXT,
  paper_name TEXT,
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

ALTER TABLE mock_exam_scores ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "mock_scores_public_read" ON mock_exam_scores;
CREATE POLICY "mock_scores_public_read"
  ON mock_exam_scores FOR SELECT
  USING (true);

DROP POLICY IF EXISTS "mock_scores_owner_insert" ON mock_exam_scores;
CREATE POLICY "mock_scores_owner_insert"
  ON mock_exam_scores FOR INSERT
  WITH CHECK (auth.uid() = user_id OR user_id IS NULL);


-- ==========================================================================
-- 014_feedback_user_id.sql
-- feedback 加 user_id 對應帳號 (查「金幣不見了」這類客服)
-- ==========================================================================

ALTER TABLE feedback ADD COLUMN IF NOT EXISTS user_id UUID;
CREATE INDEX IF NOT EXISTS feedback_user_id_idx ON feedback(user_id);


-- ==========================================================================
-- 014_monetization_phase1.sql
-- Phase 1 商業化: 邊框 / AI 無限 / 頭像 / 感謝榜 schema + seed
-- ==========================================================================

-- ─── 1. 邊框 / Frames ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS frames (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  tier          text NOT NULL,
  price_coins   integer DEFAULT 0,
  price_ntd     integer DEFAULT 0,
  css_class     text NOT NULL,
  is_animated   boolean DEFAULT false,
  sort_order    integer DEFAULT 0,
  created_at    timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_frames (
  user_id       uuid NOT NULL,
  frame_id      text NOT NULL REFERENCES frames(id),
  source        text NOT NULL,
  acquired_at   timestamptz DEFAULT now(),
  PRIMARY KEY (user_id, frame_id)
);

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS equipped_frame_id text REFERENCES frames(id);

CREATE INDEX IF NOT EXISTS idx_user_frames_user ON user_frames(user_id);

-- ─── 2. AI 解說無限包 ───────────────────────────────────────────────
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS ai_unlimited_until timestamptz;

CREATE TABLE IF NOT EXISTS ai_unlimited_purchases (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL,
  package_id    text NOT NULL,
  duration_days integer,
  amount_ntd    integer NOT NULL,
  payment_method text,
  payment_ref   text,
  granted_at    timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_unlimited_user ON ai_unlimited_purchases(user_id);

-- ─── 3. 頭像 ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS avatars (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  tier          text NOT NULL,
  price_coins   integer DEFAULT 0,
  price_ntd     integer DEFAULT 0,
  icon          text NOT NULL,
  is_image      boolean DEFAULT false,
  sort_order    integer DEFAULT 0,
  created_at    timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_avatars (
  user_id       uuid NOT NULL,
  avatar_id     text NOT NULL REFERENCES avatars(id),
  source        text NOT NULL,
  acquired_at   timestamptz DEFAULT now(),
  PRIMARY KEY (user_id, avatar_id)
);

CREATE INDEX IF NOT EXISTS idx_user_avatars_user ON user_avatars(user_id);

-- ─── 4. 感謝榜 ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sponsors (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid,
  display_name  text NOT NULL,
  amount_ntd    integer NOT NULL,
  tier          text NOT NULL,
  anonymous     boolean DEFAULT false,
  message       text,
  payment_method text,
  payment_ref   text,
  created_at    timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sponsors_amount ON sponsors(amount_ntd DESC);
CREATE INDEX IF NOT EXISTS idx_sponsors_user ON sponsors(user_id);

-- ─── 5. seed catalog ────────────────────────────────────────────────
INSERT INTO frames (id, name, tier, price_coins, price_ntd, css_class, is_animated, sort_order) VALUES
  ('none',      '無邊框',       'free',      0,     0,   'frame-none',      false, 0),
  ('bronze',    '青銅邊框',     'common',    500,   0,   'frame-bronze',    false, 10),
  ('silver',    '白銀邊框',     'common',    2000,  0,   'frame-silver',    false, 20),
  ('gold',      '黃金邊框',     'rare',      8000,  0,   'frame-gold',      false, 30),
  ('diamond',   '鑽石邊框',     'epic',      30000, 0,   'frame-diamond',   false, 40),
  ('rainbow',   '彩虹動畫框',   'legendary', 0,     150, 'frame-rainbow',   true,  50),
  ('lunar2027', '新年限定金框', 'limited',   0,     0,   'frame-lunar2027', true,  60)
ON CONFLICT (id) DO NOTHING;

INSERT INTO avatars (id, name, tier, price_coins, price_ntd, icon, is_image, sort_order) VALUES
  ('default_male',    '預設男醫師',   'free', 0, 0, '👨‍⚕️', false, 0),
  ('default_female',  '預設女醫師',   'free', 0, 0, '👩‍⚕️', false, 1),
  ('scientist',       '科學家',       'free', 0, 0, '🧑‍🔬', false, 2),
  ('graduate',        '畢業生',       'free', 0, 0, '🧑‍🎓', false, 3),
  ('nurse',           '護理師',       'free', 0, 0, '🧑‍⚕️', false, 4),
  ('pharmacist',      '藥劑師',       'free', 0, 0, '💊', false, 5),
  ('crown_doctor',    '冠軍醫師',     'rare',   3000, 0,   '👑', false, 100),
  ('superhero',       '超級英雄',     'rare',   5000, 0,   '🦸', false, 101),
  ('ninja',           '忍者醫師',     'epic',   10000, 0,  '🥷', false, 110),
  ('lunar2027',       '新年限定',     'limited', 0, 50, '🧧', false, 200)
ON CONFLICT (id) DO NOTHING;


-- ==========================================================================
-- 015_reports_user_id.sql
-- reports (題目錯誤回報) 加 user_id
-- ==========================================================================

ALTER TABLE reports ADD COLUMN IF NOT EXISTS user_id UUID;
CREATE INDEX IF NOT EXISTS reports_user_id_idx ON reports(user_id);


-- ==========================================================================
-- 016_avatar_png_pack.sql
-- 動物擬人 PNG 頭像第一批 (chibi 水彩風,7 隻)
-- ==========================================================================

INSERT INTO avatars (id, name, tier, price_coins, price_ntd, icon, is_image, sort_order) VALUES
  ('animal_hamster',  '倉鼠學生',     'common', 1000, 0, '/avatars/png/animal-hamster.png',  true, 50),
  ('animal_otter',    '海獺醫師',     'common', 1500, 0, '/avatars/png/animal-otter.png',    true, 51),
  ('animal_penguin',  '企鵝藥師',     'common', 1500, 0, '/avatars/png/animal-penguin.png',  true, 52),
  ('animal_cat',      '橘貓護理師',   'common', 1500, 0, '/avatars/png/animal-cat.png',      true, 53),
  ('animal_shiba',    '柴犬畢業生',   'rare',   3000, 0, '/avatars/png/animal-shiba.png',    true, 60),
  ('animal_capybara', '水豚中醫',     'rare',   3000, 0, '/avatars/png/animal-capybara.png', true, 61),
  ('animal_panda',    '熊貓律師',     'rare',   3000, 0, '/avatars/png/animal-panda.png',    true, 62)
ON CONFLICT (id) DO NOTHING;


-- ==========================================================================
-- 017_badges.sql
-- 徽章系統 (Leaderboard / PvP 房間顯示在名字旁) — 30 顆 emoji 徽章
-- ==========================================================================

CREATE TABLE IF NOT EXISTS badges (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  description   text,
  tier          text NOT NULL,
  icon          text NOT NULL,
  unlock_type   text NOT NULL,
  price_coins   integer DEFAULT 0,
  sort_order    integer DEFAULT 0,
  enabled       boolean DEFAULT true,
  created_at    timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_badges (
  user_id       uuid NOT NULL,
  badge_id      text NOT NULL REFERENCES badges(id),
  source        text NOT NULL,
  acquired_at   timestamptz DEFAULT now(),
  PRIMARY KEY (user_id, badge_id)
);

CREATE INDEX IF NOT EXISTS idx_user_badges_user ON user_badges(user_id);

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS equipped_badge_id text REFERENCES badges(id);

INSERT INTO badges (id, name, description, tier, icon, unlock_type, price_coins, sort_order) VALUES
  -- common × 12
  ('studious',       '用功型',       '每天都來刷題的好學生', 'common', '📚', 'coins', 500,  10),
  ('night_owl',      '夜貓子',       '凌晨 0-5 點愛讀書',   'common', '🌙', 'coins', 500,  11),
  ('caffeine',       '咖啡因依賴',   '沒咖啡不能讀書',       'common', '☕', 'coins', 800,  12),
  ('gamer_studier',  '邊讀邊玩',     '一邊滑手機一邊備考',   'common', '🎮', 'coins', 800,  13),
  ('no_sleep',       '三天沒睡',     '已經忘記睡覺是什麼',   'common', '🛌', 'coins', 1000, 14),
  ('sprinter',       '衝刺中',       '考前最後直線',         'common', '🚀', 'coins', 800,  15),
  ('zen',            '佛系考生',     '看開了,盡力就好',     'common', '🧘', 'coins', 500,  16),
  ('grinder',        '重複刷',       '同一題刷到會為止',     'common', '📌', 'coins', 800,  17),
  ('login_7day',     '七日連登',     '連續登入 7 天',       'common', '🔥', 'coins', 1000, 18),
  ('persistent',     '不放棄',       '失敗多次也要重來',     'common', '💪', 'coins', 800,  19),
  ('lunchbox',       '便當族',       '考試一定要吃便當',     'common', '🍙', 'coins', 500,  20),
  ('note_maniac',    '筆記狂',       '寫滿整本筆記本',       'common', '📝', 'coins', 800,  21),
  -- rare × 10
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
  -- epic × 5
  ('exam_god',       '考神附體',     '考運爆棚的傳奇',       'epic', '👑', 'coins', 10000, 50),
  ('perfect_95',     '全卷 95%+',    '單卷正確率 95% 以上', 'epic', '🏆', 'coins', 10000, 51),
  ('grind_1000',     '連刷 1000 題', '一次解 1000 題',     'epic', '📈', 'coins', 10000, 52),
  ('weak_savior',    '弱科救贖',     '弱項科目升到 80%',   'epic', '🎯', 'coins', 10000, 53),
  ('monthly_top',    '月榜第一',     '月排行榜冠軍',         'epic', '🥇', 'coins', 10000, 54),
  -- limited × 3
  ('graduate_2026',  '115 上岸',     '考過 115 年國考',     'limited', '🎓', 'admin', 0, 100),
  ('lunar_2027',     '2027 春節',    '2027 春節活動限定',   'limited', '🐉', 'admin', 0, 101),
  ('exam_season',    '考季限定',     '考季活動參與獎勵',     'limited', '🌸', 'admin', 0, 102)
ON CONFLICT (id) DO NOTHING;


-- ==========================================================================
-- 完成。執行後到 Table Editor 應看到:
--   核心：ai_explanations / ai_votes / deprecation_reports / user_achievements
--   leaderboard 加了 exam_id + user_id 兩欄
--   profiles 加了 claimed_rewards / equipped_frame_id / ai_unlimited_until /
--                  equipped_badge_id 四欄
--   feedback / reports 各加了 user_id 一欄
--   金流：user_coin_grants / coin_orders
--   stats：site_stats / mock_exam_scores
--   RAG：rag_documents / rag_chunks (+ hnsw index + rag_match_chunks RPC)
--   付費解鎖：user_explanation_unlocks
--   Phase 1：frames / user_frames / ai_unlimited_purchases /
--                avatars / user_avatars / sponsors / badges / user_badges
-- ==========================================================================
