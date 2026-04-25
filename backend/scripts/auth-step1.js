#!/usr/bin/env node
/**
 * Manual OAuth flow — Step 1: print auth URL, start local server.
 * User opens URL in browser, approves, browser redirects back here.
 * Use this if `node scripts/fetch-analytics.js` fails with access_denied.
 */
const fs = require('fs')
const path = require('path')
const http = require('http')
const url = require('url')
const { google } = require('googleapis')

const SCOPES = [
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/webmasters.readonly',
]

const KEY_PATH = path.join(__dirname, '..', 'gcp-oauth.json')
const TOKEN_PATH = path.join(__dirname, '..', 'gcp-token.json')

const keyFile = JSON.parse(fs.readFileSync(KEY_PATH, 'utf-8'))
const key = keyFile.installed || keyFile.web

const PORT = 3399
const REDIRECT = `http://localhost:${PORT}`

const oauth2Client = new google.auth.OAuth2(key.client_id, key.client_secret, REDIRECT)

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: SCOPES,
  prompt: 'consent',
})

console.log('\n========== STEP 1: 開這個網址，用你有 GA4/GSC 權限的 Google 帳號登入 ==========\n')
console.log(authUrl)
console.log('\n========== 重要 ==========')
console.log('1. 確認登入的帳號是「Test users 列表裡的那個」(aaowobbowocc@gmail.com)')
console.log('2. 如果看到「Google 尚未驗證這個應用程式」警告：')
console.log('   → 點「進階」→「前往 kaoxue-analytics（不安全）」→「繼續」')
console.log('3. 同意畫面會列出兩個權限（GA + GSC），都要勾選 ✓')
console.log('4. 完成後瀏覽器會跳到 localhost:3399（這個視窗會自動處理）\n')

const server = http.createServer(async (req, res) => {
  try {
    const q = url.parse(req.url, true).query
    if (q.error) {
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'}); res.end(`<h1>授權失敗</h1><p>error: ${q.error}</p><p>error_description: ${q.error_description || '(none)'}</p><p>請看 console 訊息。</p>`)
      console.error('\n❌ 授權失敗:', q.error)
      console.error('   描述:', q.error_description || '(無)')
      console.error('\n常見原因：')
      console.error('  - 登入的帳號不是 test user')
      console.error('  - 在「Google 尚未驗證」警告畫面按了「返回安全頁面」')
      console.error('  - 取消授權')
      server.close()
      process.exit(1)
    }
    if (!q.code) {
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'}); res.end('<h1>等待授權碼...</h1>')
      return
    }
    console.log('✓ 收到授權碼，交換 token 中...')
    const { tokens } = await oauth2Client.getToken(q.code)
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2))
    res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'}); res.end(`<h1>✅ 授權成功！</h1><p>Token 已存到 backend/gcp-token.json</p><p>可以關掉這個分頁了，回 terminal 看 fetcher 結果。</p>`)
    console.log('✅ Token 已存到', path.relative(process.cwd(), TOKEN_PATH))
    console.log('\n下一步：執行 `node scripts/fetch-analytics.js` 拉資料')
    server.close()
    process.exit(0)
  } catch (e) {
    res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'}); res.end('<h1>錯誤</h1><pre>' + e.message + '</pre>')
    console.error('Error:', e.message)
    server.close()
    process.exit(1)
  }
})

server.listen(PORT, () => {
  console.log(`等待授權中（local server on :${PORT}）...`)
})
