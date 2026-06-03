# 街口支付正式環境切換 Checklist

街口 Leona 通常會用 Email 發正式環境憑證。收到後照這份 SOP 操作。

最近一次切換：**2026-06-03**（UAT → 正式）。

---

## 街口給的 5 個關鍵值

| 欄位 | 用途 |
|---|---|
| `Store-ID` | 正式環境店鋪識別 |
| `API KEY` | HTTP header `api-key` |
| `SECRET KEY` | HMAC-SHA256 簽章用 |
| **店家 IP** | 你 Oracle server 對外 IP（街口會擋這個白名單）|
| **API URL** | 正式 endpoint：`https://onlinepay.jkopay.com/platform/entry` 等 |

⚠️ **這 3 個 KEY 絕對不要 commit 進 git** — 只放 Oracle `.env`。

---

## Step 1：確認 Oracle 對外 IP 跟街口設的店家 IP 一致

```bash
ssh ubuntu@<oracle-public-ip>
curl -s ifconfig.me; echo
```

預期跟街口給的「店家 IP」一致。

❌ 不一致 → 回信街口請求更新白名單，**暫停後續所有步驟**

---

## Step 2：備份現有 `.env`

```bash
cd ~/examking-backend  # 視實際部署路徑調整
cp .env .env.uat.backup-$(date +%Y%m%d)
ls -la .env*
```

---

## Step 3：更新 `.env` 為正式環境值

```bash
nano .env
```

四個值替換：

```env
# 街口支付正式環境（2026-06-03 切換）
JKOS_API_HOST=https://onlinepay.jkopay.com
JKOS_API_KEY=<街口提供>
JKOS_SECRET_KEY=<街口提供>
JKOS_STORE_ID=<街口提供>
```

注意：
- `JKOS_API_HOST` **不含** `/platform/entry`（那是 path）
- 等號前後沒空格、值不加引號

---

## Step 4：callback IP 白名單

正式環境 callback IPs 已 hardcode 在 `backend/payment-jkos.js` 的 `JKOS_IP_ALLOWLIST`（不用設 env）。

未來街口臨時加 IP（罕見）才用 env var 補：

```env
JKOS_EXTRA_IPS=<新IP1>,<新IP2>
```

---

## Step 5：重啟 backend

PM2：
```bash
pm2 restart examking-backend
pm2 logs examking-backend --lines 30
```

systemd：
```bash
sudo systemctl restart examking-backend
sudo journalctl -u examking-backend -n 30
```

確認沒 `JKOS env vars not configured` 之類 error。

---

## Step 6：smoke test

```bash
curl -s https://api.examking.tw/api/health; echo
```

預期：`{"ok":true}` 或類似。

---

## Step 7：實測真實付款（會扣自己錢）

1. 無痕視窗開 `https://examking.tw`
2. 註冊或登入
3. 金幣商店 → 小額贊助 NT$15
4. 跳街口 → 用自己街口 App 付款
5. 回 examking → 金幣 +2000

### 排查表

| 症狀 | 看哪 | 可能原因 |
|---|---|---|
| 街口頁開不了 | 街口商家後台 | 店鋪未開通 |
| 付完金幣沒進 | `pm2 logs` 找 callback | IP 白名單失效 / inquiry 失敗 |
| Log 有 callback 但失敗 | 看 reject 訊息 | source IP 不在白名單 / amount mismatch |
| 金幣商店點不到 | 前端 console | 後端 endpoint 沒回 |

---

## Step 8：街口後台對帳

`https://merchant.jkos.com` → 訂單明細

確認：
- 訂單編號（platform_order_id）對得上 backend `coin_orders`
- 金額相符
- 狀態：付款成功

---

## Step 9：回信街口確認上線

確認 7+8 都過再回，模板見 [JKOS_PROD_REPLY_TEMPLATE.md](./JKOS_PROD_REPLY_TEMPLATE.md)。

---

## Step 10：退款收尾

街口後台 → 該訂單 → 發起退款 → 全額退。

---

## 回滾（如果正式有問題）

```bash
cp .env.uat.backup-YYYYMMDD .env
pm2 restart examking-backend
```

回信街口暫緩上線，繼續用 UAT。

---

## Code 層 (一次性) 設定

切換不需動 code，以下只在第一次接街口時做過：

- `backend/payment-jkos.js` — 三道防護（IP allowlist / inquiry / amount cross-check）
- `backend/server.js` — `app.set('trust proxy', 1)` 確保 callback IP 正確取
- `backend/migrations/` — `coin_orders` + `user_coin_grants` table
- `frontend/src/components/CoinShopSheet.jsx` — Web only（Android App 隱藏避 Play Policy）

---

## 安全提醒

1. **callback path 是 `/payment/jkos/callback`** — 沒有 auth，靠 3 道防護
2. **任何 `JKOS_*` env value 外洩** → 立即停 backend → 找街口 reset 整組 key
3. **退款只能透過街口後台** — backend 有 refund function 但沒對外 endpoint
