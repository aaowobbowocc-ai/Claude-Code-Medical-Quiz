#!/usr/bin/env node
/**
 * 廣 probe RT 呼吸治療師 105-115 年所有可能 (code, c, s) 組合。
 * 之前 probe 只試 c=306 020 系列，可能漏掉其他 c-code。
 */
require('dotenv').config()
const https = require('https')
const fs = require('fs')
const path = require('path')
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'

function get(url) {
  return new Promise((res) => {
    https.get(url, r => {
      if (r.statusCode !== 200) { r.destroy(); return res(null) }
      const ch = []; r.on('data', c => ch.push(c)); r.on('end', () => res(Buffer.concat(ch)))
    }).on('error', () => res(null))
  })
}

async function checkPdf(buf) {
  try {
    const mupdf = await import('mupdf')
    const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
    const text = doc.loadPage(0).toStructuredText('preserve-whitespace').asText().normalize('NFKC')
    const klass = text.match(/類\s*科[：:名稱]*\s*([^\s\n（(]{2,15})/)?.[1] || ''
    const subj = text.match(/科\s*目[：:名稱]*\s*([^\s\n（(]{2,30})/)?.[1] || ''
    return { klass, subj, isRT: klass.includes('呼吸') }
  } catch { return null }
}

async function probe(code, c, s) {
  const url = `${BASE}?t=Q&code=${code}&c=${c}&s=${s}&q=1`
  const buf = await get(url)
  if (!buf || buf.length < 5000) return null
  const meta = await checkPdf(buf)
  return meta && meta.isRT ? { url, ...meta, buf } : null
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const CACHE = path.join(__dirname, '..', '_tmp', 'pdf-cache')
  fs.mkdirSync(CACHE, { recursive: true })
  const hits = []
  // 105-115 各年廣掃
  for (const year of [105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115]) {
    for (const suffix of ['010','020','030','050','060','070','080','090','100','110','120']) {
      const code = `${year}${suffix}`
      // c-code 在不同年份會 rotate，廣試
      for (const c of ['304','305','306','307','308','309','310','311','312','313','314','315','316','317','318','319','320','321','322']) {
        // 020 風格 s + 030 風格 s 各試
        for (const s of ['11','22','33','44','55','66','0101','0102','0201','0301','0401','0501','0601','0701','0801']) {
          const r = await probe(code, c, s)
          await sleep(80)
          if (r) {
            console.log(`✓ ${year}年 ${code} c=${c} s=${s} 類科:${r.klass} 科目:${r.subj}`)
            // cache
            fs.writeFileSync(path.join(CACHE, `Q_${code}_c${c}_s${s}.pdf`), r.buf)
            hits.push({ year, code, c, s, klass: r.klass, subj: r.subj })
            // 命中後該 (code, c) 嘗試完整 s 範圍
            for (const sExtra of (s.length === 2 ? ['11','22','33','44','55','66'] : ['0101','0102','0103','0104','0105','0106','0201','0202'])) {
              if (sExtra === s) continue
              const r2 = await probe(code, c, sExtra)
              await sleep(80)
              if (r2) {
                console.log(`  + s=${sExtra} 科目:${r2.subj}`)
                fs.writeFileSync(path.join(CACHE, `Q_${code}_c${c}_s${sExtra}.pdf`), r2.buf)
                hits.push({ year, code, c, s: sExtra, klass: r2.klass, subj: r2.subj })
              }
            }
            break  // 同 (code, c) 找到後跳到下個 c
          }
        }
      }
    }
  }
  console.log(`\n命中 ${hits.length} 個 RT PDF`)
  fs.writeFileSync(path.join(__dirname, '..', '_tmp', 'rt-105-115-hits.json'), JSON.stringify(hits, null, 2))
}
main().catch(e => { console.error(e); process.exit(1) })
