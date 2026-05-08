# Oracle Cloud Always Free — Backend 部署指南

把 backend 從 Render 搬到 Oracle Cloud Always Free（永久免費 ARM VM 24GB RAM + 4 OCPU + 固定公開 IP）。

預估完成時間：1.5-2 小時（首次申請帳號 + 建 VM 較久；後續更新只要一行指令）。

---

## 階段 0：申請 Oracle Cloud 帳號（30 分鐘）

1. 開 https://www.oracle.com/cloud/free/
2. 點「Start for free」→ 填申請表（用 Gmail 等真實信箱）
3. **手機驗證** + **信用卡驗證**（不會扣款，純身分驗證；有 1 USD 預授權後退）
4. **重要**：選 Home Region 時選 **Tokyo (ap-tokyo-1)** 或 **Osaka (ap-osaka-1)**（離台灣最近 + ARM 容量較穩）
5. 信箱收到啟用信，登入 https://cloud.oracle.com/

---

## 階段 1：建立 ARM VM（20 分鐘）

### 1.1 建立 Compute Instance

1. 左上漢堡 → **Compute** → **Instances** → **Create Instance**
2. 設定：
   - **Name**: `examking-backend`
   - **Image**: 點 Edit → **Ubuntu 22.04** (Canonical)
   - **Shape**: 點 Change Shape → **Ampere** (ARM) →
     - Shape: `VM.Standard.A1.Flex`
     - **OCPUs: 2**, **Memory: 12 GB**（在免費額度 4 OCPU / 24GB 內）
   - **Network**:
     - 預設新建 VCN（虛擬網路）即可
     - **Public IPv4 address: ✅ Assign a public IPv4 address**
   - **SSH keys**:
     - 選 **Generate a key pair for me** → 下載 private key + public key 存好（之後 SSH 用）
3. 點 **Create**

### 1.2 ⚠️ 容量不足怎麼辦

ARM Ampere 名額熱門，常顯示 "Out of capacity"。處理方式：
- 切換 region（左上 region selector → 選 Osaka 或 Seoul 重試）
- 或寫個腳本每 5 分鐘自動重試（Google "Oracle Cloud A1 capacity script"）

如果完全搶不到，降級用 AMD：
- Shape: `VM.Standard.E2.1.Micro`（1 GB RAM，免費 2 台）
- 1 GB 對你 backend 偏緊但仍可跑

### 1.3 預留固定 IP（避免 VM 重啟換 IP）

1. 左上漢堡 → **Networking** → **Reserved IPs** → **Reserve Public IP Address**
2. **Compartment**: 選自己的 → **Name**: `examking-static`
3. 建立後，到 VM 詳情頁 → **Attached VNICs** → 點 vnic → **IP Addresses** → **Edit Public IP** → 改用 Reserved
4. **記下這個 IP**（給街口用 + DNS 設定用）

### 1.4 開放網路（放行 80/443 port）

VCN 預設只開 22 (SSH)，要手動加 80/443：

1. 左上漢堡 → **Networking** → **Virtual Cloud Networks** → 點你的 VCN
2. 點 **Subnets** → 點預設 subnet
3. 點 **Default Security List** → **Add Ingress Rules**
4. 加兩條規則：
   - Source: `0.0.0.0/0`, IP Protocol: TCP, Destination Port: `80`
   - Source: `0.0.0.0/0`, IP Protocol: TCP, Destination Port: `443`

---

## 階段 2：SSH 進 VM 安裝 backend（30 分鐘）

### 2.1 SSH 連線

把下載的 private key 存到 `~/.ssh/oracle.key`，chmod 600：

```bash
# Windows PowerShell:
icacls "C:\Users\USER\.ssh\oracle.key" /inheritance:r /grant:r "$($env:USERNAME):(F)"

# 連線（IP 換你 reserved IP）:
ssh -i ~/.ssh/oracle.key ubuntu@YOUR_ORACLE_IP
```

### 2.2 一鍵 setup script

連進去後跑這串（我已寫好 `scripts/oracle-bootstrap.sh`）：

```bash
curl -sL https://raw.githubusercontent.com/aaowobbowocc-ai/Claude-Code-Medical-Quiz/master/scripts/oracle-bootstrap.sh | bash
```

腳本做這些事：
1. 開 Ubuntu firewall 80/443
2. 裝 Node.js 22 LTS
3. clone repo 到 `~/examking`
4. npm install（編譯 ARM 原生 modules）
5. 裝 nginx + certbot
6. 寫 systemd service `examking-backend`
7. 啟動服務

### 2.3 設定 .env

```bash
cd ~/examking/backend
nano .env
```

貼以下（值你已經有）：

```
SUPABASE_URL=...
SUPABASE_KEY=...
ANTHROPIC_API_KEY=...
GOOGLE_APPLICATION_CREDENTIALS_JSON=...

# 街口（等 Leona 給）
JKOS_API_HOST=https://test-onlinepay.jkopay.app
JKOS_API_KEY=
JKOS_SECRET_KEY=
JKOS_STORE_ID=
FRONTEND_BASE_URL=https://examking.tw
BACKEND_BASE_URL=https://api.examking.tw
```

```bash
sudo systemctl restart examking-backend
sudo systemctl status examking-backend  # 檢查 active (running)
```

---

## 階段 3：設 DNS + HTTPS（20 分鐘）

### 3.1 設 DNS

到你的 domain provider（Cloudflare / GoDaddy / Vercel domains 等）：
- 加一筆 A record：`api.examking.tw` → `YOUR_ORACLE_IP`
- TTL 設 300（5 分鐘）

等 DNS propagate（5-30 分鐘），用 `dig api.examking.tw` 確認。

### 3.2 設 HTTPS（Let's Encrypt）

回到 VM：

```bash
sudo certbot --nginx -d api.examking.tw
```

照提示輸入 email、同意條款。完成後 Cloudflare/Let's Encrypt 自動發證書 + 設 nginx 自動續約。

### 3.3 測試

```bash
curl https://api.examking.tw/exam-registry
# 應該回 JSON
```

---

## 階段 4：切流量（10 分鐘）

### 4.1 更新 Vercel env

到 https://vercel.com/dashboard → examking → Settings → Environment Variables：
- `VITE_BACKEND_URL` = `https://api.examking.tw`
- 點 **Redeploy** 重新部署 frontend

### 4.2 提供 IP 給街口

回 Leona：

```
Hi Leona，

我們的固定 IP 是 YOUR_ORACLE_IP，請設定到測試與正式環境的白名單。
之後若有變動會即時告知。

朱
```

### 4.3 觀察 24 小時

確認：
- ✅ 站台正常（/practice 出題、/browse 看題庫）
- ✅ AI 解說 work
- ✅ Socket.IO 對戰 work
- ✅ Supabase 寫入正常

都 OK → 把 Render service 砍掉，省下費用。

---

## 後續維運

### 更新程式碼

每次 push 到 GitHub 後：

```bash
ssh -i ~/.ssh/oracle.key ubuntu@YOUR_ORACLE_IP
cd ~/examking
git pull
cd backend && npm install --omit=dev
sudo systemctl restart examking-backend
```

或寫成 alias：

```bash
alias deploy='ssh -i ~/.ssh/oracle.key ubuntu@YOUR_ORACLE_IP "cd ~/examking && git pull && cd backend && npm install --omit=dev && sudo systemctl restart examking-backend"'
```

之後一行指令 `deploy` 即更新。

### 帳號保活

Oracle 對「不活躍」帳號可能停掉 free instance。**保險做法**：
- 每月 SSH 進去一次（哪怕只是 `uptime`）
- 或 cron job 每天 ping API：

```bash
crontab -e
# 加這行：
0 9 * * * curl -s https://api.examking.tw/exam-registry > /dev/null
```

---

## 故障排除

| 問題 | 解法 |
|------|------|
| ARM 名額搶不到 | 換 region 試（Osaka/Seoul）、或夜間試 |
| SSH 連不進 VM | VCN security list 沒開 22；或 private key 權限不對 |
| nginx 502 | backend 沒跑：`sudo systemctl status examking-backend` 看 log |
| certbot 失敗 | DNS 還沒生效；等 30 分鐘再試 |
| backend OOM | A1.Flex 改 RAM 12→16 GB（24 GB 額度內仍免費） |
