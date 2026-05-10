FROM node:20-slim AS base

# mupdf 需要 system libstdc++
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 安裝相依（先 copy package.json 利用 layer cache）
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# 複製 source（.dockerignore 排除大檔案 + 開發資源）
COPY . .

ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001

CMD ["node", "server.js"]
