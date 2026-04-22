#!/usr/bin/env node
// Probe 一般警察特考四等 URLs at 考選部 MoEX — broader scan.

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const https = require('https')
const pdfParse = require('pdf-parse')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36'
const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'

function fetchPdf(url, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      rejectUnauthorized: false, timeout: timeoutMs,
      headers: { 'User-Agent': UA, Accept: 'application/pdf,*/*',
                 Referer: 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx' },
    }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        res.resume(); return reject(new Error('302'))
      }
      if (res.statusCode !== 200) {
        res.resume(); return reject(new Error('HTTP ' + res.statusCode))
      }
      const ct = res.headers['content-type'] || ''
      if (!ct.includes('pdf') && !ct.includes('octet')) { res.resume(); return reject(new Error('not PDF')) }
      const cs = []
      res.on('data', c => cs.push(c))
      res.on('end', () => resolve(Buffer.concat(cs)))
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}

async function snapshotPdf(url) {
  try {
    const buf = await fetchPdf(url)
    const { text } = await pdfParse(buf)
    const head = text.replace(/\s+/g, ' ').slice(0, 120)
    return { ok: true, size: buf.length, head }
  } catch (e) {
    return { ok: false, err: e.message }
  }
}

// Try a wide grid on 114060 first (latest year)
// Walking c from 301..420, s in common positions to find 四等 class code
const S_SAMPLES = ['0101', '0201', '0301', '0401', '0501']

;(async () => {
  console.log('=== Wide grid scan on 114060 (c=301~420, sample s codes) ===\n')

  const found = new Map()  // c -> first subject head found
  for (let cn = 301; cn <= 420; cn++) {
    const c = String(cn)
    for (const s of S_SAMPLES) {
      const url = `${BASE}?t=Q&code=114060&c=${c}&s=${s}&q=1`
      const r = await snapshotPdf(url)
      if (r.ok) {
        found.set(c, { s, head: r.head })
        console.log(`c=${c} s=${s}: ${r.head}`)
        break
      }
    }
  }

  if (found.size === 0) {
    console.log('No c codes found on 114060. Trying 113060 and 112070...\n')
    for (const code of ['113060', '112070']) {
      console.log(`--- ${code} ---`)
      for (let cn = 301; cn <= 420; cn++) {
        const c = String(cn)
        for (const s of S_SAMPLES) {
          const url = `${BASE}?t=Q&code=${code}&c=${c}&s=${s}&q=1`
          const r = await snapshotPdf(url)
          if (r.ok) {
            console.log(`c=${c} s=${s}: ${r.head}`)
            break
          }
        }
      }
    }
  }

  console.log('\n=== Done ===')
  console.log(`Found c codes: ${Array.from(found.keys()).join(', ')}`)
})()
