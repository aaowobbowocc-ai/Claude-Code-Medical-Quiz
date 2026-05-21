#!/usr/bin/env node
/**
 * 經濟部國營事業聯招「科目B（申論／計算題）」純文字存檔
 *
 * 科目B 為申論計算題、無解答 PDF、無 ABCD 選項，不適合做成 MCQ 題庫，
 * 故僅抽出題幹全文存成 backend/_archive/state-essay.json。
 * **此檔不接任何 exam-config，不會出現在平台上。** 純存檔／日後備用。
 *
 * Usage:
 *   node scripts/scrape-taipower-essay.js
 *   node scripts/scrape-taipower-essay.js --year 114
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const fs = require('fs')
const path = require('path')
const pdfParse = require('pdf-parse')
const { cachedFetch } = require('./lib/pdf-fetcher')
const { atomicWriteJson } = require('./lib/atomic-write')

const ROOT = path.join(__dirname, '..')
const INDEX_FILE = path.join(ROOT, '_tmp', '_taipower-index.json')
const CACHE_DIR = path.join(ROOT, '_tmp', 'taipower-cache')
const OUT_FILE = path.join(ROOT, '_archive', 'state-essay.json')
const REFERER = 'https://www.taipower.com.tw/2289/2544/2554/2556/'

const YEARS = ['103', '104', '105', '106', '107', '108', '109', '110', '111', '112', '113', '114']

// 類別 → 科目B 科目名稱（固定，避免各年度檔名標點不一致）
const CATEGORIES = {
  '企管': '管理學、經濟學',
  '人資': '人力資源管理、勞工法令',
  '財會': '中級會計學、財務管理',
  '資訊': '資訊管理、程式設計',
}

// 抽出共同科目「國文：論文寫作」段：自「壹、國文」起至「貳、英文」前
function extractChineseEssay(text) {
  const t = text.replace(/\r\n?/g, '\n')
  const start = t.search(/壹\s*、\s*國文|國文\s*[:：]\s*論文寫作/)
  const end = t.search(/貳\s*、\s*英文|英文\s*[:：]\s*單選/)
  if (start < 0) return null
  const seg = end > start ? t.slice(start, end) : t.slice(start)
  return seg.split('\n')
    .filter(l => !/第\s*\d+\s*頁/.test(l) && !/【請翻頁繼續作答】|【請接背面】|【背面尚有試題】/.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// 抽出申論題題幹全文：自第一個「一、」大題起，去掉頁首頁尾
function extractEssayBody(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  let start = lines.findIndex(l => /^\s*一\s*、/.test(l))
  if (start < 0) {
    const noteEnd = lines.findIndex(l => /考試時間/.test(l))
    start = noteEnd >= 0 ? noteEnd + 1 : 0
  }
  return lines.slice(start)
    .filter(l => !/第\s*\d+\s*頁/.test(l) && !/【請翻頁繼續作答】|【請接背面】|【背面尚有試題】/.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function main() {
  const args = process.argv.slice(2)
  const yearFilter = args.includes('--year') ? args[args.indexOf('--year') + 1] : null

  if (!fs.existsSync(INDEX_FILE)) {
    console.error('索引不存在，請先執行 node scripts/probe-taipower.js')
    process.exit(1)
  }
  const index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf-8'))

  const essays = []
  for (const year of YEARS) {
    if (yearFilter && year !== yearFilter) continue

    // 共同科目：國文論文寫作（每年一篇，全類別共用；國文段落在共同科目 PDF 內）
    const commonSlot = index[year] && index[year]['共同科目']
    const commonUrl = commonSlot && commonSlot.mcq && commonSlot.mcq[0]
    if (commonUrl) {
      try {
        const buf = await cachedFetch(commonUrl, CACHE_DIR, { referer: REFERER, timeout: 35000 })
        const { text, numpages } = await pdfParse(buf)
        const body = extractChineseEssay(text)
        if (body) {
          essays.push({
            exam_name: '經濟部國營事業新進職員聯合甄試',
            exam_full: `經濟部所屬事業機構${year}年新進職員甄試`,
            roc_year: year,
            category: '共同科目',
            section: '共同科目（節次一・國文論文寫作）',
            subjects: '國文（論文寫作）',
            has_official_answer: false,
            source_url: commonUrl,
            pdf_pages: numpages,
            question_text: body,
          })
          console.log(`  ${year} 共同科目（國文論文寫作）: ${body.length} 字`)
        } else {
          console.log(`  ${year} 共同科目: 找不到「壹、國文」段`)
        }
      } catch (e) {
        console.log(`  ${year} 共同科目: ✗ ${e.message}`)
      }
      await new Promise(r => setTimeout(r, 400))
    }

    for (const [category, subjects] of Object.entries(CATEGORIES)) {
      const slot = index[year] && index[year][category]
      const url = slot && slot.essay
      if (!url) { console.log(`  ${year} ${category}: 索引無 科目B 試題`); continue }
      try {
        const buf = await cachedFetch(url, CACHE_DIR, { referer: REFERER, timeout: 35000 })
        const { text, numpages } = await pdfParse(buf)
        const body = extractEssayBody(text)
        essays.push({
          exam_name: '經濟部國營事業新進職員聯合甄試',
          exam_full: `經濟部所屬事業機構${year}年新進職員甄試`,
          roc_year: year,
          category,
          section: '專業科目B（節次三・申論計算題）',
          subjects,
          has_official_answer: false,   // 申論題無官方解答 PDF
          source_url: url,
          pdf_pages: numpages,
          question_text: body,
        })
        console.log(`  ${year} ${category}（${subjects}）: ${body.length} 字`)
      } catch (e) {
        console.log(`  ${year} ${category}: ✗ ${e.message}`)
      }
      await new Promise(r => setTimeout(r, 400))
    }
  }

  if (!fs.existsSync(path.dirname(OUT_FILE))) fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true })
  atomicWriteJson(OUT_FILE, {
    description: '經濟部國營事業聯招 科目B 申論／計算題題幹存檔。未接平台、不上線，純資料保存。',
    generated_at: new Date().toISOString(),
    source: 'taipower.com.tw',
    count: essays.length,
    essays,
  })
  console.log(`\n✅ ${essays.length} 份申論題卷 → _archive/state-essay.json`)
}

main().catch(e => { console.error(e); process.exit(1) })
