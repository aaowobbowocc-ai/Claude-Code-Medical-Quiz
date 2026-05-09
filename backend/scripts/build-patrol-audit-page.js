#!/usr/bin/env node
/**
 * 產生靜態 HTML 審查面板，方便人工驗證 patrol agent 修了什麼。
 * 輸出：backend/_tmp/patrol-audit.html — 直接瀏覽器打開
 */
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const BACKEND = path.resolve(__dirname, '..')
const REPO_ROOT = path.resolve(BACKEND, '..')
const TMP = path.join(BACKEND, '_tmp')

const changedIds = JSON.parse(fs.readFileSync(path.join(TMP, 'patrol-changed-ids.json'), 'utf-8'))
const fixLog = JSON.parse(fs.readFileSync(path.join(TMP, 'patrol-fix-log.json'), 'utf-8'))

const PATROL_BASE_COMMIT = 'c2abd1e'  // 開始 patrol 之前最後一個 commit

// Get exam-config name mapping
const examConfigs = {}
for (const f of fs.readdirSync(path.join(BACKEND, 'exam-configs')).filter(x => x.endsWith('.json'))) {
  const c = JSON.parse(fs.readFileSync(path.join(BACKEND, 'exam-configs', f), 'utf-8'))
  examConfigs[c.id] = c.name
}

// Build fix category lookup from fix-log
const fixCategories = {}  // questionId → { category, detail }
for (const exam of Object.keys(fixLog.byExam || {})) {
  const log = fixLog.byExam[exam]
  for (const fix of (log.fixes || [])) {
    fixCategories[fix.questionId] = { category: fix.category || '?', detail: fix.detail || '' }
  }
}

function getQuestionFromGit(commitRef, file, qid) {
  try {
    const out = execSync(`git show ${commitRef}:${file}`, { cwd: REPO_ROOT, maxBuffer: 100 * 1024 * 1024, encoding: 'utf-8' })
    const data = JSON.parse(out)
    return (data.questions || data).find(q => String(q.id) === String(qid))
  } catch { return null }
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]))
}

function renderQuestion(q, label) {
  if (!q) return `<div class="missing">[${label} 找不到]</div>`
  const opts = ['A','B','C','D'].map(k => {
    const v = (q.options && q.options[k]) || ''
    return `<div class="opt"><b>${k}:</b> ${escapeHtml(v) || '<em class="empty">(空)</em>'}</div>`
  }).join('')
  const flags = []
  if (q.incomplete === true) flags.push('<span class="flag-bad">incomplete:true</span>')
  if (q.incomplete === 'image_options') flags.push('<span class="flag-warn">image_options</span>')
  if (q.gap_reason) flags.push(`<span class="flag-warn">gap:${q.gap_reason}</span>`)
  if (q.image_url) flags.push(`<span class="flag-good">image_url</span>`)
  return `
    <div class="qbox">
      <div class="qhead">${label} ${flags.join(' ')}</div>
      <div class="qtext">${escapeHtml(q.question || '').slice(0, 400)}</div>
      ${opts}
      <div class="ans">答案: ${escapeHtml(q.answer || '?')}</div>
      ${q.image_url ? `<img class="qimg" src="${path.posix.join('..','..','frontend','public', q.image_url)}" alt="image" loading="lazy" onerror="this.style.display='none'" />` : ''}
    </div>`
}

let html = `<!DOCTYPE html>
<html lang="zh-TW"><head><meta charset="UTF-8"><title>Patrol 修復審查</title>
<style>
* { box-sizing: border-box; }
body { font-family: -apple-system, "Microsoft JhengHei", sans-serif; background: #f5f5f5; margin: 0; padding: 20px; }
h1 { color: #1a6b9a; }
h2 { background: #1a6b9a; color: white; padding: 10px 15px; margin: 30px 0 15px; border-radius: 6px; }
.summary { background: white; padding: 15px; border-radius: 8px; margin-bottom: 20px; }
.row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; padding: 14px; background: white; border-radius: 8px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
.row .meta { grid-column: 1/3; font-size: 13px; color: #555; padding-bottom: 8px; border-bottom: 1px dashed #ddd; }
.row .meta b { color: #1a6b9a; }
.row .cat { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: bold; margin-left: 8px; }
.cat-D { background: #dbeafe; color: #1e40af; }
.cat-B { background: #fef3c7; color: #92400e; }
.cat-stale { background: #d1fae5; color: #065f46; }
.cat-E { background: #fee2e2; color: #991b1b; }
.qbox { padding: 10px; border-radius: 6px; }
.qbox.before { background: #fef9e7; border: 1px solid #fbbf24; }
.qbox.after { background: #ecfdf5; border: 1px solid #34d399; }
.qhead { font-weight: bold; font-size: 12px; color: #555; margin-bottom: 6px; }
.qtext { font-size: 13px; line-height: 1.5; margin-bottom: 8px; color: #222; }
.opt { font-size: 12px; margin: 3px 0; padding: 3px 6px; background: rgba(0,0,0,0.03); border-radius: 3px; }
.opt b { color: #1a6b9a; }
.empty { color: #ef4444; }
.flag-bad { background: #ef4444; color: white; padding: 2px 6px; border-radius: 3px; font-size: 10px; }
.flag-warn { background: #f59e0b; color: white; padding: 2px 6px; border-radius: 3px; font-size: 10px; }
.flag-good { background: #10b981; color: white; padding: 2px 6px; border-radius: 3px; font-size: 10px; }
.ans { font-size: 12px; color: #1a6b9a; margin-top: 6px; }
.qimg { max-width: 100%; max-height: 350px; margin-top: 10px; border-radius: 4px; border: 1px solid #ddd; }
.missing { color: #999; font-style: italic; padding: 10px; }
.toc { position: sticky; top: 0; background: white; padding: 10px; border-bottom: 2px solid #1a6b9a; z-index: 10; }
.toc a { display: inline-block; margin-right: 12px; padding: 4px 8px; background: #f0f9ff; color: #1a6b9a; text-decoration: none; border-radius: 4px; font-size: 13px; }
.toc a:hover { background: #1a6b9a; color: white; }
</style></head><body>
<h1>Patrol 海巡修復 — 人工審查面板</h1>
<div class="summary">
  <p><b>總修改題數：</b>${Object.values(changedIds).reduce((s,v) => s + (v.changed?.length || 0), 0)}</p>
  <p><b>原因類別：</b>
    <span class="cat cat-D">D — 補圖</span>
    <span class="cat cat-B">B — 補空選項</span>
    <span class="cat cat-stale">flag-清</span>
    <span class="cat cat-E">E — 整題重抽</span>
  </p>
  <p><b>用法：</b>左邊黃底 = 修前（git ${PATROL_BASE_COMMIT}），右邊綠底 = 修後（HEAD）。
    若選項或題目看起來壞了 → 記下題目 ID 給我，我用 git 還原。</p>
</div>
<div class="toc">`

// TOC
for (const examId of Object.keys(changedIds).sort()) {
  if (examId === 'pt' || examId === 'ot') continue
  const cnt = changedIds[examId].changed?.length || 0
  if (cnt === 0) continue
  const name = examConfigs[examId] || examId
  html += `<a href="#${examId}">${name} (${cnt})</a>`
}
html += `</div>`

let totalRendered = 0
for (const examId of Object.keys(changedIds).sort()) {
  if (examId === 'pt' || examId === 'ot') continue  // skip classifier output
  const info = changedIds[examId]
  const ids = info.changed || []
  if (!ids.length) continue
  const file = info.file
  const name = examConfigs[examId] || examId

  html += `<h2 id="${examId}">${name} — ${ids.length} 題</h2>`

  for (const qid of ids) {
    const before = getQuestionFromGit(PATROL_BASE_COMMIT, file, qid)
    const after = getQuestionFromGit('HEAD', file, qid)
    const cat = fixCategories[qid]
    const catLabel = cat ? `<span class="cat cat-${cat.category[0]}">${cat.category}</span>` : ''
    const meta = before
      ? `<b>${name}</b> ${before.roc_year}年${before.session || ''} ${before.subject || ''} 第${before.number}題 ${catLabel} <code>${qid}</code>`
      : `<code>${qid}</code> ${catLabel}`
    html += `<div class="row">
      <div class="meta">${meta}</div>
      ${renderQuestion(before, '修前').replace('class="qbox"','class="qbox before"')}
      ${renderQuestion(after, '修後').replace('class="qbox"','class="qbox after"')}
    </div>`
    totalRendered++
  }
}

html += `<div class="summary"><p>已輸出 ${totalRendered} 題比對</p></div></body></html>`

const outFile = path.join(TMP, 'patrol-audit.html')
fs.writeFileSync(outFile, html)
console.log(`✓ 已輸出 ${totalRendered} 題比對 → ${outFile}`)
console.log(`💡 用瀏覽器打開（Windows）: explorer.exe "${outFile.replace(/\//g, '\\\\')}"`)
console.log(`💡 用 file://: file:///${outFile.replace(/\\/g, '/')}`)
