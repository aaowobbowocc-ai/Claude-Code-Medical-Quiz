#!/usr/bin/env node
/**
 * 中華郵政（郵局招考）專業職(二) 題庫爬蟲 — 兩個題源整合
 *
 *   來源 A：三民輔考 3people.com.tw 公開考古題（104/105/107）
 *   來源 B：金融研訓院 svc.tabf.org.tw 官方甄試系統（111/112/114）
 *
 * 中華郵政三職階只有「專業職(二)」全為測驗題；專業職一/營運職的專業科目是申論
 * （另由 archive-post-essay.js 封存）。專業職(二) 分流為兩個考試：
 *   內勤 post-indoor ── 企業管理大意 (post_mgmt) + 郵政三法大意 (post_law)
 *   外勤 post-outdoor ─ 企業管理大意 (post_mgmt) + 郵政法大意及交通安全常識 (post_law)
 *
 * 兩來源 PDF 皆為「試題＋答案合一」（題號前綴【X】），共用 lib/post-parser.js。
 * ⚠️ 官方試題依著作權法 §9 不受著作權保護；三民考古題 PDF 只含試題+答案、無詳解。
 *
 * 索引：probe-post.js + _classify-post.js（三民）、probe-post-official.js（官方）。
 *
 *   node scripts/scrape-post.js [--dry-run]
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const fs = require('fs')
const path = require('path')
const pdfParse = require('pdf-parse')
const { cachedFetch } = require('./lib/pdf-fetcher')
const { atomicWriteJson, withLock } = require('./lib/atomic-write')
const { parsePostPdf } = require('./lib/post-parser')

const ROOT = path.join(__dirname, '..')
const CLASSIFIED = path.join(ROOT, '_tmp', '_post-classified.json')
const OFFICIAL = path.join(ROOT, '_tmp', '_post-official-index.json')
const SANMIN_CACHE = path.join(ROOT, '_tmp', 'post-cache')
const OFFICIAL_CACHE = path.join(ROOT, '_tmp', 'post-official-cache')

// ── 來源 A：三民。一份卷 → [{exam, tag, subjectName}]；非專業科目回 null ──
function classifySanmin(rel, subject) {
  if (/國文|英文/.test(subject)) return null
  if (/^企業管理大意/.test(subject)) {
    if (/內勤/.test(rel)) return [{ exam: 'post-indoor', tag: 'post_mgmt', subjectName: '企業管理大意' }]
    if (/外勤/.test(rel)) return [{ exam: 'post-outdoor', tag: 'post_mgmt', subjectName: '企業管理大意' }]
    return [
      { exam: 'post-indoor', tag: 'post_mgmt', subjectName: '企業管理大意' },
      { exam: 'post-outdoor', tag: 'post_mgmt', subjectName: '企業管理大意' },
    ]
  }
  if (/郵政三法/.test(subject) || (/郵政法規大意/.test(subject) && /櫃台|郵務處理/.test(subject)))
    return [{ exam: 'post-indoor', tag: 'post_law', subjectName: subject.replace(/\.pdf$/i, '') }]
  if (/郵政法大意及交通安全/.test(subject) || (/郵政法規大意/.test(subject) && /郵遞|運輸/.test(subject)))
    return [{ exam: 'post-outdoor', tag: 'post_law', subjectName: subject.replace(/\.pdf$/i, '') }]
  return null
}

// ── 來源 B：官方 svc.tabf。只收主流類科（內勤櫃台業務 / 外勤郵遞業務）主科 ──
function classifyOfficial(p) {
  if (!p.isMcqPaper) return null
  const subj = p.subject || ''
  if (/國文|英文|臺灣自然|人文地理/.test(subj)) return null            // 國文英文、臺灣地理另計
  if (p.rank === '專業職二內勤') {
    if (!/櫃台業務/.test(p.category || '')) return null                 // 跳過「櫃台(資訊)」特殊類科
    if (/企業管理/.test(subj)) return { exam: 'post-indoor', tag: 'post_mgmt', subjectName: subj }
    if (/郵政三法/.test(subj)) return { exam: 'post-indoor', tag: 'post_law', subjectName: subj }
  }
  if (p.rank === '專業職二外勤') {
    if (!/郵遞業務/.test(p.category || '')) return null
    if (/郵政法規/.test(subj)) return { exam: 'post-outdoor', tag: 'post_law', subjectName: subj }
  }
  return null
}

const SHORT = { post_mgmt: 'mgmt', post_law: 'law' }

function toQuestion(exam, tag, year, subjectName, source, q) {
  return {
    id: `${exam}-${year}-${SHORT[tag]}-${q.number}`,
    roc_year: year,
    session: '第一次',
    exam_code: `post-${year}`,
    subject: '專業科目',
    subject_tag: tag,
    subject_name: subjectName,
    stage_id: 0,
    number: q.number,
    question: q.question,
    options: q.options,
    answer: q.answer || 'A',
    explanation: '',
    source,
    ...(q.disputed ? { disputed: true } : {}),
  }
}

async function verifyAndParse(buf, year) {
  const headNorm = (await pdfParse(buf)).text.slice(0, 400).replace(/\s+/g, '')
  if (!headNorm.includes('中華郵政') || !headNorm.includes(`${year}年`)) {
    throw new Error(`表頭未含「中華郵政${year}年」`)
  }
  return parsePostPdf(buf)
}

async function main() {
  const dryRun = process.argv.includes('--dry-run')
  console.log(`\n${'='.repeat(62)}\n  中華郵政專業職(二) 爬蟲（三民 + 官方）${dryRun ? ' (dry-run)' : ''}\n${'='.repeat(62)}`)

  const byExam = { 'post-indoor': [], 'post-outdoor': [] }

  // ── 來源 A：三民 104/105/107 ──
  console.log('\n── 來源 A：三民輔考 ──')
  const { rows } = JSON.parse(fs.readFileSync(CLASSIFIED, 'utf-8'))
  for (const p of rows.filter(r => r.rank === '專業職二' && r.verdict === '選擇題')) {
    const targets = classifySanmin(p.rel, p.subject)
    if (!targets) continue
    let buf
    try { buf = await cachedFetch(p.url, SANMIN_CACHE, { referer: 'https://www.3people.com.tw/', timeout: 45000 }) }
    catch (e) { console.log(`  ✗ ${p.year} ${p.subject}: ${e.message}`); continue }
    let parsed
    try { parsed = await verifyAndParse(buf, p.year) }
    catch (e) { console.log(`  ⚠ ${p.year} ${p.subject}: ${e.message}，跳過`); continue }
    const good = parsed.filter(q => !q.incomplete)
    for (const t of targets) {
      for (const q of good) byExam[t.exam].push(toQuestion(t.exam, t.tag, p.year, t.subjectName, '3people.com.tw', q))
      console.log(`  ${p.year} → ${t.exam}/${t.tag}  ${good.length} 題`)
    }
    await new Promise(r => setTimeout(r, 120))
  }

  // ── 來源 B：官方 svc.tabf 111/112/114 ──
  console.log('\n── 來源 B：金融研訓院官方 ──')
  const off = JSON.parse(fs.readFileSync(OFFICIAL, 'utf-8'))
  for (const p of off.papers) {
    const t = classifyOfficial(p)
    if (!t) continue
    let buf
    try { buf = await cachedFetch(p.url, OFFICIAL_CACHE, { referer: 'https://svc.tabf.org.tw/', timeout: 45000 }) }
    catch (e) { console.log(`  ✗ ${p.year} ${p.subject}: ${e.message}`); continue }
    let parsed
    try { parsed = await verifyAndParse(buf, p.year) }
    catch (e) { console.log(`  ⚠ ${p.year} ${p.subject}: ${e.message}，跳過`); continue }
    const good = parsed.filter(q => !q.incomplete)
    for (const q of good) byExam[t.exam].push(toQuestion(t.exam, t.tag, p.year, t.subjectName, 'svc.tabf.org.tw', q))
    console.log(`  ${p.year} → ${t.exam}/${t.tag}  ${good.length} 題  (${(p.subject || '').slice(0, 20)})`)
    await new Promise(r => setTimeout(r, 120))
  }

  // ── 輸出 ──
  console.log('')
  for (const [exam, qs] of Object.entries(byExam)) {
    qs.sort((a, b) => a.roc_year.localeCompare(b.roc_year) ||
      a.subject_tag.localeCompare(b.subject_tag) || a.number - b.number)
    const label = exam === 'post-indoor' ? '郵局招考 內勤' : '郵局招考 外勤'
    const years = [...new Set(qs.map(q => q.roc_year))].sort()
    console.log(`  ${exam}: ${qs.length} 題（年度 ${years.join('/')}）`)
    if (dryRun) continue
    const outFile = path.join(ROOT, `questions-${exam}.json`)
    withLock(outFile, () => atomicWriteJson(outFile, {
      metadata: { exam, label, scraped_at: new Date().toISOString(), source: '3people.com.tw + svc.tabf.org.tw' },
      total: qs.length,
      questions: qs,
    }))
    console.log(`  ✅ → questions-${exam}.json`)
  }
  console.log('\n完成。')
}

main().catch(e => { console.error(e); process.exit(1) })
