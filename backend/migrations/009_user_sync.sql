-- 009_user_sync.sql
-- 跨裝置同步：錯題夾 + 收藏題目（回饋 CZY「手機跟平板沒有同步」）
-- 只同步「登入使用者」；訪客維持本機 localStorage。
-- 金幣/名稱等仍走 profiles，本表只放使用者自己的練習資料。
--
-- 套用：在 Supabase SQL Editor 直接執行本檔。

create table if not exists user_sync (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  wrong_bank jsonb not null default '[]'::jsonb,   -- 錯題夾陣列（同 localStorage 結構）
  bookmarks  jsonb,                                 -- 收藏 { folders, questions }
  updated_at timestamptz not null default now()
);

alter table user_sync enable row level security;

-- 每位使用者只能讀寫自己的那一列
drop policy if exists user_sync_select_own on user_sync;
create policy user_sync_select_own on user_sync
  for select using (auth.uid() = user_id);

drop policy if exists user_sync_insert_own on user_sync;
create policy user_sync_insert_own on user_sync
  for insert with check (auth.uid() = user_id);

drop policy if exists user_sync_update_own on user_sync;
create policy user_sync_update_own on user_sync
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
