import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'

// 這次 build 的 commit。題庫走 jsDelivr 的 @master，而 jsDelivr 把「@master → 哪個
// commit」快取 12 小時，**purge 清不掉那一層**（見 backend/scripts/purge-jsdelivr.js），
// 所以改題 push 完最久要 12 小時使用者才抿得到。帶著 sha 的網址則是立即生效。
// Vercel 每次 push 都會重建（沒有 ignoreCommand），所以網頁版的 sha 永遠是最新的。
const commitSha = (() => {
  const env = process.env.VERCEL_GIT_COMMIT_SHA || process.env.COMMIT_SHA
  if (env) return env
  try { return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim() } catch { return '' }
})()

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  define: { __COMMIT_SHA__: JSON.stringify(commitSha) },
})
