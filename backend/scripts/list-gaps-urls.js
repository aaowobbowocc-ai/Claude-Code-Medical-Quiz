// Extract URL_LOOKUP from scrape-fill-gaps-vision.js and join with dry-run gap list
// to produce a markdown browser-search list.
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const scriptPath = path.join(__dirname, 'scrape-fill-gaps-vision.js')
let src = fs.readFileSync(scriptPath, 'utf8')
// Strip the main() invocation so we only run top-level definitions
src = src.replace(/main\(\)\.catch[^\n]*\n?/, '/* main() disabled */\n')
// Expose URL_LOOKUP globally
src += '\nglobal.__URL_LOOKUP__ = URL_LOOKUP\n'

// Run in a sandbox that shares require and __dirname behavior
const ctx = {
  require, module, exports, __dirname: path.dirname(scriptPath), __filename: scriptPath,
  console, process, Buffer, setTimeout, clearTimeout, global,
}
vm.createContext(ctx)
vm.runInContext(src, ctx, { filename: scriptPath })
const URL_LOOKUP = ctx.global.__URL_LOOKUP__ || global.__URL_LOOKUP__

// Parse dry-run log
const logPath = path.join(__dirname, '..', 'gaps-dryrun.log')
const lines = fs.readFileSync(logPath, 'utf8').split('\n')
const targets = []
for (const ln of lines) {
  const m = ln.match(/^  (\S+)\s+(\d+)年\s+(\d+)\s+"(.+?)"\s+—\s+缺(\d+)題:\s+(.+)$/)
  if (m) targets.push({ exam: m[1], year: m[2], code: m[3], subject: m[4], miss: parseInt(m[5]), qs: m[6] })
}

const out = []
out.push('# 缺題瀏覽器手動查詢清單')
out.push('')
out.push(`共 ${targets.length} 個目標，${targets.reduce((s,t)=>s+t.miss,0)} 題`)
out.push('')
out.push('> URL 可直接貼到瀏覽器下載 PDF；若顯示 404/查無資料，代表該場次該科目在考選部線上系統永久缺檔。')
out.push('')

const byExam = {}
for (const t of targets) (byExam[t.exam] ||= []).push(t)

for (const exam of Object.keys(byExam).sort()) {
  const ts = byExam[exam]
  const total = ts.reduce((s,t)=>s+t.miss,0)
  out.push(`## ${exam} — ${ts.length} 卷，${total} 題`)
  out.push('')
  out.push('| 年 | 場次 | 科目 | 缺 | 題號 | URL |')
  out.push('|---|---|---|---|---|---|')
  for (const t of ts) {
    const k = `${t.code}|${t.subject}`
    const u = URL_LOOKUP[k]
    const url = u
      ? `https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx?t=Q&code=${t.code}&c=${u.c}&s=${u.s}&q=1`
      : '(無 URL 對照，需手動在 MoEX 搜尋頁查 class/subject code)'
    out.push(`| ${t.year} | ${t.code} | ${t.subject} | ${t.miss} | ${t.qs} | ${url} |`)
  }
  out.push('')
}

const outPath = path.join(__dirname, '..', 'MISSING-BROWSER-SEARCH.md')
fs.writeFileSync(outPath, out.join('\n'))
console.log('Wrote', outPath, 'with', targets.length, 'targets')
