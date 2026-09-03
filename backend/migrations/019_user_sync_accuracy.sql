-- 019_user_sync_accuracy.sql
-- 跨裝置同步擴充：把「練習記錄（各科正確率）」也納入同步
-- （回饋 墨蓮 2026-09-01「電腦版沒有訓練資料」）
-- accuracy 存 accuracyStore 的 { data, sharedData, seen, seenShared }（同 localStorage quiz-accuracy-v1）
-- 套用：在 Supabase SQL Editor 直接執行本檔（僅加一欄，不影響現有資料）。

alter table user_sync add column if not exists accuracy jsonb;
