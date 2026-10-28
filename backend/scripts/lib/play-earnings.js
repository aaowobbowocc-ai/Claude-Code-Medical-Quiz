/*
 * Google Play 收益報表（扣完 Google 抽成的實收）。
 *
 * 報表放在 Play 開發人員帳戶的私有 GCS bucket：
 *   gs://<bucket>/earnings/earnings_YYYYMM.zip
 * 每月一個 zip，裡面是 UTF-16 編碼的 CSV。
 *
 * 零新依賴：
 *   - 認證用既有的 googleapis/google-auth-library + backend/gcp-sa.json
 *   - zip 自己解（backend 沒有 zip 套件，而且這裡只需要讀單一條目）
 *   - CSV 是 UTF-16LE，node 的 'utf16le' 直接吃
 *
 * 環境變數：
 *   PLAY_EARNINGS_BUCKET   例如 pubsite_prod_6222837267513123559（不含 gs:// 與路徑）
 *   GOOGLE_APPLICATION_CREDENTIALS 或 backend/gcp-sa.json
 *
 * ⚠️ 服務帳戶要在 **Play Console → 使用者和權限** 裡被邀請，
 *    而且「查看財務資料」必須是**帳戶層級（全域）**，不是單一 App。
 *    權限不足時 GCS 會回 403 storage.objects.list denied。
 */
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const { GoogleAuth } = require('google-auth-library')

const BK = path.resolve(__dirname, '..', '..')
const SCOPE = 'https://www.googleapis.com/auth/devstorage.read_only'

function bucketName() {
  const raw = process.env.PLAY_EARNINGS_BUCKET || ''
  return raw.replace(/^gs:\/\//, '').replace(/\/.*$/, '')
}

function keyFile() {
  const envKey = process.env.GOOGLE_APPLICATION_CREDENTIALS
  if (envKey && fs.existsSync(envKey)) return envKey
  for (const f of ['gcp-sa.json', '.gcp-key.json']) {
    const p = path.join(BK, f)
    if (fs.existsSync(p)) return p
  }
  return null
}

async function client() {
  const kf = keyFile()
  if (!kf) throw new Error('找不到 GCP 服務帳戶金鑰（gcp-sa.json / .gcp-key.json / GOOGLE_APPLICATION_CREDENTIALS）')
  return new GoogleAuth({ keyFile: kf, scopes: [SCOPE] }).getClient()
}

/** 列出 earnings/ 底下的物件。回 {ok, items|error}。 */
async function listEarnings() {
  const b = bucketName()
  if (!b) return { ok: false, error: '沒有設 PLAY_EARNINGS_BUCKET' }
  try {
    const c = await client()
    const r = await c.request({
      url: `https://storage.googleapis.com/storage/v1/b/${b}/o?prefix=earnings/&maxResults=200`,
    })
    return { ok: true, items: (r.data.items || []).map(i => ({ name: i.name, size: Number(i.size), updated: i.updated })) }
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message
    return { ok: false, status: e.response?.status, error: msg }
  }
}

/*
 * 最小 ZIP 讀取器。只做這份報表需要的事：找中央目錄、取出所有條目。
 *
 * 刻意從**中央目錄**讀而不是從 local header：local header 的 size 欄位
 * 在有 data descriptor 時會是 0，直接讀會抓到空的。
 */
function unzipAll(buf) {
  // End of Central Directory：簽章 PK\x05\x06，從尾端往前找（注釋最長 65535）
  const EOCD = 0x06054b50
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('不是合法的 zip（找不到 End of Central Directory）')
  const count = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)

  const out = []
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('中央目錄條目簽章不符')
    const method = buf.readUInt16LE(off + 10)
    const compSize = buf.readUInt32LE(off + 20)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const localOff = buf.readUInt32LE(off + 42)
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen)

    // local header：固定 30 bytes + name + extra（extra 長度可能與中央目錄不同）
    const lNameLen = buf.readUInt16LE(localOff + 26)
    const lExtraLen = buf.readUInt16LE(localOff + 28)
    const dataStart = localOff + 30 + lNameLen + lExtraLen
    const raw = buf.subarray(dataStart, dataStart + compSize)
    const data = method === 0 ? raw : zlib.inflateRawSync(raw)
    out.push({ name, data })

    off += 46 + nameLen + extraLen + commentLen
  }
  return out
}

/** CSV 是 UTF-16LE（Google 文件明講匯進 BigQuery 要先轉 UTF-8）。 */
function decodeCsv(data) {
  // BOM FF FE = UTF-16LE
  if (data.length >= 2 && data[0] === 0xFF && data[1] === 0xFE) return data.toString('utf16le', 2)
  // 沒 BOM 但偶數位是 0 → 還是 UTF-16LE
  if (data.length > 4 && data[1] === 0 && data[3] === 0) return data.toString('utf16le')
  return data.toString('utf8')
}

/** 很小的 CSV parser：處理雙引號與欄內逗號／換行。 */
function parseCsv(text) {
  const rows = []
  let row = [], cell = '', q = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++ } else q = false }
      else cell += ch
    } else if (ch === '"') q = true
    else if (ch === ',') { row.push(cell); cell = '' }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = '' }
    else if (ch !== '\r') cell += ch
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  if (!rows.length) return []
  const head = rows[0].map(h => h.trim())
  return rows.slice(1).filter(r => r.length > 1)
    .map(r => Object.fromEntries(head.map((h, i) => [h, (r[i] || '').trim()])))
}

/**
 * 抓某個月的收益報表。ym 格式 'YYYYMM'。
 *
 * ⚠️ 檔名**不是** earnings_YYYYMM.zip。實際長這樣：
 *      earnings/earnings_202609_86132638-1.zip
 *    後面那串是 Google 的帳戶／批次編號，猜不到也沒有文件寫。
 *    所以一定要先 list 再用 prefix 比對，不能直接組檔名
 *    （Google 自己的說明文件寫的是 earnings_YYYYMM.zip，但實際不是）。
 */
async function fetchEarnings(ym) {
  const b = bucketName()
  if (!b) return { ok: false, error: '沒有設 PLAY_EARNINGS_BUCKET' }

  const ls = await listEarnings()
  if (!ls.ok) return { ok: false, status: ls.status, error: ls.error }
  const hit = ls.items.find(i => i.name.startsWith(`earnings/earnings_${ym}`))
  if (!hit) {
    const got = ls.items.map(i => i.name.replace('earnings/', '')).join('、') || '（空）'
    return { ok: false, error: `bucket 裡沒有 ${ym} 的收益報表。現有：${got}` }
  }

  const obj = encodeURIComponent(hit.name)
  try {
    const c = await client()
    const r = await c.request({
      url: `https://storage.googleapis.com/storage/v1/b/${b}/o/${obj}?alt=media`,
      responseType: 'arraybuffer',
    })
    const entries = unzipAll(Buffer.from(r.data))
    const rows = entries.flatMap(e => parseCsv(decodeCsv(e.data)))
    return { ok: true, files: entries.map(e => e.name), rows }
  } catch (e) {
    // ⚠️ responseType 是 arraybuffer，所以錯誤的 body 不會被解析成 JSON，
    //    直接讀 e.response.data.error 會拿到 "[object ArrayBuffer]"。
    //    要自己把 buffer 轉回字串再 parse，否則看不到真正的原因。
    //    而且 403 的 body 是**純文字**不是 JSON（還帶 HTML entity），
    //    JSON.parse 失敗就要直接用那段文字，否則訊息會變成沒意義的 e.message。
    let msg = e.message
    const d = e.response?.data
    if (d && (d instanceof ArrayBuffer || ArrayBuffer.isView(d) || Buffer.isBuffer(d))) {
      const text = Buffer.from(d).toString('utf8')
      try { msg = JSON.parse(text).error?.message || text } catch { msg = text }
      msg = msg.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/<[^>]*>/g, '').trim()
    } else if (d?.error?.message) {
      msg = d.error.message
    }
    return { ok: false, status: e.response?.status, error: msg }
  }
}

module.exports = { bucketName, listEarnings, fetchEarnings, unzipAll, decodeCsv, parseCsv }
