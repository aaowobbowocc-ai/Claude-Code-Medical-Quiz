#!/usr/bin/env node
/**
 * 索引 _tmp/pdf-cache 內所有 medlab PDF — 從 PDF 自身標頭辨識
 * 年次 / 次別 / 類科 / 科目，不依賴檔名解碼。
 * 輸出 _tmp/_medlab-pdf-index.json，供 _rebuild-medlab-images.js 使用。
 */
const fs = require('fs')
const path = require('path')

const PDF_DIR = path.join(__dirname, '..', '_tmp', 'pdf-cache')
const OUT = path.join(__dirname, '..', '_tmp', '_medlab-pdf-index.json')

// 已知醫事檢驗師科目（用於 header 文字雜亂時的 fallback 比對）
const SUBJECTS = [
  '臨床生理學與病理學',
  '臨床血液學與血庫學',
  '醫學分子檢驗學與臨床鏡檢學',
  '微生物學與臨床微生物學',
  '生物化學與臨床生化學',
  '臨床血清免疫學與臨床病毒學',
]

function firstPageText(doc, mupdf) {
  let txt = ''
  const n = Math.min(2, doc.countPages())
  for (let p = 0; p < n; p++) {
    const st = JSON.parse(doc.loadPage(p).toStructuredText('preserve-images').asJSON())
    for (const b of (st.blocks || [])) {
      if (b.type === 'text') for (const l of (b.lines || [])) txt += (l.text || '') + ' '
    }
  }
  // NFKC 正規化 — 考選部 PDF 字型常用 CJK 相容表意字（如 U+F9F6 臨），
  // 視覺相同但碼位不同，不正規化會讓字串比對失敗。
  return txt.replace(/\s+/g, ' ').normalize('NFKC')
}

function parseHeader(txt) {
  const year = (txt.match(/(\d{2,3})\s*年/) || [])[1] || null
  let session = null
  if (/第一次/.test(txt)) session = '第一次'
  else if (/第二次/.test(txt)) session = '第二次'
  // 科目：兼容新格式「科目名稱：」與舊格式「科 目：」
  let subject = null
  const m = txt.match(/科\s*目(?:名稱)?\s*[：:]\s*([^\n]+?)\s*考試時間/)
  if (m) subject = m[1].trim()
  // fallback：直接比對已知科目名（含舊名別名）
  if (!subject) {
    for (const s of SUBJECTS) { if (txt.includes(s)) { subject = s; break } }
  }
  // subjectKey 留原始字串，正規化交給 _rebuild-medlab-images.js 的 subjKey()
  let subjectKey = subject
  const cls = (txt.match(/類科名稱[：:]\s*(醫事檢驗[師生])/) || [])[1] || null
  return { year, session, subject, subjectKey, cls }
}

async function main() {
  const mupdf = await import('mupdf')
  const files = fs.readdirSync(PDF_DIR).filter(f => /medlab_/i.test(f) && f.endsWith('.pdf'))
  const index = []
  let ok = 0, bad = 0
  for (const f of files) {
    try {
      const doc = mupdf.Document.openDocument(new Uint8Array(fs.readFileSync(path.join(PDF_DIR, f))), 'application/pdf')
      const txt = firstPageText(doc, mupdf)
      const h = parseHeader(txt)
      const rec = { file: f, pages: doc.countPages(), ...h }
      index.push(rec)
      if (h.year && h.session && h.subjectKey) ok++
      else { bad++; console.log(`⚠ 無法完整辨識: ${f}  → year=${h.year} session=${h.session} subject=${h.subject}`) }
    } catch (e) {
      bad++; console.log(`✗ 開檔失敗: ${f}  ${e.message}`)
    }
  }
  fs.writeFileSync(OUT, JSON.stringify(index, null, 1))
  console.log(`\n索引完成：${files.length} 份，完整辨識 ${ok}，待處理 ${bad}`)
  console.log(`→ ${OUT}`)
}
main().catch(e => { console.error(e); process.exit(1) })
