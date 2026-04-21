// Probe each URL in the gap list to tag availability.
// Concurrent, fast: HEAD/partial GET; classify by status+size+content-type.
const fs = require('fs')
const path = require('path')
const https = require('https')
const vm = require('vm')

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

// Extract URL_LOOKUP
const scriptPath = path.join(__dirname, 'scrape-fill-gaps-vision.js')
let src = fs.readFileSync(scriptPath, 'utf8').replace(/main\(\)\.catch[^\n]*\n?/, '\n')
src += '\nglobal.__URL_LOOKUP__ = URL_LOOKUP\n'
const ctx = { require, module, exports, __dirname: path.dirname(scriptPath), __filename: scriptPath,
  console, process, Buffer, setTimeout, clearTimeout, global }
vm.createContext(ctx)
vm.runInContext(src, ctx, { filename: scriptPath })
const URL_LOOKUP = ctx.global.__URL_LOOKUP__

// Parse gaps
const lines = fs.readFileSync(path.join(__dirname, '..', 'gaps-dryrun.log'), 'utf8').split('\n')
const targets = []
for (const ln of lines) {
  const m = ln.match(/^  (\S+)\s+(\d+)年\s+(\d+)\s+"(.+?)"\s+—\s+缺(\d+)題:\s+(.+)$/)
  if (m) targets.push({ exam: m[1], year: m[2], code: m[3], subject: m[4], miss: parseInt(m[5]), qs: m[6] })
}

function probe(url) {
  return new Promise(resolve => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Range': 'bytes=0-2048' },
      timeout: 10000,
    }, res => {
      const ct = String(res.headers['content-type'] || '')
      const loc = res.headers.location || ''
      const cl = parseInt(res.headers['content-length'] || '0')
      if (res.statusCode === 301 || res.statusCode === 302) {
        res.resume()
        return resolve({ status: 'redirect', loc })
      }
      if (res.statusCode >= 400) { res.resume(); return resolve({ status: 'http' + res.statusCode }) }
      let got = 0
      res.on('data', c => { got += c.length; if (got > 2048) req.destroy() })
      res.on('end', () => resolve({ status: 'ok', ct, size: cl || got }))
      res.on('close', () => resolve({ status: 'ok', ct, size: cl || got }))
    })
    req.on('error', e => resolve({ status: 'err', err: e.message }))
    req.on('timeout', () => { req.destroy(); resolve({ status: 'timeout' }) })
  })
}

async function run() {
  const rows = targets.map(t => {
    const u = URL_LOOKUP[`${t.code}|${t.subject}`]
    return {
      ...t,
      url: u ? `https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx?t=Q&code=${t.code}&c=${u.c}&s=${u.s}&q=1` : null,
    }
  })
  const CONC = 6
  let idx = 0, done = 0
  const results = new Array(rows.length)
  async function worker() {
    while (true) {
      const my = idx++
      if (my >= rows.length) return
      const r = rows[my]
      if (!r.url) { results[my] = { ...r, probe: { status: 'no-url' } }; done++; continue }
      const p = await probe(r.url)
      results[my] = { ...r, probe: p }
      done++
      if (done % 10 === 0) process.stderr.write(`  ${done}/${rows.length}\r`)
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker))
  console.error(`\ndone`)
  // Classify
  const ok = [], redir = [], other = []
  for (const r of results) {
    const p = r.probe
    if (p.status === 'ok' && /pdf/i.test(p.ct) && p.size > 20000) ok.push(r)
    else if (p.status === 'redirect' || (p.status === 'ok' && p.size < 5000)) redir.push(r)
    else other.push(r)
  }
  console.log(`有 PDF: ${ok.length}, 永久 302: ${redir.length}, 其他: ${other.length}`)

  // Rewrite markdown
  const out = []
  out.push('# 缺題瀏覽器手動查詢清單（已探測）')
  out.push('')
  out.push(`共 ${results.length} 目標 / ${results.reduce((s,r)=>s+r.miss,0)} 題`)
  out.push(`- ✅ **有 PDF 可下載**: ${ok.length} 筆`)
  out.push(`- ❌ **永久 302（不可補）**: ${redir.length} 筆`)
  out.push(`- ⚠️ **其他（需調查）**: ${other.length} 筆`)
  out.push('')

  function emit(title, list) {
    if (!list.length) return
    out.push(`## ${title} — ${list.length} 筆，${list.reduce((s,r)=>s+r.miss,0)} 題`)
    out.push('')
    out.push('| 考試 | 年 | 場次 | 科目 | 缺 | 題號 | URL |')
    out.push('|---|---|---|---|---|---|---|')
    for (const r of list) {
      out.push(`| ${r.exam} | ${r.year} | ${r.code} | ${r.subject} | ${r.miss} | ${r.qs} | ${r.url || '(無 URL)'} |`)
    }
    out.push('')
  }
  emit('✅ 有 PDF — 建議優先補', ok)
  emit('⚠️ 需調查（無 URL 對照或回應異常）', other)
  emit('❌ 永久 302 — 考選部線上系統無存檔', redir)

  const outPath = path.join(__dirname, '..', 'MISSING-BROWSER-SEARCH.md')
  fs.writeFileSync(outPath, out.join('\n'))
  console.log('Wrote', outPath)
}
run()
