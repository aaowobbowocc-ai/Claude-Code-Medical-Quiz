-- 016_avatar_png_pack.sql
-- 動物擬人 PNG 頭像第一批（chibi 水彩風）— MVP 7 隻
-- 賣得好再批量生剩下 23 隻
--
-- 圖檔位於 frontend/public/avatars/png/，serve 自 /avatars/png/*.png
-- is_image=true 時 icon 欄位存 URL（不存 emoji）

INSERT INTO avatars (id, name, tier, price_coins, price_ntd, icon, is_image, sort_order) VALUES
  -- common（1 個廣告 300 幣，common 5 個廣告買得起）
  ('animal_hamster',  '倉鼠學生', 'common', 1000, 0, '/avatars/png/animal-hamster.png',  true, 50),
  ('animal_otter',    '海獺醫師', 'common', 1500, 0, '/avatars/png/animal-otter.png',    true, 51),
  ('animal_penguin',  '企鵝藥師', 'common', 1500, 0, '/avatars/png/animal-penguin.png',  true, 52),
  ('animal_cat',      '橘貓護理師', 'common', 1500, 0, '/avatars/png/animal-cat.png',    true, 53),
  -- rare（10 個廣告）
  ('animal_shiba',    '柴犬畢業生', 'rare', 3000, 0, '/avatars/png/animal-shiba.png',   true, 60),
  ('animal_capybara', '水豚中醫',   'rare', 3000, 0, '/avatars/png/animal-capybara.png', true, 61),
  ('animal_panda',    '熊貓律師',   'rare', 3000, 0, '/avatars/png/animal-panda.png',   true, 62)
ON CONFLICT (id) DO NOTHING;
