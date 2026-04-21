#!/usr/bin/env node
/**
 * Comprehensive verification: for each known valid session+classCode combo,
 * download the PDF and extract the 類科 (exam type) from the header.
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

async function identify(code, c, s) {
  const url = `${BASE}?t=Q&code=${code}&c=${c}&s=${s}&q=1`
  try {
    const buf = await fetchPdf(url)
    const data = await pdfParse(buf)
    const text = data.text
    // Extract 類科 and 科目
    const classMatch = text.match(/類\s*科[名稱]*\s*[：:]\s*(.+)/m)
    const subjectMatch = text.match(/科\s*目[名稱]*\s*[：:]\s*(.+)/m)
    const cls = classMatch ? classMatch[1].trim().substring(0, 40) : '?'
    const sub = subjectMatch ? subjectMatch[1].trim().substring(0, 60) : '?'
    return `${cls} | ${sub}`
  } catch (e) {
    return `FAIL: ${e.message}`
  }
}

async function main() {
  // All combos found in probe-1 that need verification, plus additional ones to try
  const combos = [
    // Year 100
    // 100020 series (found: 301, 303, 304, 305, 306, 308)
    ['100020', '301', '11'], ['100020', '302', '11'], ['100020', '303', '11'],
    ['100020', '304', '33'], ['100020', '305', '33'], ['100020', '306', '44'],
    ['100020', '308', '11'], ['100020', '309', '11'], ['100020', '311', '11'],
    ['100020', '312', '11'], ['100020', '314', '11'],
    // 100030 series
    ['100030', '101', '0101'], ['100030', '102', '0201'], ['100030', '103', '0201'],
    ['100030', '104', '0301'], ['100030', '105', '0501'], ['100030', '106', '0501'],
    ['100030', '107', '0601'], ['100030', '108', '0101'], ['100030', '109', '0101'],
    ['100030', '110', '0101'],
    // 100050 series
    ['100050', '301', '11'], ['100050', '302', '11'], ['100050', '303', '11'],
    ['100050', '304', '33'], ['100050', '305', '33'], ['100050', '306', '44'],
    ['100050', '308', '11'], ['100050', '309', '11'], ['100050', '311', '11'],
    ['100050', '312', '11'], ['100050', '314', '11'],
    // 100100 series
    ['100100', '301', '11'], ['100100', '302', '11'], ['100100', '303', '11'],
    ['100100', '304', '33'], ['100100', '305', '33'], ['100100', '306', '44'],
    ['100100', '308', '11'], ['100100', '309', '11'], ['100100', '311', '11'],
    ['100100', '312', '11'], ['100100', '314', '11'],

    // Year 101
    ['101010', '301', '11'], ['101010', '302', '11'], ['101010', '303', '11'],
    ['101010', '304', '33'], ['101010', '305', '33'], ['101010', '306', '44'],
    ['101010', '308', '11'], ['101010', '309', '11'], ['101010', '311', '11'],
    ['101010', '312', '11'], ['101010', '314', '11'],
    ['101100', '301', '11'], ['101100', '302', '11'], ['101100', '303', '11'],
    ['101100', '304', '33'], ['101100', '305', '33'], ['101100', '306', '44'],
    ['101100', '308', '11'], ['101100', '309', '11'], ['101100', '311', '11'],
    ['101100', '312', '11'], ['101100', '314', '11'],
    ['101030', '101', '0101'], ['101030', '102', '0201'], ['101030', '103', '0201'],
    ['101030', '104', '0301'], ['101030', '105', '0501'], ['101030', '106', '0501'],
    ['101030', '107', '0601'], ['101030', '108', '0101'],

    // Year 104
    ['104020', '301', '11'], ['104020', '302', '11'], ['104020', '303', '11'],
    ['104020', '304', '33'], ['104020', '309', '11'], ['104020', '314', '11'],
    ['104100', '101', '0101'], ['104100', '102', '0201'], ['104100', '103', '0201'],
    ['104100', '104', '0301'], ['104100', '105', '0501'], ['104100', '106', '0501'],
    ['104100', '107', '0601'], ['104100', '108', '0101'],

    // Year 105
    ['105030', '101', '0101'], ['105030', '102', '0201'], ['105030', '103', '0201'],
    ['105030', '104', '0301'], ['105030', '105', '0501'], ['105030', '106', '0501'],
    ['105030', '107', '0601'],
    ['105090', '101', '0101'], ['105090', '102', '0201'], ['105090', '103', '0201'],
    ['105090', '104', '0301'], ['105090', '105', '0501'], ['105090', '106', '0501'],
    ['105090', '107', '0601'],
  ]

  for (const [code, c, s] of combos) {
    const result = await identify(code, c, s)
    if (!result.startsWith('FAIL')) {
      console.log(`${code} c=${c} s=${s} → ${result}`)
    }
    await sleep(250)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
