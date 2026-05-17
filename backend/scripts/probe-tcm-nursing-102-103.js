#!/usr/bin/env node
// 探測 102030 / 103030 / 103100 三場次的 (c, s) → 考試/科目 對照。
// 用來找回 tcm1 / tcm2 / 護理師 被污染卷的正確類科代碼。
// 輸出 _tmp/probe-tcm-nursing-102-103.json
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const fs = require('fs')
const path = require('path')
const pdfParse = require('pdf-parse')
const { fetchPdf, buildMoexUrl } = require('./lib/pdf-fetcher')

const PROBE_CACHE = path.join(__dirname, '..', '_tmp', 'probe-cache')
if (!fs.existsSync(PROBE_CACHE)) fs.mkdirSync(PROBE_CACHE, { recursive: true })
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36'
const sleep = ms => new Promise(r => setTimeout(r, ms))

const SESSIONS = ['102030', '103030', '103100']
const C_RANGE = []
for (let c = 101; c <= 112; c++) C_RANGE.push(String(c))
const S_LIST = []
for (const block of ['01', '02', '03', '04', '05', '06', '07']) {
  for (let i = 1; i <= 8; i++) S_LIST.push(`0${block[1]}0${i}`.slice(-4))
}
S_LIST.push('0107', '0108')

function header(rawText) {
  const t = rawText.slice(0, 1400).normalize('NFKC')
  const km = t.match(/類\s*科[名稱]*\s*[：:]\s*([^\n\r]+)/)
  const sm = t.match(/科\s*目\s*[：:]\s*([^\n\r]+)/)
  return {
    klass: km ? km[1].trim().replace(/\s+/g, '').slice(0, 20) : '',
    subject: sm ? sm[1].trim().replace(/\s+/g, '').slice(0, 40) : '',
  }
}

async function getPdf(code, c, s) {
  const fp = path.join(PROBE_CACHE, `Q_${code}_c${c}_s${s}.pdf`)
  try {
    const buf = fs.readFileSync(fp)
    if (buf.length > 1000) return { buf, cached: true }
    return { buf: null, cached: true } // cached miss marker
  } catch {}
  try {
    const buf = await fetchPdf(buildMoexUrl('Q', code, c, s), {
      userAgent: UA, referer: 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx',
    })
    fs.writeFileSync(fp, buf)
    return { buf, cached: false }
  } catch (e) {
    fs.writeFileSync(fp, Buffer.from('')) // mark as miss
    return { buf: null, cached: false, err: e.message }
  }
}

async function main() {
  const hits = []
  let req = 0
  for (const code of SESSIONS) {
    for (const c of C_RANGE) {
      for (const s of S_LIST) {
        const { buf, cached } = await getPdf(code, c, s)
        if (!cached) { req++; await sleep(280) }
        if (!buf) continue
        let hdr
        try { hdr = header((await pdfParse(buf)).text) } catch { continue }
        if (!hdr.klass) continue
        hits.push({ code, c, s, klass: hdr.klass, subject: hdr.subject })
        console.log(`  ${code} c${c} s${s} → 類科「${hdr.klass}」 科目「${hdr.subject}」`)
      }
    }
  }
  const out = path.join(__dirname, '..', '_tmp', 'probe-tcm-nursing-102-103.json')
  fs.writeFileSync(out, JSON.stringify(hits, null, 2))
  console.log(`\n完成：${hits.length} 個有效 (c,s)，網路請求 ${req}。報告：${out}`)
}

main().catch(e => { console.error(e); process.exit(1) })
