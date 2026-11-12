#!/usr/bin/env node
/**
 * 郵局外勤缺了一整科：臺灣自然及人文地理。
 *
 * exam-configs/post-outdoor.json 宣告的兩卷是「企業管理大意」＋「郵政法大意及
 * 交通安全常識」，但企管只在 104/105 考過 —— 外勤 專業職(二) 的第二專業科目
 * 後來換成「臺灣自然及人文地理」。於是 107/111/112/114 這四年只收了郵政法那一卷，
 * 地理那一卷一題都沒有（111/112/114 官方 PDF 一直都在索引裡，
 * scrape-post.js 的 classifyOfficial 把它當「另計」跳過了）。
 *
 * 這支把 111/112/114 三卷（各 60 題）補進 questions-post-outdoor.json。
 * 107 那年官方系統沒放、三民也只有郵政法，所以補不了。
 *
 * ⚠️ 為什麼不直接重跑 scrape-post.js：
 *   1. 它會整檔覆寫，把 fix-post-subject-field.js 修好的 subject 洗回「專業科目」
 *      （已順手在 scrape-post.js 的 toQuestion 補好，但舊檔仍以此腳本為準）；
 *   2. 來源 A 的索引 _tmp/_post-classified.json 已不在，重跑會直接炸。
 *   所以這支只做「加」，既有題一筆都不動。
 *
 * PDF 走 pdf-fetcher 的既有快取（md5(url).pdf）。快取沒有就跳過並說出來——
 * 這支不連外網，省得為了 svc.tabf 的憑證再去關 TLS 驗證。
 *
 * 图表題的處理：地理卷 180 題裡有 23 題靴靴圖或表（「【圖50】為臺灣四周離島
 * 的分佈圖…」）。PDF 裡圖説與表格欄位會洩進選項（#50 的 D 被寫成「【圖50】」、
 * #53 的 B/C/D 被寫成表格欄名「港口/經度/緯度」），而且沒有圖的話這些題本來就
 * 無法作答。所以涉圖/表的一律標 incomplete（前箱隱藏、記入待辦），
 * 等圖撷出來再放出來；其餘 157 題直接上。
 *
 *   node scripts/add-post-geography.js
 *   node scripts/add-post-geography.js --apply
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const pdfParse = require('pdf-parse')
const { parsePostPdf } = require('./lib/post-parser')
const { atomicWriteJson, withLock } = require('./lib/atomic-write')

const ROOT = path.join(__dirname, '..')
const CACHE = path.join(ROOT, '_tmp', 'post-official-cache')
const INDEX = path.join(ROOT, '_tmp', '_post-official-index.json')
const OUT = path.join(ROOT, 'questions-post-outdoor.json')
const APPLY = process.argv.includes('--apply')

const PAPER = '臺灣自然及人文地理'
const TAG = 'post_geo'

// 「【圖50】」「【表37】」「如下圖」——提到圖表就一定要有圖才能作答
const FIG_RE = /【\s*[圖表]\s*\d*\s*】|[圖表]\s*\d+\s*】|如[下上]?[圖表]|下[圖表]|上[圖表]|圖中|所示/

/**
 * 這一題能不能直接上？回傳 null 代表可以，否則回傳 incomplete 的理由。
 *
 * ⚠️「題幹問號之後還拖著一小段」看起來像是選項 A 被題幹吃掉，但實測
 * 7 題是誤報 —— 甲乙丙丁的選項清單本來就排在題幹裡
 * （「下列哪些節氣之時發生？ 甲、立秋 乙、春分 丙、清明 丁、夏至」），
 * 所以沒有把它當判準。
 */
function verdict(q) {
  const o = q.options || {}
  const ks = ['A', 'B', 'C', 'D']
  const vals = ks.map(k => String(o[k] == null ? '' : o[k]).trim())
  if (vals.some(v => !v)) return 'broken_options'
  if (new Set(vals.map(v => v.replace(/\s/g, ''))).size < 4) return 'broken_options'
  // 選項裡出現圖說編號 = 圖說整段被當成選項，這題的選項是壞的
  if (vals.some(v => /【\s*[圖表]\s*\d+\s*】|[圖表]\s*\d+\s*】/.test(v))) return 'broken_options'
  // 題幹停在逗號 → 後半截被切進選項了（112 #40 的表格題）
  if (/[，、]$/.test(String(q.question).trim())) return 'broken_options'
  if (FIG_RE.test(String(q.question)) || vals.some(v => FIG_RE.test(v))) return 'missing_image'
  return null
}

/**
 * 圖說編號是「依它自己那一題」編的，所以題幹尾巴黏到的
 * 「【圖17】」出現在第 33 題時，是隔壁題的圖說漏進來，裁掉。
 * 編號等於本題題號的要留——那是這題真的有圖。
 */
function stripForeignFigureTag(stem, number) {
  return String(stem).replace(/\s*【\s*([圖表])\s*(\d{1,3})\s*】\s*$/, (m, kind, n) =>
    (+n === +number ? m : ''))
}

async function main() {
  if (!fs.existsSync(INDEX)) { console.log(`找不到 ${INDEX}，先跑 probe-post-official.js`); process.exit(1) }
  const off = JSON.parse(fs.readFileSync(INDEX, 'utf8'))
  const j = JSON.parse(fs.readFileSync(OUT, 'utf8'))
  const arr = j.questions
  const before = arr.length

  const have = new Set(arr.filter(q => q.subject_tag === TAG).map(q => q.roc_year))
  const add = []

  for (const p of off.papers) {
    if (p.rank !== '專業職二外勤' || !p.isMcqPaper) continue
    if (!/臺灣自然/.test(p.subject || '')) continue
    if (!/郵遞業務/.test(p.category || '')) continue
    if (have.has(p.year)) { console.log(`  ${p.year} 已經有了，跳過`); continue }

    const fp = path.join(CACHE, crypto.createHash('md5').update(p.url).digest('hex') + '.pdf')
    if (!fs.existsSync(fp)) { console.log(`  ✗ ${p.year} 快取沒有這份 PDF，跳過`); continue }
    const buf = fs.readFileSync(fp)

    // 跟 scrape-post.js 一樣先驗表頭，確定抓到的是對的年度、對的機關
    const head = (await pdfParse(buf)).text.slice(0, 400).replace(/\s+/g, '')
    if (!head.includes('中華郵政') || !head.includes(`${p.year}年`)) {
      console.log(`  ⚠ ${p.year} 表頭未含「中華郵政${p.year}年」，跳過`); continue
    }

    const parsed = await parsePostPdf(buf)
    const good = parsed.filter(q => !q.incomplete)
    const nums = good.map(q => q.number)
    const gaps = []
    for (let n = 1; n <= Math.max(...nums); n++) if (!nums.includes(n)) gaps.push(n)
    const noAns = good.filter(q => !q.answer).length
    console.log(`  ${p.year} → ${good.length} 題（共解出 ${parsed.length}）` +
      `${gaps.length ? `  ⚠️ 缺題號 ${gaps.join(',')}` : ''}${noAns ? `  ⚠️ ${noAns} 題沒答案` : ''}`)
    if (gaps.length || noAns) { console.log('     有缺口，這卷不收'); continue }

    const held = {}
    for (const q of good) {
      const stem = stripForeignFigureTag(q.question, q.number)
      if (stem !== q.question) console.log(`     #${q.number} 裁掉隔壁題的圖說「${q.question.slice(stem.length).trim()}」`)
      const bad = verdict({ ...q, question: stem })
      if (bad) { held[bad] = (held[bad] || 0) + 1 }
      add.push({
        id: `post-outdoor-${p.year}-geo-${q.number}`,
        roc_year: p.year,
        session: '第一次',
        exam_code: `post-${p.year}`,
        subject: PAPER,
        subject_tag: TAG,
        subject_name: p.subject,
        stage_id: 0,
        number: q.number,
        question: stem,
        options: q.options,
        answer: q.answer,
        explanation: '',
        source: 'svc.tabf.org.tw',
        ...(q.disputed ? { disputed: true } : {}),
        ...(bad ? { incomplete: bad } : {}),
      })
    }
    const notes = Object.entries(held).map(([k, v]) => `${k} ${v}`).join('、')
    console.log(`     可直接上 ${good.length - Object.values(held).reduce((a, b) => a + b, 0)} 題` +
      `${notes ? `；先隱藏 ${notes}` : ''}`)
  }

  // 安全閥：id 不能跟既有的撞，同卷同題號也不能撞
  const ids = new Set(arr.map(q => String(q.id)))
  const slots = new Set(arr.map(q => `${q.exam_code}|${q.subject}|${q.number}`))
  const bad = add.filter(q => ids.has(String(q.id)) || slots.has(`${q.exam_code}|${q.subject}|${q.number}`))
  if (bad.length) { console.log(`\n✗ ${bad.length} 筆會撞到既有題（${bad.slice(0, 3).map(q => q.id).join(', ')}），中止`); process.exit(1) }

  console.log(`\n${APPLY ? '已加 ' : '可加 '}${add.length} 題　${before} → ${before + add.length}`)
  if (!APPLY) { console.log('(試跑；加 --apply 才寫入)'); return }

  arr.push(...add)
  arr.sort((a, b) => String(a.roc_year).localeCompare(String(b.roc_year)) ||
    String(a.subject_tag).localeCompare(String(b.subject_tag)) || a.number - b.number)
  j.total = arr.length
  withLock(OUT, () => atomicWriteJson(OUT, j))
  console.log(`✅ → questions-post-outdoor.json（total ${j.total}）`)
}

main().catch(e => { console.error(e); process.exit(1) })
