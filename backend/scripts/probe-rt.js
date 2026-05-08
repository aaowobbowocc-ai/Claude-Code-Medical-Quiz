#!/usr/bin/env node
/**
 * Probe MoEX for 呼吸治療師 (Respiratory Therapist) PDFs.
 *
 * Hypotheses:
 *   - 100年130場次 020系列 c=306 = 呼吸治療師（CLAUDE.md 註記）
 *   - 後續年度可能延用 c=306 走 020/090/100 系列
 *   - 也可能改入 030 系列（如護理師合併考）
 *
 * 對每個 (year, sessionCode, c, s) 做 HEAD-like GET + PDF 第一頁類科驗證。
 * 命中後印 ✓ 並儲存 cache PDF 供後續解析。
 */

require('dotenv/config')
const https = require('https')
const fs = require('fs')
const path = require('path')
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const CACHE_DIR = path.resolve(__dirname, '..', '_cache', 'rt-probe')
fs.mkdirSync(CACHE_DIR, { recursive: true })

function get(url) {
  return new Promise((res) => {
    const agent = new https.Agent({ rejectUnauthorized: false })
    https.get(url, { agent }, r => {
      if (r.statusCode !== 200) { r.destroy(); return res(null) }
      const ch = []
      r.on('data', c => ch.push(c))
      r.on('end', () => res(Buffer.concat(ch)))
    }).on('error', () => res(null))
  })
}

async function checkPdf(buf) {
  try {
    const mupdf = await import('mupdf')
    const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
    const text = doc.loadPage(0).toStructuredText('preserve-whitespace').asText().normalize('NFKC')
    const klass = text.match(/類\s*科[：:]?\s*([^\s\n]+)/)?.[1] || ''
    const subj  = text.match(/科\s*目[：:]?\s*([^\s\n（(]+)/)?.[1] || ''
    return { klass, subj }
  } catch { return null }
}

const TARGET_KEYWORDS = ['呼吸治療', '呼吸']

const YEARS = [100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115]
// 場次代碼候選 (同年常見)
const SESSION_SUFFIXES = ['020','030','040','050','060','070','080','090','100','110','120','130','140']
// c-code 候選 (RT 在 100年=306，未來可能換)
const C_CODES = ['304','305','306','307','308','309','310','311','312','313','314','315','316','317','318','319','320']
// s-code 候選 — 020系列(2碼) + 030系列(4碼)
const S_CODES_020 = ['11','22','33','44','55','66']
const S_CODES_030 = ['0101','0102','0201','0202','0301','0302','0401','0402','0501','0502','0601','0602']

async function probe(code, c, s) {
  const url = `${BASE}?t=Q&code=${code}&c=${c}&s=${s}&q=1`
  const buf = await get(url)
  if (!buf || buf.length < 5000) return null
  const meta = await checkPdf(buf)
  if (!meta) return null
  const isRT = TARGET_KEYWORDS.some(k => meta.klass.includes(k))
  if (!isRT) return null
  // 命中：cache
  const fname = `${code}_c${c}_s${s}.pdf`
  fs.writeFileSync(path.join(CACHE_DIR, fname), buf)
  return { url, ...meta, file: fname }
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function main() {
  const hits = []
  let probed = 0
  let consecutive404 = 0

  console.log('🔍 Probing 呼吸治療師 ...')
  console.log(`   years: ${YEARS.join(',')}`)
  console.log(`   total combos: ${YEARS.length * SESSION_SUFFIXES.length * C_CODES.length * (S_CODES_020.length + S_CODES_030.length)}`)
  console.log('')

  outer: for (const y of YEARS) {
    let yearHit = false
    for (const suffix of SESSION_SUFFIXES) {
      const code = `${y}${suffix}`
      // 先用 c=306 + 一個 s 試水溫；hit 才展開
      let firstHit = null
      for (const c of ['306','305','307','304','308']) {
        for (const s of ['11','22','0101','0201']) {
          probed++
          const r = await probe(code, c, s)
          await sleep(150)
          if (r) {
            firstHit = { code, c, s, ...r }
            break
          }
        }
        if (firstHit) break
      }
      if (!firstHit) continue
      console.log(`✓ ${code} c=${firstHit.c} s=${firstHit.s} → 類科:${firstHit.klass} 科目:${firstHit.subj}`)
      hits.push(firstHit)
      yearHit = true
      // 展開掃同 code+c 的所有 s
      const sList = firstHit.s.length === 2 ? S_CODES_020 : S_CODES_030
      for (const s of sList) {
        if (s === firstHit.s) continue
        probed++
        const r = await probe(code, firstHit.c, s)
        await sleep(150)
        if (r) {
          console.log(`  ✓ s=${s} → 科目:${r.subj}`)
          hits.push({ code, c: firstHit.c, s, ...r })
        }
      }
    }
    if (yearHit) consecutive404 = 0
    else consecutive404++
    if (consecutive404 >= 3 && y >= 110) {
      console.log(`⚠  跳過剩餘年（連續 ${consecutive404} 年無命中）`)
      break outer
    }
  }

  console.log('')
  console.log(`完成 — 探測 ${probed} 組合，命中 ${hits.length} 個 PDF`)
  fs.writeFileSync(path.join(CACHE_DIR, 'hits.json'), JSON.stringify(hits, null, 2))
  console.log(`結果寫入 ${path.join(CACHE_DIR, 'hits.json')}`)

  // 估算題數
  const papers = hits.length
  console.log(`估計題數：~${papers * 80} 題（每卷 80 計）— 實際可能因 RT 卷別題數異動`)
}

main().catch(e => { console.error(e); process.exit(1) })
