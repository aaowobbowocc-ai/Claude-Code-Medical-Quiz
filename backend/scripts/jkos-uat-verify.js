#!/usr/bin/env node
/**
 * 街口 onlinepay UAT 驗測工具 — 產生街口要求的驗測 LOG
 *
 * 街口驗收項目：3 筆正向訂單（Entry）+ 1 筆退款（Refund）+ 1 筆查詢（Inquiry）。
 * 本工具直接呼叫 UAT API 並印出完整 request / response LOG，貼回街口驗測腳本 Excel。
 *
 * 環境變數（backend/.env）：JKOS_API_HOST / JKOS_API_KEY / JKOS_SECRET_KEY / JKOS_STORE_ID
 *
 * 用法：
 *   node scripts/jkos-uat-verify.js entry [張數]      # 建單（預設 3 張），印 payment_url
 *   node scripts/jkos-uat-verify.js inquiry <訂單號>   # 查詢訂單
 *   node scripts/jkos-uat-verify.js refund  <訂單號>   # 退款（須先付款完成）
 *
 * 完整驗測流程：
 *   1. 跑 entry → 取得 3 個 payment_url
 *   2. 用街口 UAT APP（測試帳號）開 payment_url 完成付款
 *   3. 跑 inquiry <訂單號> 確認 status=0（已付款）
 *   4. 跑 refund <訂單號> 對其中一筆退款
 *   5. 把每步印出的 platform_order_id / request / response 貼回 Excel「驗收項目」
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const crypto = require('crypto')

const HOST = process.env.JKOS_API_HOST
const API_KEY = process.env.JKOS_API_KEY
const SECRET = process.env.JKOS_SECRET_KEY
const STORE_ID = process.env.JKOS_STORE_ID
const TEST_AMOUNT = 5            // UAT 驗測小額

if (!HOST || !API_KEY || !SECRET || !STORE_ID) {
  console.error('✗ 缺 JKOS_* 環境變數，請確認 backend/.env')
  process.exit(1)
}

const sign = s => crypto.createHmac('sha256', SECRET).update(s, 'utf8').digest('hex')
const orderId = () => `ckuat${Date.now()}${crypto.randomUUID().slice(0, 6)}`

function logBlock(title, reqInfo, resInfo) {
  console.log('\n' + '─'.repeat(72))
  console.log('● ' + title)
  console.log('─'.repeat(72))
  console.log('【LOG request】')
  console.log(reqInfo)
  console.log('\n【LOG response】')
  console.log(resInfo)
}

async function postApi(path, body) {
  const bodyJson = JSON.stringify(body)
  const digest = sign(bodyJson)
  const url = HOST + path
  const headers = { 'Content-Type': 'application/json', 'api-key': API_KEY, digest,
    'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
  const resp = await fetch(url, { method: 'POST', headers, body: bodyJson })
  const text = await resp.text()
  let data; try { data = JSON.parse(text) } catch { data = text }
  const reqInfo = `POST ${url}\nheaders: api-key=${API_KEY}\n         digest=${digest}\nbody: ${bodyJson}`
  const resInfo = `HTTP ${resp.status}\n${typeof data === 'string' ? data : JSON.stringify(data, null, 2)}`
  return { ok: resp.ok, data, reqInfo, resInfo }
}

async function getApi(path, query) {
  const qs = Object.entries(query).map(([k, v]) => `${k}=${v}`).join('&')
  const digest = sign(qs)
  const url = `${HOST}${path}?${qs}`
  const headers = { 'Content-Type': 'application/json', 'api-key': API_KEY, digest,
    'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
  const resp = await fetch(url, { method: 'GET', headers })
  const text = await resp.text()
  let data; try { data = JSON.parse(text) } catch { data = text }
  const reqInfo = `GET ${url}\nheaders: api-key=${API_KEY}\n         digest=${digest}`
  const resInfo = `HTTP ${resp.status}\n${typeof data === 'string' ? data : JSON.stringify(data, null, 2)}`
  return { ok: resp.ok, data, reqInfo, resInfo }
}

function validTime(seconds = 1800) {
  const d = new Date(Date.now() + seconds * 1000 + 8 * 3600 * 1000)
  return d.toISOString().replace('T', ' ').slice(0, 19)
}

async function doEntry(count) {
  console.log(`\n═══ 建立 ${count} 筆正向訂單（Entry API）═══`)
  for (let i = 1; i <= count; i++) {
    const pid = orderId()
    const body = {
      platform_order_id: pid,
      store_id: STORE_ID,
      currency: 'TWD',
      total_price: TEST_AMOUNT,
      final_price: TEST_AMOUNT,
      unredeem: 0,                                  // ⚠️ 驗測要求務必帶 0
      result_url: `${process.env.BACKEND_BASE_URL || 'https://examking.tw'}/payment/jkos/callback`,
      result_display_url: `${process.env.FRONTEND_BASE_URL || 'https://examking.tw'}/coin-shop/return?order=${pid}`,
      payment_type: 'onetime',
      escrow: false,
      valid_time: validTime(),
    }
    const r = await postApi('/platform/entry', body)
    logBlock(`第 ${i} 筆 Entry  platform_order_id = ${pid}`, r.reqInfo, r.resInfo)
    if (r.ok && r.data?.result === '000') {
      console.log(`\n→ 付款網址：${r.data.result_object?.payment_url}`)
    } else {
      console.log(`\n⚠ 建單失敗，請檢查參數或回報街口`)
    }
  }
  console.log('\n下一步：用街口 UAT APP（測試帳號 0922019804）開上面的付款網址完成付款。')
}

async function doInquiry(pid) {
  console.log(`\n═══ 查詢訂單（Inquiry API）═══`)
  const r = await getApi('/platform/inquiry', { platform_order_ids: pid })
  logBlock(`Inquiry  platform_order_id = ${pid}`, r.reqInfo, r.resInfo)
  const tx = r.data?.result_object?.transactions?.[0]
  if (tx) console.log(`\n→ 訂單狀態 status=${tx.status}（0=已付款成功）tradeNo=${tx.tradeNo}`)
}

async function doRefund(pid) {
  console.log(`\n═══ 退款（Refund API）═══`)
  const body = {
    platform_order_id: pid,
    refund_order_id: `ref${pid}`,
    refund_amount: TEST_AMOUNT,
  }
  const r = await postApi('/platform/refund', body)
  logBlock(`Refund  platform_order_id = ${pid}`, r.reqInfo, r.resInfo)
  if (r.ok && r.data?.result === '000') console.log('\n→ 退款成功')
  else console.log('\n⚠ 退款失敗（訂單須為已付款狀態才能退）')
}

async function main() {
  const [cmd, arg] = process.argv.slice(2)
  console.log(`街口 UAT 驗測　HOST=${HOST}　STORE=${STORE_ID}`)
  if (cmd === 'entry') return doEntry(Math.max(1, parseInt(arg) || 3))
  if (cmd === 'inquiry' && arg) return doInquiry(arg)
  if (cmd === 'refund' && arg) return doRefund(arg)
  console.log('\n用法：')
  console.log('  node scripts/jkos-uat-verify.js entry [張數]')
  console.log('  node scripts/jkos-uat-verify.js inquiry <訂單號>')
  console.log('  node scripts/jkos-uat-verify.js refund  <訂單號>')
}
main().catch(e => { console.error('✗', e.message); process.exit(1) })
