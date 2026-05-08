#!/usr/bin/env bash
# Oracle Cloud Always Free 一鍵安裝 examking backend
# 用法（在 SSH 連入 Oracle Ubuntu VM 後）：
#   curl -sL https://raw.githubusercontent.com/aaowobbowocc-ai/Claude-Code-Medical-Quiz/master/scripts/oracle-bootstrap.sh | bash
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/aaowobbowocc-ai/Claude-Code-Medical-Quiz.git}"
REPO_DIR="${HOME}/examking"
DOMAIN="${DOMAIN:-api.examking.tw}"
PORT="${PORT:-3001}"

echo "==========================================
examking backend 部署到 Oracle Cloud
==========================================
Repo: ${REPO_URL}
Dir:  ${REPO_DIR}
Port: ${PORT}
Domain: ${DOMAIN}
"

# ── 0. 系統更新 ────────────────────────────────────────────────────
echo "[0/7] apt update..."
sudo apt-get update -qq
sudo apt-get install -y -qq curl git build-essential ca-certificates

# ── 1. 防火牆 (Ubuntu iptables) ────────────────────────────────────
# Oracle Ubuntu 預設 iptables 擋掉 80/443，要先放行
echo "[1/7] 開放 80/443 (iptables + ufw)..."
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT  || true
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT || true
sudo netfilter-persistent save || sudo apt-get install -y -qq iptables-persistent
# 如果有 ufw（部分 Ubuntu image）
if command -v ufw >/dev/null 2>&1; then
  sudo ufw allow 80 || true
  sudo ufw allow 443 || true
  sudo ufw allow 22 || true
fi

# ── 2. Node.js 22 LTS ──────────────────────────────────────────────
echo "[2/7] 安裝 Node.js 22..."
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y -qq nodejs
fi
node --version
npm --version

# 編譯 native module 需要的 deps
sudo apt-get install -y -qq python3 make g++ libvips-dev

# ── 3. clone repo ──────────────────────────────────────────────────
echo "[3/7] clone repo..."
if [ -d "${REPO_DIR}" ]; then
  cd "${REPO_DIR}"
  git pull
else
  git clone "${REPO_URL}" "${REPO_DIR}"
fi

# ── 4. 安裝 dependencies ───────────────────────────────────────────
echo "[4/7] npm install..."
cd "${REPO_DIR}/backend"
npm install --omit=dev

# ── 5. 建 .env 範本（如果還沒有） ──────────────────────────────────
if [ ! -f .env ]; then
  cat > .env <<'EOF'
# Supabase
SUPABASE_URL=
SUPABASE_KEY=

# Anthropic / Vertex AI
ANTHROPIC_API_KEY=
GOOGLE_APPLICATION_CREDENTIALS_JSON=

# 街口 (等審核通過拿到後填)
JKOS_API_HOST=https://test-onlinepay.jkopay.app
JKOS_API_KEY=
JKOS_SECRET_KEY=
JKOS_STORE_ID=

# URLs
FRONTEND_BASE_URL=https://examking.tw
BACKEND_BASE_URL=https://api.examking.tw

# Server
PORT=3001
NODE_ENV=production
EOF
  echo "已建立 .env 範本，請編輯後再啟動服務："
  echo "  nano ${REPO_DIR}/backend/.env"
fi

# ── 6. systemd service ─────────────────────────────────────────────
echo "[6/7] 建立 systemd service..."
sudo tee /etc/systemd/system/examking-backend.service >/dev/null <<EOF
[Unit]
Description=examking backend
After=network.target

[Service]
Type=simple
User=${USER}
WorkingDirectory=${REPO_DIR}/backend
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5
EnvironmentFile=${REPO_DIR}/backend/.env
StandardOutput=append:/var/log/examking-backend.log
StandardError=append:/var/log/examking-backend.error.log

[Install]
WantedBy=multi-user.target
EOF

sudo touch /var/log/examking-backend.log /var/log/examking-backend.error.log
sudo chown ${USER}:${USER} /var/log/examking-backend.log /var/log/examking-backend.error.log
sudo systemctl daemon-reload
sudo systemctl enable examking-backend

# ── 7. nginx + HTTPS ──────────────────────────────────────────────
echo "[7/7] 安裝 nginx..."
sudo apt-get install -y -qq nginx
sudo tee /etc/nginx/sites-available/examking >/dev/null <<EOF
server {
    listen 80;
    server_name ${DOMAIN};

    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300s;
    }
}
EOF
sudo ln -sf /etc/nginx/sites-available/examking /etc/nginx/sites-enabled/examking
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl restart nginx
sudo systemctl enable nginx

# Let's Encrypt（DNS 設好後再跑）
sudo apt-get install -y -qq certbot python3-certbot-nginx

echo ""
echo "=========================================="
echo " ✅ Bootstrap 完成"
echo "=========================================="
echo ""
echo "下一步："
echo " 1. nano ${REPO_DIR}/backend/.env  → 填 Supabase / Anthropic / 街口 keys"
echo " 2. sudo systemctl restart examking-backend"
echo " 3. sudo systemctl status examking-backend"
echo " 4. 設 DNS: ${DOMAIN} → 此 VM 的固定 IP"
echo " 5. DNS 生效後跑: sudo certbot --nginx -d ${DOMAIN}"
echo " 6. curl https://${DOMAIN}/exam-registry  確認回 JSON"
echo ""
echo "查 log:"
echo " sudo journalctl -u examking-backend -f"
echo " tail -f /var/log/examking-backend.log"
