#!/usr/bin/env node
/**
 * v2: 加強版 probe — 對未找到的 16 場仔細試所有 c × s 組合
 * 重點：使用 cache 為主、減少 HTTP 請求
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const https = require('https')

const PDF_CACHE = path.join(__dirname, '..', '_tmp', 'pdf-cache')
const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'

// 16 個還沒找到的 codes
const TARGET_CODES = [
  '105090', '106030', '106110', '107030', '107110', '108110',
  '110030', '110110', '111030', '111110', '112030', '112110',
  '113030', '114030', '114100', '115030',
]

const C_CODES = ['101','102','103','105','106','107','108','109','110']
const S_PREFIXES = ['01','02','03','04','05','06','07','08']

function get(url) {
  return new Promise(r => {
    https.get(url, x => {
      if (x.statusCode !== 200) return r({status: x.statusCode});
      const c=[]; x.on('data',d=>c.push(d)); x.on('end',()=>r({status:200, buf:Buffer.concat(c)}));
    }).on('error', () => r(null));
  });
}

async function getPdfHeader(buf) {
  const mupdf = await import('mupdf')
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  return doc.loadPage(0).toStructuredText('preserve-whitespace').asText().slice(0,500).normalize('NFKC')
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function probe(code) {
  // First check cache for any nursing PDF at this code
  const cached = fs.readdirSync(PDF_CACHE).filter(f => f.includes(`_${code}_`))
  for (const f of cached) {
    const m = f.match(/c(\d+)_s(\w+?)(?:_[QSM])?\.pdf$/)
    if (!m) continue
    const c = m[1], s = m[2]
    try {
      const buf = fs.readFileSync(path.join(PDF_CACHE, f))
      const head = await getPdfHeader(buf)
      if (/類\s*科[：:]?\s*護理師/.test(head)) {
        return { c, baseS: s, source: 'cache:' + f }
      }
    } catch {}
  }

  // Probe MoEX with each c × s_prefix01
  for (const c of C_CODES) {
    for (const sp of S_PREFIXES) {
      const s = sp + '01'
      const url = `${BASE}?t=Q&code=${code}&c=${c}&s=${s}&q=1`
      const r = await get(url)
      await sleep(60)
      if (r?.status !== 200 || r.buf.length < 1000) continue
      const head = await getPdfHeader(r.buf)
      if (/類\s*科[：:]?\s*護理師/.test(head)) {
        // Save to cache
        fs.writeFileSync(path.join(PDF_CACHE, `nursing_${code}_c${c}_s${s}_probe.pdf`), r.buf)
        return { c, baseS: s, source: 'probed' }
      }
    }
  }
  return null
}

async function main() {
  const results = {}
  for (const code of TARGET_CODES) {
    process.stdout.write(`${code}: probing... `)
    const found = await probe(code)
    if (found) {
      console.log(`✓ c=${found.c} baseS=${found.baseS} (${found.source})`)
      results[code] = found
    } else {
      console.log('✗ not found')
      results[code] = null
    }
  }
  fs.writeFileSync(path.join(__dirname, '..', '_tmp', 'nursing-probe-v2.json'), JSON.stringify(results, null, 2))
  console.log('\nSaved _tmp/nursing-probe-v2.json')
}

main().catch(e => { console.error(e); process.exit(1) })
