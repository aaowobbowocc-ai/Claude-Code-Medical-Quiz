# Fly.io 搬遷手冊

從 Render 搬到 Fly.io。整套流程約 30-40 分鐘。

## 一、準備（5 分鐘）

### 1. 安裝 Fly CLI

**Windows PowerShell（用 scoop 或直接下載）：**
```powershell
iwr https://fly.io/install.ps1 -useb | iex
```

或直接抓 binary: https://github.com/superfly/flyctl/releases/latest

### 2. 登入

```powershell
fly auth login
```
（瀏覽器會開，註冊一個帳號 — 用 GitHub 登入最快）

### 3. 加信用卡

Fly.io 有 free trial credit ($5)，但**deploy 之前必須加信用卡**（防 abuse）。
進 https://fly.io/dashboard → Billing → Add Payment Method。

**預估月費**：~$2-3 USD（512MB shared-cpu-1x，閒置自動停機）。

---

## 二、Launch（10 分鐘）

進 backend 目錄：
```powershell
cd C:\Users\USER\Desktop\國考知識\醫師知識王\backend
```

### 1. 第一次部署用 launch

```powershell
fly launch --no-deploy --copy-config --name examking-backend
```

`--copy-config` 表示用我已準備的 `fly.toml`，不要 Fly CLI 重新覆寫。
`--no-deploy` 先建好 app，下面設完 secrets 再 deploy。

如果它問你：
- App name? → `examking-backend`
- Region? → `nrt` (Tokyo)
- Postgres? → No
- Redis? → No
- Deploy now? → No

### 2. 設 Secrets（重要）

```powershell
fly secrets set `
  ANTHROPIC_API_KEY="sk-ant-api03-..." `
  GEMINI_API_KEY="AIzaSy..." `
  SUPABASE_URL="https://qgysdulvntuesoacdszo.supabase.co" `
  SUPABASE_KEY="sb_secret_x4-cU3SeGx5bxE-..." `
  R2_ACCOUNT_ID="31f08da69dafb79f8c00be4723482ad1" `
  R2_ACCESS_KEY_ID="bd7d81c83eb8070c5a997c4e937d4540" `
  R2_SECRET_ACCESS_KEY="a3f7e763dc05d63fe2238c0c4fc342990335f261b52f29ac0edbc50ebc00315f" `
  R2_BUCKET="examking-hazard-videos" `
  R2_PUBLIC_URL="https://pub-c6b3f9f30e5043dab124a6d5a2f70af2.r2.dev"
```

**還要從 Render Dashboard 複製這些**（local .env 沒有）：
- `DISCORD_WEBHOOK_URL` — 一般回饋通知
- `DISCORD_REPORT_WEBHOOK_URL` — 題目錯誤回報通知
- `FEEDBACK_ADMIN_KEY` — admin 查 feedback/reports 的 key
- `SENTRY_DSN` — Sentry error tracking
- `ADMIN_SECRET` — 其他 admin operations
- `JKOS_API_HOST`, `JKOS_API_KEY`, `JKOS_SECRET_KEY`, `JKOS_STORE_ID` — 街口支付（如有用）
- `BACKEND_BASE_URL` = `https://examking-backend.fly.dev`
- `FRONTEND_BASE_URL` = `https://examking.tw`

進 Render Dashboard → Service → Environment 全部複製過來，然後：
```powershell
fly secrets set `
  DISCORD_WEBHOOK_URL="..." `
  DISCORD_REPORT_WEBHOOK_URL="..." `
  FEEDBACK_ADMIN_KEY="..." `
  SENTRY_DSN="..." `
  ADMIN_SECRET="..." `
  BACKEND_BASE_URL="https://examking-backend.fly.dev" `
  FRONTEND_BASE_URL="https://examking.tw"
```

### 3. 第一次 Deploy

```powershell
fly deploy
```

預期：build ~2 分鐘，deploy ~1 分鐘。完成會印出 URL 像 `https://examking-backend.fly.dev`。

### 4. 確認啟動

```powershell
fly status
fly logs           # 看啟動 log
```

打 health check：
```powershell
curl https://examking-backend.fly.dev/health
# 預期 {"ok":true}
```

打一個業務 endpoint 確認資料載入：
```powershell
curl https://examking-backend.fly.dev/exam-registry
# 預期回傳 JSON 含 32 個考試
```

---

## 三、切換 Frontend（5 分鐘）

### 1. 改 Vercel 環境變數

進 https://vercel.com/dashboard → 你的 frontend project → Settings → Environment Variables：

把 `VITE_BACKEND_URL` 從：
```
https://claude-code-medical-quiz.onrender.com
```
改成：
```
https://examking-backend.fly.dev
```

### 2. Redeploy frontend

進 Vercel → Deployments → Redeploy（不需 push，Vercel 會用新 env 重 build）。

### 3. 驗證

打開 https://examking.tw，DevTools → Network，看 API call 是不是去 fly.dev：
- ✓ 練習題目能載入
- ✓ AI 解說能呼叫
- ✓ PvP 對戰能連 Socket.IO（最重要！Render 沒設過 Socket.IO 黏 session，Fly 預設 OK）
- ✓ 回饋/報告能送
- ✓ 金幣同步

---

## 四、後續（可選）

### Custom domain（如果要用 api.examking.tw）

```powershell
fly certs add api.examking.tw
```
然後在 Cloudflare DNS 加：
```
CNAME  api  examking-backend.fly.dev  proxied=OFF
```
（一定要 OFF，Cloudflare proxy 會破壞 Socket.IO websocket）

### CI/CD

Fly.io 不像 Render 自動 deploy on push。可以加 GitHub Action：

`.github/workflows/fly-deploy.yml`:
```yaml
name: Fly Deploy
on:
  push:
    branches: [master]
    paths:
      - 'backend/**'
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: superfly/flyctl-actions/setup-flyctl@master
      - run: flyctl deploy --remote-only
        working-directory: backend
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
```
然後 `fly tokens create deploy` 拿 token，加到 GitHub Secrets `FLY_API_TOKEN`。

---

## 五、停掉 Render（驗證新平台後）

確認 Fly 跑穩 1-2 天無異常後：
1. Render Dashboard → Service → Settings → 改 auto-deploy → off
2. 或直接 Suspend service（保留 config 以防需要 rollback）
3. 完全 OK 之後再 Delete

**保留 Render config 的好處**：未來如果 Fly 出狀況，可以快速切回。

---

## 六、Rollback（如果出事）

把 Vercel 的 `VITE_BACKEND_URL` 改回 Render URL，redeploy。
Render service 還活著（只是 deploy 卡住），存量服務還能用。

---

## 已知差異 / 注意事項

| 項目 | Render | Fly.io |
|------|--------|--------|
| 自動 deploy on push | ✓ | 需要 GitHub Action |
| Cold start | 5-10 秒 | 1-2 秒 |
| Socket.IO sticky session | 自動 | 自動 |
| 持久磁碟 | 付費 | 付費 |
| 環境變數寫法 | Dashboard UI | `fly secrets set` |
| Logs | Dashboard | `fly logs` 或 Dashboard |
| 收費 | $7/月 起，build minutes 限制 | ~$2-3/月（閒置自動停機）|

### 不會搞砸的東西
- Supabase 連線（用 SUPABASE_URL/KEY，跟平台無關）
- R2 storage（同上）
- 題庫 JSON（在 image 裡）

### 可能要注意
- Socket.IO websocket：Fly proxy 預設支援，無需特別設定
- CORS：server.js 已用 `cors({ origin: true })`，無變動
- Cloudflare 在前面要 proxy=OFF（不然 Socket.IO 走不通）
