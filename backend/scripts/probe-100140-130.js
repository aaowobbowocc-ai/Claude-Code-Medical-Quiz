// Probe all (code, c, s) combos for 100-105 年 第二次 sessions to find available PDFs.
// Free: HEAD/range probes only. Output: coverage map.
const https = require('https')
const fs = require('fs')
const path = require('path')
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const SESSIONS = [
  '100130', '100140',  // 100年第二次
  '101130', '101140',  // 101年第二次 (?)
  '102130', '102140',
  '103130', '103140',
  '104130', '104140',
]

// Per CLAUDE.md + user URLs:
// 030 series c codes: 101-110 across years
// 020 series c codes: 301-312
const C_CODES_030 = ['101', '102', '103', '104', '105', '106', '107', '108', '109', '110']
const C_CODES_020 = ['301', '302', '303', '305', '306', '307', '308', '309', '311', '312']

const S_CODES_030 = ['0101', '0102', '0103', '0104', '0105', '0106', '0107', '0108',
  '0201', '0202', '0203', '0204', '0205', '0206',
  '0301', '0302', '0303', '0304', '0305', '0306',
  '0401', '0402', '0403', '0404', '0405', '0406',
  '0501', '0502', '0503', '0504', '0505', '0506',
  '0601', '0602', '0603', '0604']
const S_CODES_020 = ['11', '22', '33', '44', '55', '66']

function probe(url) {
  return new Promise(res => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Range': 'bytes=0-1024' },
      timeout: 8000,
    }, r => {
      const ct = r.headers['content-type'] || ''
      const cl = parseInt(r.headers['content-length'] || '0')
      r.resume()
      res({ status: r.statusCode, ct, cl })
    })
    req.on('error', e => res({ err: e.code || e.message }))
    req.on('timeout', () => { req.destroy(); res({ err: 'timeout' }) })
  })
}

async function run() {
  const found = []
  const tasks = []
  for (const code of SESSIONS) {
    const isCode020 = code.endsWith('130')
    const cs = isCode020 ? C_CODES_020 : C_CODES_030
    const ss = isCode020 ? S_CODES_020 : S_CODES_030
    for (const c of cs) for (const s of ss) {
      tasks.push({ code, c, s,
        url: `https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx?t=Q&code=${code}&c=${c}&s=${s}&q=1` })
    }
  }
  console.log(`Probing ${tasks.length} combos...`)
  let done = 0
  const CONC = 12
  let idx = 0
  async function worker() {
    while (idx < tasks.length) {
      const t = tasks[idx++]
      const p = await probe(t.url)
      done++
      if (p.status === 200 && /pdf/i.test(p.ct) && p.cl > 30000) {
        found.push({ ...t, size: p.cl })
        process.stderr.write(`  ✓ ${t.code} c=${t.c} s=${t.s} (${p.cl}B)\n`)
      }
      if (done % 50 === 0) process.stderr.write(`  ${done}/${tasks.length}\r`)
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker))
  console.log(`\nFound ${found.length} valid PDFs`)
  // Group by (code, c)
  const grouped = {}
  for (const f of found) {
    const k = `${f.code}|${f.c}`
    grouped[k] = grouped[k] || []
    grouped[k].push(f.s)
  }
  console.log('\n--- By (code, c) ---')
  for (const [k, ss] of Object.entries(grouped).sort()) {
    console.log(`  ${k}: ${ss.join(',')} (${ss.length} subjects)`)
  }
  fs.writeFileSync(path.join(__dirname, '..', 'probe-100-104-secondsess.json'),
    JSON.stringify(found, null, 2))
  console.log('\nWrote probe-100-104-secondsess.json')
}
run()
