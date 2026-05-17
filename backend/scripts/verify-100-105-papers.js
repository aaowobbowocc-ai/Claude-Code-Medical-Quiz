#!/usr/bin/env node
// 100-105 年題庫逐卷 PDF 類科稽核（read-only）。
// 重用 scrape-100-105.js 的 buildTargets()，對每一卷下載/讀取 Q PDF，
// 比對 PDF 標頭的「類科」是否 = 預期考試名稱。揪出爬蟲設定指錯的卷。
//
// 輸出 _tmp/verify-100-105-report.json。不寫題庫。
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const fs = require('fs')
const path = require('path')
const pdfParse = require('pdf-parse')
const { buildTargets } = require('./scrape-100-105.js')
const { fetchPdf, buildMoexUrl } = require('./lib/pdf-fetcher')

const PDF_CACHE = path.join(__dirname, '..', '_tmp', 'pdf-cache-100-105')
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36'
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function getQpdf(code, c, s) {
  const fp = path.join(PDF_CACHE, `Q_${code}_c${c}_s${s}.pdf`)
  try {
    const buf = fs.readFileSync(fp)
    if (buf.length > 1000) return { buf, cached: true }
  } catch {}
  const buf = await fetchPdf(buildMoexUrl('Q', code, c, s), {
    userAgent: UA, referer: 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx',
  })
  fs.writeFileSync(fp, buf)
  return { buf, cached: false }
}

// 從 PDF 標頭抓「類科」與「科目」
function parseHeader(rawText) {
  const t = rawText.slice(0, 1200).normalize('NFKC')
  const km = t.match(/類\s*科[名稱]*\s*[：:]\s*([^\n\r]+)/)
  const sm = t.match(/科\s*目\s*[：:]\s*([^\n\r]+)/)
  return {
    klass: km ? km[1].trim().replace(/\s+/g, '') : '',
    subject: sm ? sm[1].trim().replace(/\s+/g, '') : '',
  }
}

async function main() {
  const targets = buildTargets(null, null)
  const report = []
  let ok = 0, bad = 0, err = 0, downloaded = 0
  let n = 0
  for (const t of targets) {
    for (const sub of t.subjects) {
      n++
      let res
      try {
        const { buf, cached } = await getQpdf(t.code, t.classCode, sub.s)
        if (!cached) { downloaded++; await sleep(350) }
        const raw = (await pdfParse(buf)).text
        const hdr = parseHeader(raw)
        const expect = t.expectedExamName || ''
        const match = expect && hdr.klass.includes(expect)
        res = {
          examId: t.examId, file: t.file, year: t.year, code: t.code,
          c: t.classCode, s: sub.s, dbSubject: sub.subject,
          expectExam: expect, pdfKlass: hdr.klass, pdfSubject: hdr.subject,
          status: match ? 'ok' : 'MISMATCH',
        }
        if (match) ok++; else { bad++; }
      } catch (e) {
        res = {
          examId: t.examId, file: t.file, year: t.year, code: t.code,
          c: t.classCode, s: sub.s, dbSubject: sub.subject,
          expectExam: t.expectedExamName || '', status: 'ERROR', error: e.message,
        }
        err++
      }
      report.push(res)
      if (res.status !== 'ok') {
        console.log(`  ${res.status}  ${t.examId} ${t.year} ${t.code} c${t.classCode} s${sub.s} | 期望「${res.expectExam}」 PDF「${res.pdfKlass || res.error || '?'}」`)
      }
      if (n % 50 === 0) console.log(`... ${n} 卷已驗 (ok=${ok} bad=${bad} err=${err})`)
    }
  }
  const out = path.join(__dirname, '..', '_tmp', 'verify-100-105-report.json')
  fs.writeFileSync(out, JSON.stringify({ summary: { total: n, ok, bad, err, downloaded }, report }, null, 2))
  console.log(`\n=== 完成 ===`)
  console.log(`總卷數 ${n} | 正確 ${ok} | 類科不符 ${bad} | 下載失敗/錯誤 ${err}`)
  console.log(`報告寫入: ${out}`)
}

main().catch(e => { console.error(e); process.exit(1) })
