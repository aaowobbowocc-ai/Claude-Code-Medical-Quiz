/*
 * App Store Connect 財務／銷售報表。
 *
 * 零新依賴：
 *   - ES256 JWT 用 node 內建 crypto（dsaEncoding: 'ieee-p1363' 直接產生
 *     JOSE 要的 r||s 格式；預設的 DER 是錯的，JWT 會被 Apple 退）
 *   - 報表是 gzip（Content-Type: application/a-gzip），用內建 zlib
 *   - HTTP 用 node 18+ 的 global fetch
 *
 * 環境變數（backend/.env）：
 *   APPLE_FINANCE_KEY_PATH    .p8 路徑，相對於 backend/
 *   APPLE_FINANCE_KEY_ID      金鑰 ID，例如 TDT9QBS768
 *   APPLE_FINANCE_ISSUER_ID   Issuer ID（UUID）
 *   APPLE_VENDOR_NUMBER       廠商編號，8~9 位數字
 *
 * ⚠️ 廠商編號不在 API 裡，也不是 Team ID。要去
 *    App Store Connect →「付款與財務報表」頁面左上角看。
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const zlib = require('zlib')

const BK = path.resolve(__dirname, '..', '..')
const API = 'https://api.appstoreconnect.apple.com/v1'

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** 讀設定；缺東西就回 {ok:false, missing:[...]}，讓呼叫端自己決定怎麼說。 */
function config() {
  const keyPath = process.env.APPLE_FINANCE_KEY_PATH || '.appstore-key.p8'
  const abs = path.isAbsolute(keyPath) ? keyPath : path.join(BK, keyPath)
  const missing = []
  if (!fs.existsSync(abs)) missing.push(`金鑰檔 ${keyPath}`)
  if (!process.env.APPLE_FINANCE_KEY_ID) missing.push('APPLE_FINANCE_KEY_ID')
  if (!process.env.APPLE_FINANCE_ISSUER_ID) missing.push('APPLE_FINANCE_ISSUER_ID')
  if (!process.env.APPLE_VENDOR_NUMBER) missing.push('APPLE_VENDOR_NUMBER（App Store Connect →「付款與財務報表」左上角）')
  return missing.length
    ? { ok: false, missing }
    : {
        ok: true,
        keyPath: abs,
        keyId: process.env.APPLE_FINANCE_KEY_ID,
        issuerId: process.env.APPLE_FINANCE_ISSUER_ID,
        vendor: process.env.APPLE_VENDOR_NUMBER,
      }
}

/** Apple 規定有效期最長 20 分鐘，這裡取 15。 */
function makeJwt(cfg) {
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'ES256', kid: cfg.keyId, typ: 'JWT' }
  const payload = { iss: cfg.issuerId, iat: now, exp: now + 15 * 60, aud: 'appstoreconnect-v1' }
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`
  const sig = crypto.sign('SHA256', Buffer.from(signingInput), {
    key: fs.readFileSync(cfg.keyPath, 'utf8'),
    dsaEncoding: 'ieee-p1363',   // ← 不能用預設的 DER
  })
  return `${signingInput}.${b64url(sig)}`
}

/**
 * 抓一份報表。回傳 { ok, status, rows|text|error }。
 * reportDate: 'YYYY-MM'（財務報表）或 'YYYY-MM-DD'（每日銷售）
 */
async function fetchReport({ kind = 'finance', reportDate, regionCode = 'ZZ', frequency = 'MONTHLY' }) {
  const cfg = config()
  if (!cfg.ok) return { ok: false, status: 0, error: '設定不完整：' + cfg.missing.join('、') }

  const qs = kind === 'finance'
    ? new URLSearchParams({
        'filter[regionCode]': regionCode,          // ZZ = 全部地區合併
        'filter[reportDate]': reportDate,
        'filter[reportType]': 'FINANCIAL',
        'filter[vendorNumber]': cfg.vendor,
      })
    : new URLSearchParams({
        'filter[frequency]': frequency,
        'filter[reportDate]': reportDate,
        'filter[reportSubType]': 'SUMMARY',
        'filter[reportType]': 'SALES',
        'filter[vendorNumber]': cfg.vendor,
      })
  const url = `${API}/${kind === 'finance' ? 'financeReports' : 'salesReports'}?${qs}`

  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${makeJwt(cfg)}`, Accept: 'application/a-gzip' },
  })
  if (!resp.ok) {
    let detail = ''
    try {
      const j = JSON.parse(await resp.text())
      detail = (j.errors || []).map(e => `${e.title}${e.detail ? '：' + e.detail : ''}`).join('；')
    } catch { /* 非 JSON 就算了 */ }
    return { ok: false, status: resp.status, error: detail || `HTTP ${resp.status}` }
  }

  const gz = Buffer.from(await resp.arrayBuffer())
  const tsv = zlib.gunzipSync(gz).toString('utf8')
  const lines = tsv.split('\n').filter(l => l.trim())
  const head = lines[0].split('\t')
  const rows = lines.slice(1).map(l => {
    const c = l.split('\t')
    return Object.fromEntries(head.map((h, i) => [h, c[i]]))
  })
  return { ok: true, status: 200, header: head, rows }
}

module.exports = { config, makeJwt, fetchReport }
