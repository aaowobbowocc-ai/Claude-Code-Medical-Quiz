#!/usr/bin/env node
/**
 * Probe MoEX for nutrition PDFs across years 100-112.
 * For each (exam_code, subject), find correct c and s, download to cache.
 */

const fs = require('fs')
const path = require('path')
const https = require('https')

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const PDF_CACHE = path.join(__dirname, '..', '_tmp', 'pdf-cache')
const stripPUA = s => s.replace(/[-]/g, '').normalize('NFKC')

function get(url) {
  return new Promise(r => {
    https.get(url, { agent: new https.Agent({ rejectUnauthorized: false }) }, x => {
      if (x.statusCode !== 200) { x.destroy(); return r(null) }
      const c = []; x.on('data', d => c.push(d)); x.on('end', () => r(Buffer.concat(c)))
    }).on('error', () => r(null))
  })
}

let mupdfMod
async function getMupdf() { if (!mupdfMod) mupdfMod = await import('mupdf'); return mupdfMod }

async function inspectPdf(buf) {
  const mupdf = await getMupdf()
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  let txt = ''
  for (let i = 0; i < Math.min(2, doc.countPages()); i++) txt += doc.loadPage(i).toStructuredText('preserve-whitespace').asText() + '\n'
  txt = stripPUA(txt).replace(/\s+/g, '')  // collapse all whitespace for keyword search
  // Match 類科:營養師 specifically (avoid matching the exam list at top of page)
  const isNutrition = /類科[：:]?營養師/.test(txt)
  // Detect subject: try specific phrases first
  let subj = null
  const ordered = ['公共衛生營養學', '團體膳食設計與管理', '食品衛生與安全', '生理學與生物化學', '膳食療養學']
  for (const k of ordered) {
    if (txt.includes(k)) { subj = k; break }
  }
  // 營養學 fallback: appears as 「科目:營養學」 or with colon variations
  if (!subj && /科目[：:]?營養學[^師]/.test(txt)) subj = '營養學'
  return { cls: isNutrition ? '營養師' : null, subj, txt }
}

const SUBJECTS = ['膳食療養學', '團體膳食設計與管理', '生理學與生物化學', '營養學', '公共衛生營養學', '食品衛生與安全']

const EXAM_CODES = [
  '100030','100140','101030','101110','102030','102110','103030','103100',
  '104030','104100','105030','105090','106030','106110','107030','107110',
  '108020','108110','109030','109110','110030','110111','111030','111110',
  '112030','112110',
]

// First find correct c by probing, then within that c probe all 6 paper s codes.
async function findNutritionC(code) {
  const cCands = ['101','102','103','104','105','106','107','108','109','110','111','112']
  // Test with one cheap s code per c
  for (const c of cCands) {
    for (const s of ['0301','0201','11','22','33','0101']) {
      const url = `https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx?t=Q&code=${code}&c=${c}&s=${s}&q=1`
      const buf = await get(url)
      if (!buf || buf.length < 5000) continue
      const meta = await inspectPdf(buf)
      if (meta.cls?.includes('營養師')) {
        return c
      }
      break  // c valid but not nutrition; skip to next c
    }
  }
  return null
}

async function probeOne(code) {
  const c = await findNutritionC(code)
  if (!c) return {}
  console.log(`  ${code}: c=${c} confirmed nutrition`)
  // 6 papers under same c — try various s
  const sCands = ['0101','0102','0103','0104','0105','0106','0201','0202','0203','0204','0205','0206','0301','0302','0303','0304','0305','0306','0401','0402','0403','0404','0405','0406','0501','0502','0503','0504','0505','0506','0601','0602','0603','0604','0605','0606','0701','0702','0703','0704','0705','0706','11','22','33','44','55','66']
  const found = {}
  for (const s of sCands) {
    if (Object.keys(found).length >= 6) break
    const cacheFn = `nutrition_${code}_c${c}_s${s}.pdf`
    const cachePath = path.join(PDF_CACHE, cacheFn)
    let buf
    if (fs.existsSync(cachePath) && fs.statSync(cachePath).size > 5000) {
      buf = fs.readFileSync(cachePath)
    } else {
      const url = `https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx?t=Q&code=${code}&c=${c}&s=${s}&q=1`
      buf = await get(url)
      if (!buf || buf.length < 5000) continue
    }
    const meta = await inspectPdf(buf)
    if (meta.cls?.includes('營養師')) {
      for (const subj of SUBJECTS) {
        if (!found[subj] && (meta.subj === subj || meta.subj?.startsWith(subj))) {
          if (!fs.existsSync(cachePath)) fs.writeFileSync(cachePath, buf)
          found[subj] = cachePath
          // Also fetch answer PDF
          const aFn = `TS_${code}_c${c}_s${s}.pdf`
          const aPath = path.join(PDF_CACHE, aFn)
          if (!fs.existsSync(aPath)) {
            const aBuf = await get(`https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx?t=S&code=${code}&c=${c}&s=${s}&q=1`)
            if (aBuf && aBuf.length > 1000) fs.writeFileSync(aPath, aBuf)
          }
          console.log(`    s=${s}: ${subj} ✓`)
          break
        }
      }
    }
  }
  return found
}

;(async () => {
  for (const code of EXAM_CODES) {
    console.log(`\n=== ${code} ===`)
    const found = await probeOne(code)
    console.log(`  found ${Object.keys(found).length}/6 papers`)
  }
})().catch(e => { console.error(e); process.exit(1) })
