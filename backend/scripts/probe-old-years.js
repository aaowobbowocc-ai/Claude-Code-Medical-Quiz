#!/usr/bin/env node
/**
 * Probe 考選部 for available PDFs in years 100-105.
 * Tries known session code patterns × class codes × first subject code.
 * Reports which combinations return valid PDFs.
 *
 * Usage: node scripts/probe-old-years.js
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const https = require('https')

const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36'

function probe(url) {
  return new Promise((resolve) => {
    const req = https.get(url, {
      rejectUnauthorized: false, timeout: 12000,
      headers: { 'User-Agent': UA, Accept: 'application/pdf,*/*',
                 Referer: 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx' },
    }, res => {
      const ct = res.headers['content-type'] || ''
      const len = parseInt(res.headers['content-length'] || '0')
      res.resume()
      if (res.statusCode === 200 && (ct.includes('pdf') || ct.includes('octet'))) {
        resolve({ ok: true, size: len })
      } else {
        resolve({ ok: false, status: res.statusCode, location: res.headers.location })
      }
    })
    req.on('error', () => resolve({ ok: false, error: true }))
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, timeout: true }) })
  })
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// Session code patterns observed in existing scrapers:
// {year}020 — first session (醫師/牙醫/藥師/醫檢/物治/放射/獸醫)
// {year}030 — first session (護理/營養/社工, also 108 first for some medical)
// {year}080 — second session (doctor2, tcm2)
// {year}090 — second session (newer years)
// {year}100 — second session (106-109 for many exams)
// {year}110 — second session (護理/營養/社工 106-109)
// {year}070 — second session (tcm2)
// Also try: {year}010 (初考?), {year}040, {year}050, {year}060

const SESSION_SUFFIXES = ['010', '020', '030', '040', '050', '060', '070', '080', '090', '100', '110', '111', '120']

// Exams to probe: { name, classCode, firstSubjectCode (2-digit old format) }
const EXAMS = [
  { name: 'doctor1', c: '301', s: '11' },
  { name: 'doctor2', c: '302', s: '11' },
  { name: 'dental1', c: '303', s: '11' },
  { name: 'dental2', c: '304', s: '33' },
  { name: 'pharma1', c: '305', s: '33' },
  { name: 'pharma2', c: '306', s: '44' },
  { name: 'medlab', c: '308', s: '11' },
  { name: 'radiology', c: '309', s: '11' },
  { name: 'pt', c: '311', s: '11' },
  { name: 'ot', c: '312', s: '11' },
  { name: 'vet', c: '314', s: '11' },
  { name: 'tcm1(317)', c: '317', s: '11' },
  { name: 'tcm2(318)', c: '318', s: '11' },
  // Nursing/nutrition use different class codes historically
  { name: 'nursing(106)', c: '106', s: '0501' },
  { name: 'nursing(104)', c: '104', s: '0301' },
  { name: 'nursing(101)', c: '101', s: '0101' },
  { name: 'nutrition(103)', c: '103', s: '0201' },
  { name: 'nutrition(102)', c: '102', s: '0201' },
  // Social worker
  { name: 'social-worker(107)', c: '107', s: '0601' },
  { name: 'social-worker(105)', c: '105', s: '0601' },
  { name: 'social-worker(103)', c: '103', s: '0301' },
  // TCM old class codes (110-111 used c=101 for 中醫)
  { name: 'tcm1(old-315)', c: '315', s: '11' },
  { name: 'tcm1(old-316)', c: '316', s: '11' },
  { name: 'tcm1(old-101)', c: '101', s: '11' },
]

async function main() {
  const years = ['100', '101', '102', '103', '104', '105']
  const results = []

  for (const year of years) {
    console.log(`\n═══ 民國 ${year} 年 ═══`)

    // First: find which session codes exist by probing with doctor1 (c=301, s=11)
    const activeSessions = []
    for (const suffix of SESSION_SUFFIXES) {
      const code = year + suffix
      const url = `${BASE}?t=Q&code=${code}&c=301&s=11&q=1`
      const r = await probe(url)
      if (r.ok) {
        console.log(`  ✓ Session ${code} exists (doctor1 Q PDF found, ${r.size} bytes)`)
        activeSessions.push(code)
      }
      await sleep(200)
    }

    // Also probe with other class codes for sessions that didn't work with 301
    for (const suffix of SESSION_SUFFIXES) {
      const code = year + suffix
      if (activeSessions.includes(code)) continue
      // Try nursing c=106
      const url = `${BASE}?t=Q&code=${code}&c=106&s=0501&q=1`
      const r = await probe(url)
      if (r.ok) {
        console.log(`  ✓ Session ${code} exists (nursing c=106 Q PDF found, ${r.size} bytes)`)
        activeSessions.push(code)
      }
      await sleep(200)
    }

    if (activeSessions.length === 0) {
      console.log(`  ✗ No sessions found for year ${year}`)
      continue
    }

    // Now probe all exams for each active session
    for (const code of activeSessions) {
      console.log(`\n  --- Session ${code} ---`)
      for (const exam of EXAMS) {
        const url = `${BASE}?t=Q&code=${code}&c=${exam.c}&s=${exam.s}&q=1`
        const r = await probe(url)
        if (r.ok) {
          console.log(`    ✓ ${exam.name} (c=${exam.c}, s=${exam.s}) — ${r.size} bytes`)
          results.push({ year, code, exam: exam.name, c: exam.c, s: exam.s })
        }
        await sleep(150)
      }
    }
  }

  console.log('\n\n═══ SUMMARY ═══')
  for (const r of results) {
    console.log(`${r.year} ${r.code} ${r.exam} c=${r.c} s=${r.s}`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
