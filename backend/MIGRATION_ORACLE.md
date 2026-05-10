# Oracle Cloud Always Free — examking-tw 完整搬遷手冊

從零（沒帳號）到上線約 60-90 分鐘。**完全免費永久**。

> 規格：4 ARM 核 + 24GB RAM (vs Render $7/月 0.5GB)。設定一次省一輩子。

---

## 階段 0 ─ 註冊 Oracle Cloud（15 分鐘）

### ⚠️ 重要警告

1. **必須驗證信用卡**（VISA / Mastercard），但**不會被收錢**（Always Free 帳號標記為 PAYG free）
2. **VISA debit 卡也可以**，但有時被擋。建議用實體信用卡
3. **註冊時 Region 選 Tokyo (NRT) 或 Osaka (KIX)** — 對台灣延遲最低（30ms）。**選錯一輩子改不了**
4. **不要選 Singapore** — 太遠，台灣 50-80ms

### 註冊步驟

1. 進 https://signup.cloud.oracle.com/
2. 填基本資訊：
   - Country/Territory: Taiwan
   - Cloud Account Name: 隨便（這是你的 tenancy 名）
   - Home Region: **Japan East (Tokyo)** ← 重要！
3. 驗證 email
4. **Address & Mobile**：用真實地址。電話會收 SMS 驗證碼
5. **Payment**：刷信用卡。系統會做 1 USD 的 pre-auth（會自動取消）
6. 等帳號開通（5-10 分鐘）

### 註冊踩坑

| 症狀 | 解法 |
|------|------|
| 「We're unable to process your request」 | 換瀏覽器 / 關 VPN / 換信用卡 / 等 24 小時再試 |
| SMS 收不到驗證碼 | 試另一支電話，或用網路電話如 TextNow |
| 卡片被拒 | 試國外發行的卡，或 VISA debit |
| 帳號開通後仍說 trial | 等 1-2 小時，OCI 後台需要時間打標籤 |

---

## 階段 1 ─ 建 A1 ARM Compute Instance（10 分鐘，但可能要重試多次）

### ⚠️ A1「out of host capacity」是常態

Oracle Always Free 的 A1 ARM 機器**極搶手**，常常在 Tokyo 拿不到。對策：

1. 先試 Tokyo（home region）
2. 拿不到就改試 **AMD VM.Standard.E2.1.Micro**（保底方案，1/8 OCPU + 1GB RAM）
3. 或寫個 polling script 每 10 分鐘試開機（凌晨 capacity 較鬆）

### 開機步驟

1. Console → 漢堡 menu → **Compute** → **Instances**
2. 點 **Create Instance**
3. 設定：
   - **Name**: `examking-backend`
   - **Image**: 點 Edit → **Ubuntu 22.04** (Canonical Ubuntu)
   - **Shape**: 點 Change shape →
     - **VM.Standard.A1.Flex** (Ampere ARM)
     - OCPU: **4**, Memory: **24 GB**（用滿 free quota）
   - **Networking**:
     - VCN: 自動建（如果沒有）
     - Public IP: **Yes**（必選！）
   - **SSH keys**:
     - 點 **Generate a key pair for me**
     - **下載 private key（.key 檔）和 public key**！這檔案丟了無法救
4. 點 **Create**
5. 等 1-2 分鐘狀態變 **Running**
6. **記下 Public IP**（會像 `158.101.x.x`）

### 如果 A1 開不出來

改開 E2.1.Micro（夠用，但只有 1GB RAM）：
- Shape: **VM.Standard.E2.1.Micro**
- OCPU: 1/8（fixed）
- Memory: 1 GB
- 可以**同時開 2 台 E2.1.Micro**（負載分擔）

> ⚠️ **1GB RAM 對我們來說緊**：questions JSON 載入後 ~250-300MB heap。會跑得起來但接近極限。如果 OOM 就只能等 A1 capacity。

---

## 階段 2 ─ 開防火牆 port（5 分鐘，**最常忘記的步驟**）

Oracle 有**雙層防火牆**，兩層都要開才能對外通：

### 第一層：Oracle Cloud Security List

1. Instance 詳情頁 → Primary VNIC → 點 **Subnet** 名字
2. 進 subnet 頁 → **Security Lists** → 點 Default Security List
3. **Add Ingress Rules**：
   ```
   Source CIDR: 0.0.0.0/0
   Protocol: TCP
   Destination Port: 80, 443
   ```
4. 加兩條（一條 80、一條 443）

### 第二層：Ubuntu 系統防火牆（iptables）

Oracle Ubuntu image 預設 iptables 只開 22 (SSH)。要改。SSH 進去後執行：

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

驗證：
```bash
sudo iptables -L INPUT -n | grep -E ':80|:443'
```

---

## 階段 3 ─ SSH 進機器（2 分鐘）

### Windows PowerShell

```powershell
# 把下載的 ssh-key-xxxx.key 移到固定位置
mkdir $env:USERPROFILE\.ssh -Force
mv ~\Downloads\ssh-key-*.key $env:USERPROFILE\.ssh\examking-oracle.key

# 設權限（Windows 也要）
icacls $env:USERPROFILE\.ssh\examking-oracle.key /inheritance:r /grant:r "$env:USERNAME:R"

# SSH（PUBLIC_IP 換成你的）
ssh -i $env:USERPROFILE\.ssh\examking-oracle.key ubuntu@PUBLIC_IP
```

第一次連會問 fingerprint，輸入 yes。看到 `ubuntu@examking-backend:~$` 就成功了。

---

## 階段 4 ─ 系統環境準備（10 分鐘）

進 SSH 之後跑：

```bash
# 更新系統
sudo apt update && sudo apt upgrade -y

# 安裝必要套件
sudo apt install -y curl git nginx ufw build-essential ca-certificates

# 安裝 Node 20（NodeSource repo）
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 驗證版本
node --version   # 應該 v20.x
npm --version
```

### 建 deploy user（不要用 ubuntu user 跑 service）

```bash
sudo useradd -m -s /bin/bash examking
sudo usermod -aG sudo examking
sudo mkdir -p /home/examking/.ssh
sudo cp ~/.ssh/authorized_keys /home/examking/.ssh/
sudo chown -R examking:examking /home/examking/.ssh
sudo chmod 700 /home/examking/.ssh
sudo chmod 600 /home/examking/.ssh/authorized_keys
```

---

## 階段 5 ─ 部署 backend code（10 分鐘）

```bash
# 切到 examking user
sudo -iu examking

# Clone repo
cd ~
git clone https://github.com/aaowobbowocc-ai/Claude-Code-Medical-Quiz.git app
cd app/backend

# 安裝相依
npm ci --omit=dev --no-audit
```

> 預期 npm install 約 1-2 分鐘。如果 mupdf 抓不到 ARM64 binary 就改用 x86 機器。

### 建 .env

```bash
nano /home/examking/app/backend/.env
```

貼進去（Render Dashboard → Environment 全部複製過來，**值要替換成真實 secret**）：

```env
NODE_ENV=production
PORT=3001

# Supabase
SUPABASE_URL=https://qgysdulvntuesoacdszo.supabase.co
SUPABASE_KEY=sb_secret_x4-cU3SeGx5bxE-...

# AI
ANTHROPIC_API_KEY=sk-ant-api03-...
GEMINI_API_KEY=AIzaSy...

# Discord
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
DISCORD_REPORT_WEBHOOK_URL=https://discord.com/api/webhooks/...

# Admin
FEEDBACK_ADMIN_KEY=...
ADMIN_SECRET=...

# R2
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET=...
R2_PUBLIC_URL=...

# Sentry（如有）
SENTRY_DSN=...

# JKOS（如有用街口支付）
JKOS_API_HOST=...
JKOS_API_KEY=...
JKOS_SECRET_KEY=...
JKOS_STORE_ID=...

# URLs
BACKEND_BASE_URL=https://api.examking.tw
FRONTEND_BASE_URL=https://examking.tw
```

存檔（Ctrl+O Enter Ctrl+X）。

權限：
```bash
chmod 600 /home/examking/app/backend/.env
```

### 測試啟動

```bash
cd /home/examking/app/backend
node server.js
```

應該看到：
```
Loaded 32 exam configs: ast, audiologist, ...
Server running on port 3001
```

按 Ctrl+C 停掉。

---

## 階段 6 ─ systemd service（5 分鐘）

讓 backend 開機自動啟動 + 自動重啟。

```bash
sudo nano /etc/systemd/system/examking-backend.service
```

貼進：

```ini
[Unit]
Description=examking-tw backend
After=network.target

[Service]
Type=simple
User=examking
WorkingDirectory=/home/examking/app/backend
EnvironmentFile=/home/examking/app/backend/.env
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

# 限制資源（避免吃光 RAM）
MemoryMax=2G

[Install]
WantedBy=multi-user.target
```

啟用：

```bash
sudo systemctl daemon-reload
sudo systemctl enable examking-backend
sudo systemctl start examking-backend
sudo systemctl status examking-backend       # 看狀態
sudo journalctl -u examking-backend -f       # 看 log（Ctrl+C 退出）
```

驗證 backend 在 listen：
```bash
curl http://localhost:3001/health
# 預期：{"ok":true}
```

---

## 階段 7 ─ Nginx 反向代理 + WebSocket 支援（10 分鐘）

```bash
sudo nano /etc/nginx/sites-available/examking-backend
```

貼進：

```nginx
server {
    listen 80;
    server_name api.examking.tw;

    # WebSocket support for Socket.IO
    location /socket.io/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;

        # 大 body（題目 JSON 可能 >10MB）
        client_max_body_size 50M;
    }

    access_log /var/log/nginx/examking-access.log;
    error_log /var/log/nginx/examking-error.log;
}
```

啟用：

```bash
sudo ln -s /etc/nginx/sites-available/examking-backend /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t                # 語法檢查
sudo systemctl reload nginx
```

---

## 階段 8 ─ Cloudflare DNS（3 分鐘）

進 https://dash.cloudflare.com → 你的 examking.tw zone → DNS → Add record

```
Type:        A
Name:        api
IPv4:        158.101.x.x      ← Oracle 的 Public IP
Proxy status: DNS only         ← 重要！必須是「灰雲」不是橘雲！
TTL:         Auto
```

**為什麼必須 DNS only**：
- Cloudflare 橘雲 proxy 會破壞 Socket.IO websocket（即使你開了 WebSocket setting 也會偶爾掛）
- Cloudflare 免費 plan 只支援 80/443，但我們等等要 Let's Encrypt 用 80

驗證 DNS（要等 1-5 分鐘 propagate）：
```bash
nslookup api.examking.tw 1.1.1.1
# 應該回傳 Oracle IP
```

---

## 階段 9 ─ Let's Encrypt SSL（5 分鐘）

```bash
sudo apt install -y certbot python3-certbot-nginx

sudo certbot --nginx -d api.examking.tw
# 會問 email、agree TOS、redirect HTTP→HTTPS（選 yes）
```

certbot 會自動改 nginx config 加 SSL，並設定 auto-renewal。

驗證：
```bash
curl https://api.examking.tw/health
# 預期：{"ok":true}
```

---

## 階段 10 ─ 切換 Frontend（5 分鐘）

進 Vercel Dashboard → 你的 frontend project → Settings → Environment Variables：

把 `VITE_BACKEND_URL` 改成：
```
https://api.examking.tw
```

存檔後進 Deployments → 點最新 deployment → Redeploy（用新 env build）。

---

## 階段 11 ─ 最終驗證（5 分鐘）

打開 https://examking.tw，DevTools → Network：

- [ ] 練習題目能載入（GET /questions/...）
- [ ] AI 解說呼叫成功（POST /ai/explain）
- [ ] 回饋表單能送（POST /feedback 並有 user_id）
- [ ] PvP 對戰能連 socket.io（**最關鍵**，看 Network → WS tab 有 WSS 連線）
- [ ] 金幣同步（POST /api/coins/delta）

---

## 階段 12 ─ 自動 deploy（可選，CI/CD）

不像 Render 自動 push 部署，Oracle 要手動。簡單做法：

### 方法 A：cron 每 5 分鐘 git pull

```bash
sudo -iu examking
crontab -e
```

加：
```
*/5 * * * * cd /home/examking/app && git pull origin master --quiet && cd backend && npm ci --omit=dev --quiet && sudo systemctl restart examking-backend
```

`sudo systemctl restart` 需要 examking user 有 sudo 權限：
```bash
sudo visudo
# 加一行：
examking ALL=(ALL) NOPASSWD: /bin/systemctl restart examking-backend
```

### 方法 B：GitHub Action SSH deploy（更好）

`.github/workflows/oracle-deploy.yml`:
```yaml
name: Oracle Deploy
on:
  push:
    branches: [master]
    paths: ['backend/**']
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: appleboy/ssh-action@v1.0.3
        with:
          host: ${{ secrets.ORACLE_HOST }}
          username: examking
          key: ${{ secrets.ORACLE_SSH_KEY }}
          script: |
            cd /home/examking/app
            git pull origin master
            cd backend
            npm ci --omit=dev
            sudo systemctl restart examking-backend
```

GitHub Secrets：
- `ORACLE_HOST` = Oracle public IP
- `ORACLE_SSH_KEY` = 完整 private key 文字

---

## 監控 / 故障排除

### 看 log
```bash
sudo journalctl -u examking-backend -f --since '10 minutes ago'
```

### 重啟
```bash
sudo systemctl restart examking-backend
```

### 看資源
```bash
htop                    # CPU / RAM
df -h                   # 硬碟
free -h                 # RAM 細節
```

### 常見問題

| 症狀 | 解法 |
|------|------|
| `curl http://api.examking.tw` 不通 | iptables 沒開 80（階段 2 第二層） |
| `curl http://localhost:3001/health` 通但外部不通 | Oracle Security List 沒開 80（階段 2 第一層） |
| Backend 啟動失敗 OOM | 加 swap：`sudo fallocate -l 2G /swap && sudo mkswap /swap && sudo swapon /swap` |
| Socket.IO 連不上 | Cloudflare DNS 開了 proxy → 改回 DNS only |
| Let's Encrypt 失敗 | DNS 還沒 propagate → 等 5 分鐘再試 |

---

## 優勢回顧

| 項目 | Render 付費 | Oracle Always Free |
|------|------------|-------------------|
| 月費 | $7-25 | **$0 永久** |
| RAM | 512MB-2GB | **24GB** |
| CPU | 0.5-2 vCPU | **4 OCPU ARM** |
| 流量限制 | 100GB/月 | **10TB/月** |
| 硬碟 | 1-10GB | **200GB** |
| 自由度 | 受平台限制 | 完整 root |

設定一次省一輩子。同一台機器還能跑 audit-reclassify、AI cache、vision-recheck（你目前在本機跑的東西全搬上去 24/7）。

---

## Rollback（如果需要切回 Render）

只要 Render 6/1 重置或你升級了：
1. Vercel `VITE_BACKEND_URL` 改回 Render URL
2. Redeploy frontend

Oracle 機器留著繼續跑（免費），未來想用就再切過去。
