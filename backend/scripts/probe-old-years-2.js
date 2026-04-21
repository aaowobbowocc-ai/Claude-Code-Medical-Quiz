#!/usr/bin/env node
/**
 * Second-pass probe: find missing exams for 100-105.
 * Also verify ambiguous results by downloading PDF header text.
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const https = require('https')
const pdfParse = require('pdf-parse')

const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36'

function fetchPdf(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      rejectUnauthorized: false, timeout: 15000,
      headers: { 'User-Agent': UA, Accept: 'application/pdf,*/*',
                 Referer: 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx' },
    }, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)) }
      const ct = res.headers['content-type'] || ''
      if (!ct.includes('pdf') && !ct.includes('octet')) { res.resume(); return reject(new Error('not pdf')) }
      const cs = []
      res.on('data', c => cs.push(c))
      res.on('end', () => resolve(Buffer.concat(cs)))
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function verifyPdf(code, c, s, expectedExam) {
  const url = `${BASE}?t=Q&code=${code}&c=${c}&s=${s}&q=1`
  try {
    const buf = await fetchPdf(url)
    const data = await pdfParse(buf)
    const firstLines = data.text.split('\n').slice(0, 10).join(' | ')
    return { ok: true, header: firstLines.substring(0, 200) }
  } catch (e) {
    return { ok: false, err: e.message }
  }
}

async function main() {
  // 1. Verify which class code is actually nursing for each session
  console.log('=== Verifying class codes for year 100 session 100030 ===')
  for (const [name, c, s] of [
    ['nursing c=106', '106', '0501'],
    ['nursing c=104', '104', '0301'],
    ['c=101', '101', '0101'],
    ['nutrition c=103', '103', '0201'],
    ['social-worker c=107', '107', '0601'],
  ]) {
    const r = await verifyPdf('100030', c, s, name)
    console.log(`  ${name}: ${r.ok ? r.header : r.err}`)
    await sleep(300)
  }

  // 2. Check dental1 (c=303) at 100020 - was it same file as doctor1?
  console.log('\n=== Verifying dental1 vs doctor1 at 100020 ===')
  for (const [name, c, s] of [
    ['doctor1 c=301', '301', '11'],
    ['dental1 c=303', '303', '11'],
  ]) {
    const r = await verifyPdf('100020', c, s, name)
    console.log(`  ${name}: ${r.ok ? r.header : r.err}`)
    await sleep(300)
  }

  // 3. Check doctor2 in various sessions
  console.log('\n=== Probing doctor2 c=302 in all found sessions ===')
  for (const code of ['100020', '101010', '101100', '102020', '102100', '103020', '103090', '104020']) {
    const r = await verifyPdf(code, '302', '11', 'doctor2')
    console.log(`  ${code} c=302 s=11: ${r.ok ? r.header.substring(0, 120) : r.err}`)
    await sleep(300)
  }

  // 4. Check dental1 (c=303) in non-100 sessions
  console.log('\n=== Probing dental1 c=303 ===')
  for (const code of ['101010', '101100', '102020', '102100', '103020', '103090', '104020']) {
    const r = await verifyPdf(code, '303', '11', 'dental1')
    console.log(`  ${code} c=303 s=11: ${r.ok ? r.header.substring(0, 120) : r.err}`)
    await sleep(300)
  }

  // 5. Check vet (c=314)
  console.log('\n=== Probing vet c=314 ===')
  for (const code of ['100020', '100050', '100100', '101010', '101100', '102020', '102100', '103020', '103090', '104020']) {
    const r = await verifyPdf(code, '314', '11', 'vet')
    console.log(`  ${code} c=314 s=11: ${r.ok ? r.header.substring(0, 120) : r.err}`)
    await sleep(300)
  }

  // 6. Check tcm (try c=315, 316, 317, 318, 101, 102)
  console.log('\n=== Probing tcm ===')
  for (const code of ['100020', '100050', '100100', '103020', '103090', '104020', '105030']) {
    for (const c of ['315', '316', '317', '318']) {
      const r = await verifyPdf(code, c, '11', `tcm c=${c}`)
      if (r.ok) console.log(`  ✓ ${code} c=${c} s=11: ${r.header.substring(0, 120)}`)
      await sleep(200)
    }
  }

  // 7. Check what c=101, c=104 are in session 100030 (are they nursing or something else?)
  console.log('\n=== Checking 105 for medical exams with broader session codes ===')
  for (const suffix of ['010', '020', '040', '050', '060', '070', '080', '100', '110', '111', '120']) {
    const code = '105' + suffix
    const r = await verifyPdf(code, '301', '11', 'doctor1')
    if (r.ok) console.log(`  ✓ ${code} c=301: ${r.header.substring(0, 120)}`)
    await sleep(200)
  }

  // 8. Check nursing sessions for year 102, 103 (not found in first probe)
  console.log('\n=== Probing nursing for years 102-103 ===')
  for (const year of ['102', '103']) {
    for (const suffix of ['010', '020', '030', '040', '050', '060', '070', '080', '090', '100', '110']) {
      const code = year + suffix
      const r = await verifyPdf(code, '106', '0501', `nursing yr${year}`)
      if (r.ok) console.log(`  ✓ ${code} c=106 nursing: ${r.header.substring(0, 120)}`)
      await sleep(200)
    }
  }
}

main().catch(e => { console.error(e); process.exit(1) })
