#!/usr/bin/env node
/**
 * Probe subject codes for verified session+class combos.
 * For each combo, try all plausible subject code patterns.
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const https = require('https')
const pdfParse = require('pdf-parse')

const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36'

function probe(url) {
  return new Promise((resolve) => {
    const req = https.get(url, {
      rejectUnauthorized: false, timeout: 10000,
      headers: { 'User-Agent': UA, Accept: 'application/pdf,*/*',
                 Referer: 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx' },
    }, res => {
      const ct = res.headers['content-type'] || ''
      res.resume()
      resolve(res.statusCode === 200 && (ct.includes('pdf') || ct.includes('octet')))
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
  })
}

function fetchAndParse(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      rejectUnauthorized: false, timeout: 15000,
      headers: { 'User-Agent': UA, Accept: 'application/pdf,*/*',
                 Referer: 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx' },
    }, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`${res.statusCode}`)) }
      const cs = []; res.on('data', c => cs.push(c)); res.on('end', async () => {
        try {
          const d = await pdfParse(Buffer.concat(cs))
          const sub = d.text.match(/科\s*目[名稱]*\s*[：:]\s*(.+)/m)
          resolve(sub ? sub[1].trim().substring(0, 80) : '?')
        } catch { resolve('?') }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// Known verified combos: [session, classCode, examName, subjectCodeFormat]
// subjectCodeFormat: '4digit' (0101, 0201, ...) or '2digit' (11, 22, ...)
const TARGETS = [
  // 030 series — 4-digit subject codes
  // Year 100: c=101=doctor, c=103=pharma, c=104=medlab, c=106=PT, c=107=TCM
  { code: '100030', c: '101', exam: 'doctor', fmt: '4d' },
  { code: '100030', c: '103', exam: 'pharma', fmt: '4d' },
  { code: '100030', c: '104', exam: 'medlab', fmt: '4d' },
  { code: '100030', c: '106', exam: 'PT', fmt: '4d' },
  { code: '100030', c: '107', exam: 'TCM', fmt: '4d' },
  // Year 101
  { code: '101030', c: '101', exam: 'doctor', fmt: '4d' },
  { code: '101030', c: '103', exam: 'pharma', fmt: '4d' },
  { code: '101030', c: '104', exam: 'medlab', fmt: '4d' },
  { code: '101030', c: '106', exam: 'TCM(101)', fmt: '4d' },
  { code: '101030', c: '107', exam: 'nutrition(101)', fmt: '4d' },
  // Also try c=102, 105, 108, 109, 110 for unknowns
  { code: '101030', c: '102', exam: '?', fmt: '4d' },
  { code: '101030', c: '105', exam: '?', fmt: '4d' },
  { code: '101030', c: '108', exam: '?', fmt: '4d' },
  { code: '101030', c: '109', exam: '?', fmt: '4d' },
  { code: '101030', c: '110', exam: '?', fmt: '4d' },
  // Year 104
  { code: '104100', c: '101', exam: 'TCM', fmt: '4d' },
  { code: '104100', c: '103', exam: 'nutrition', fmt: '4d' },
  { code: '104100', c: '106', exam: 'nursing', fmt: '4d' },
  { code: '104100', c: '107', exam: 'SW', fmt: '4d' },
  { code: '104100', c: '102', exam: '?', fmt: '4d' },
  { code: '104100', c: '105', exam: '?', fmt: '4d' },
  { code: '104100', c: '108', exam: '?', fmt: '4d' },
  // Year 105
  { code: '105030', c: '101', exam: 'TCM', fmt: '4d' },
  { code: '105030', c: '103', exam: 'nutrition', fmt: '4d' },
  { code: '105030', c: '106', exam: 'nursing', fmt: '4d' },
  { code: '105030', c: '107', exam: 'SW', fmt: '4d' },
  { code: '105030', c: '102', exam: '?', fmt: '4d' },
  { code: '105030', c: '105', exam: '?', fmt: '4d' },
  // 020 series — 2-digit subject codes
  { code: '100020', c: '301', exam: 'dental1', fmt: '2d' },
  { code: '100020', c: '308', exam: 'radiology', fmt: '2d' },
  { code: '101010', c: '301', exam: 'dental1', fmt: '2d' },
  { code: '101010', c: '308', exam: 'radiology', fmt: '2d' },
  { code: '101010', c: '309', exam: 'PT', fmt: '2d' },
  { code: '101010', c: '305', exam: 'OT', fmt: '2d' },
  // Year 102
  { code: '102020', c: '301', exam: 'dental1?', fmt: '2d' },
  { code: '102020', c: '304', exam: '?', fmt: '2d' },
  { code: '102020', c: '305', exam: '?', fmt: '2d' },
  { code: '102020', c: '306', exam: '?', fmt: '2d' },
  { code: '102020', c: '308', exam: '?', fmt: '2d' },
  { code: '102020', c: '309', exam: '?', fmt: '2d' },
  { code: '102020', c: '311', exam: '?', fmt: '2d' },
  { code: '102020', c: '312', exam: '?', fmt: '2d' },
  // Year 103
  { code: '103020', c: '301', exam: '?', fmt: '2d' },
  { code: '103020', c: '304', exam: '?', fmt: '2d' },
  { code: '103020', c: '305', exam: '?', fmt: '2d' },
  { code: '103020', c: '306', exam: '?', fmt: '2d' },
  { code: '103020', c: '308', exam: '?', fmt: '2d' },
  { code: '103020', c: '309', exam: '?', fmt: '2d' },
  { code: '103020', c: '311', exam: '?', fmt: '2d' },
  { code: '103090', c: '312', exam: 'OT?', fmt: '2d' },
  // Year 104 020 series
  { code: '104020', c: '304', exam: '?', fmt: '2d' },
  { code: '104020', c: '305', exam: '?', fmt: '2d' },
  { code: '104020', c: '306', exam: '?', fmt: '2d' },
  { code: '104020', c: '308', exam: '?', fmt: '2d' },
  { code: '104020', c: '311', exam: '?', fmt: '2d' },
  { code: '104020', c: '312', exam: '?', fmt: '2d' },
  { code: '104020', c: '314', exam: 'vet?', fmt: '2d' },
]

// Subject codes to try
const SUBJECTS_4D = [
  '0101', '0102', '0103', '0104', '0105', '0106', '0107', '0108',
  '0201', '0202', '0203', '0204', '0205', '0206',
  '0301', '0302', '0303', '0304', '0305', '0306',
  '0401', '0402', '0403', '0404', '0405', '0406',
  '0501', '0502', '0503', '0504', '0505', '0506',
  '0601', '0602', '0603', '0604', '0605', '0606',
  '0701', '0702', '0703', '0704', '0705', '0706',
  '0801', '0802', '0803', '0804', '0805', '0806',
  '0901', '0902', '0903',
  '1001', '1002', '1003', '1004', '1005', '1006',
]
const SUBJECTS_2D = ['11', '22', '33', '44', '55', '66', '77']

async function main() {
  for (const t of TARGETS) {
    const subjects = t.fmt === '4d' ? SUBJECTS_4D : SUBJECTS_2D
    const found = []

    for (const s of subjects) {
      const url = `${BASE}?t=Q&code=${t.code}&c=${t.c}&s=${s}&q=1`
      const ok = await probe(url)
      if (ok) found.push(s)
      await sleep(120)
    }

    if (found.length > 0) {
      // Get subject name for first found subject
      const firstUrl = `${BASE}?t=Q&code=${t.code}&c=${t.c}&s=${found[0]}&q=1`
      let subName = '?'
      try { subName = await fetchAndParse(firstUrl) } catch {}

      console.log(`${t.code} c=${t.c} (${t.exam}): ${found.length} subjects [${found.join(', ')}] — first: ${subName}`)
    }
    await sleep(100)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
