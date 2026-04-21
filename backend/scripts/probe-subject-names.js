#!/usr/bin/env node
/**
 * Get subject names for all verified combos to map to existing paper structure.
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
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`${res.statusCode}`)) }
      const cs = []; res.on('data', c => cs.push(c)); res.on('end', () => resolve(Buffer.concat(cs)))
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function getSubjectName(code, c, s) {
  const url = `${BASE}?t=Q&code=${code}&c=${c}&s=${s}&q=1`
  try {
    const buf = await fetchPdf(url)
    const d = await pdfParse(buf)
    const cls = d.text.match(/類\s*科[名稱]*\s*[：:]\s*(.+)/m)?.[1]?.trim().substring(0, 40) || '?'
    const sub = d.text.match(/科\s*目[名稱]*\s*[：:]\s*(.+)/m)?.[1]?.trim().substring(0, 80) || '?'
    return `${cls} | ${sub}`
  } catch (e) {
    return `FAIL: ${e.message}`
  }
}

async function main() {
  // Get subject names for all subjects in key sessions
  const queries = [
    // Year 100, 030 series
    // doctor c=101
    ['100030', '101', '0101'], ['100030', '101', '0102'],
    // pharma c=103
    ['100030', '103', '0201'], ['100030', '103', '0202'], ['100030', '103', '0203'],
    ['100030', '103', '0204'], ['100030', '103', '0205'], ['100030', '103', '0206'],
    // medlab c=104
    ['100030', '104', '0107'], ['100030', '104', '0301'], ['100030', '104', '0302'],
    ['100030', '104', '0303'], ['100030', '104', '0304'], ['100030', '104', '0305'],
    // TCM c=107
    ['100030', '107', '0601'], ['100030', '107', '0602'], ['100030', '107', '0603'],
    ['100030', '107', '0604'], ['100030', '107', '0605'], ['100030', '107', '0606'],
    ['100030', '107', '0901'],
    // PT c=106
    ['100030', '106', '0501'], ['100030', '106', '0502'], ['100030', '106', '0503'],
    ['100030', '106', '0504'], ['100030', '106', '0505'], ['100030', '106', '0506'],

    // Year 101, nursing c=105
    ['101030', '105', '0108'], ['101030', '105', '0401'], ['101030', '105', '0402'],
    ['101030', '105', '0403'], ['101030', '105', '0404'],
    // Year 101, doctor2 c=102
    ['101030', '102', '0103'], ['101030', '102', '0104'], ['101030', '102', '0105'], ['101030', '102', '0106'],
    // Year 101, nutrition c=107
    ['101030', '107', '0601'], ['101030', '107', '0602'], ['101030', '107', '0603'],
    ['101030', '107', '0604'], ['101030', '107', '0605'], ['101030', '107', '0606'],

    // Year 100, dental1 c=301 (020 series)
    ['100020', '301', '11'], ['100020', '301', '22'],
    // Year 101, OT c=305
    ['101010', '305', '11'], ['101010', '305', '22'], ['101010', '305', '33'],
    ['101010', '305', '44'], ['101010', '305', '55'], ['101010', '305', '66'],

    // Year 102, medlab c=311
    ['102100', '311', '11'], ['102100', '311', '22'], ['102100', '311', '33'],
    ['102100', '311', '44'], ['102100', '311', '55'], ['102100', '311', '66'],
    // Year 103, c=312 (unknown)
    ['103090', '312', '11'], ['103090', '312', '22'], ['103090', '312', '33'],
    // Year 104, c=312 (unknown)
    ['104020', '312', '11'], ['104020', '312', '22'], ['104020', '312', '33'],
  ]

  for (const [code, c, s] of queries) {
    const name = await getSubjectName(code, c, s)
    console.log(`${code} c=${c} s=${s} → ${name}`)
    await sleep(250)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
