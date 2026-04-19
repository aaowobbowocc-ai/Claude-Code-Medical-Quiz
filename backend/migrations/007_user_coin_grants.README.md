# user_coin_grants — 單獨發放金幣

## 部署

在 Supabase SQL Editor 跑 `007_user_coin_grants.sql`（只跑一次）。

## 發放金幣給某個使用者

**Supabase Dashboard → Table Editor → user_coin_grants → Insert row**

| 欄位 | 填什麼 |
|---|---|
| `user_id` | 對方的 auth user id（UUID，可從 `profiles` 表查，或用 email 去 `auth.users` 查）|
| `coins` | 金額，正整數 |
| `reason` | 訊息內容，對方會看到。支援換行、emoji |
| `from_name` | 選填，署名。例：「站長」 |

其他欄位（`id` / `created_at` / `claimed_at`）留空，DB 會自動填。

## 查 user_id 的最快方法

對方若已綁 Google：
```sql
SELECT p.user_id, p.name, u.email
FROM profiles p JOIN auth.users u ON u.id = p.user_id
WHERE p.name ILIKE '%王小明%' OR u.email = 'xxx@gmail.com';
```

## 使用者端體驗

1. 對方下次登入（或當前已登入，下次頁面載入）→ 右上角彈出 Modal
2. Modal 顯示：🎁 + 金額 + reason 訊息 + 「領取」按鈕
3. 點領取 → 金幣入帳（本地 + Supabase profiles 雙寫） + 這筆 grant 標記 `claimed_at = now()`
4. 若有多筆未領，一次只彈一筆（按 `created_at` 最早先給）；領完下次載入再彈下一筆

## 安全性

- RLS：使用者只能讀/更新自己的 grant
- 使用者不能自己 INSERT（RLS 沒給 INSERT policy → 只有 service role 能寫）
- 使用者只能 UPDATE `claimed_at`（coins / reason / user_id 由 WITH CHECK 鎖定）
- 同一筆 grant 只能被領一次（UPDATE 條件 `claimed_at IS NULL`）

## 常見問題

**Q: 發了但對方沒看到？**
A: 確認對方已綁 Google（匿名帳號看不到）。可在 `user_coin_grants` 查 `claimed_at` 欄位，`NULL` = 未領。

**Q: 可以撤回嗎？**
A: 未領的可以 Dashboard 直接 DELETE。已領的錢已入帳，要撤回要另發一筆負數 grant（但目前 CHECK 限制 coins > 0，要撤回需手動改 profiles.coins — 但會被 write-through 蓋掉，不建議）。

**Q: 金幣會不會被 profiles 的 write-through 蓋掉？**
A: 不會。claim 流程用 `addCoins(n)` 做加法，然後觸發 profiles UPDATE — cloud 收到的是新 total，不是舊 total。
