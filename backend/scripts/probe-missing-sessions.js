#!/usr/bin/env node
/**
 * 對缺漏年份的考試做廣 probe，找 MoEX PDF。
 * 策略：根據既有最近年份的 (c, s) 組合，往後/往前推測新年份的場次代碼。
 *
 * Usage:
 *   node scripts/probe-missing-sessions.js --exam audiologist --years 115
 *   node scripts/probe-missing-sessions.js --exam vet --years 115
 *   node scripts/probe-missing-sessions.js --exam civil-senior --years 100,101,102,103,104,105
 */
require('dotenv').config()
const https = require('https')
const fs = require('fs')
const path = require('path')
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const CACHE = path.join(__dirname, '..', '_tmp', 'pdf-cache')
fs.mkdirSync(CACHE, { recursive: true })

const args = process.argv.slice(2)
const examFilter = args[args.indexOf('--exam') + 1]
const yearsArg = args[args.indexOf('--years') + 1]
const years = yearsArg.split(',')

const EXPECTED_NAMES = {
  doctor1: '醫師', doctor2: '醫師',
  dental1: '牙醫師', dental2: '牙醫師',
  pharma1: '藥師', pharma2: '藥師',
  medlab: '醫事檢驗師', radiology: '醫事放射師',
  pt: '物理治療師', ot: '職能治療師',
  nursing: '護理師', nutrition: '營養師',
  tcm1: '中醫師', tcm2: '中醫師',
  vet: '獸醫師',
  audiologist: '聽力師',
  'speech-therapist': '語言治療師',
  rt: '呼吸治療師',
  'social-worker': '社會工作師',
  judicial: '司法',
  'civil-senior': '高考',
  customs: '關務',
  police: '警察',
  police4: '警察',
  lawyer1: '律師',
}

function get(url) {
  return new Promise((res) => {
    https.get(url, r => {
      if (r.statusCode !== 200) { r.destroy(); return res(null) }
      const ch = []; r.on('data', c => ch.push(c)); r.on('end', () => res(Buffer.concat(ch)))
    }).on('error', () => res(null))
  })
}

async function checkPdf(buf, expectName) {
  try {
    const mupdf = await import('mupdf')
    const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
    const text = doc.loadPage(0).toStructuredText('preserve-whitespace').asText().normalize('NFKC')
    const klass = text.match(/類\s*科[：:名稱]*\s*([^\s\n（(]{2,15})/)?.[1] || ''
    const subj = text.match(/科\s*目[：:名稱]*\s*([^\s\n（(]{2,30})/)?.[1] || ''
    const isMatch = klass.includes(expectName)
    return { klass, subj, isMatch }
  } catch { return null }
}

async function probe(code, c, s, expectName) {
  const url = `${BASE}?t=Q&code=${code}&c=${c}&s=${s}&q=1`
  const buf = await get(url)
  if (!buf || buf.length < 5000) return null
  const meta = await checkPdf(buf, expectName)
  return meta && meta.isMatch ? { url, ...meta, buf } : null
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const expectName = EXPECTED_NAMES[examFilter]
  if (!expectName) { console.error('Unknown exam:', examFilter); process.exit(1) }

  console.log(`Probing ${examFilter} (expect 類科:${expectName}) for years: ${years.join(',')}`)

  // 從 questions JSON 找該 exam 最近年份的 c, s 組合作為提示
  const examFile = examFilter === 'doctor1' ? 'questions.json' : `questions-${examFilter}.json`
  const fp = path.join(__dirname, '..', examFile)
  let knownClassCodes = new Set(['101','102','103','104','105','106','107','108','109','110','111','112','113','301','302','303','304','305','306','307','308','309','310','311','312','313','314','315','316','317','318','319','320','321','322','323'])

  let knownSCodes = new Set(['11','22','33','44','55','66','0101','0102','0103','0104','0105','0106','0107','0201','0202','0203','0204','0205','0206','0301','0302','0303','0304','0305','0306','0401','0402','0403','0404','0405','0406','0501','0502','0503','0504','0505','0506','0601','0602','0603','0604','0605','0606','0701','0702','0801','0802','0901','0902','0903','0904','0905','0906','1001','1002'])

  if (fs.existsSync(fp)) {
    const data = JSON.parse(fs.readFileSync(fp))
    const arr = data.questions || data
    // 從現有題目反推 c, s（id 格式可能含 s 例如 102110_0205_38）
    for (const q of arr) {
      const m = String(q.id || '').match(/^\d+_([\w]+)_/)
      if (m) knownSCodes.add(m[1])
    }
  }

  const sessionSuffixes = ['010','020','030','050','060','070','080','090','100','110','111','120','130','140']
  const hits = []
  let probeCount = 0

  for (const y of years) {
    let yearHits = 0
    for (const suffix of sessionSuffixes) {
      const code = `${y}${suffix}`
      // 先試一個 (c, s) 試水溫
      let foundCS = null
      outer: for (const c of knownClassCodes) {
        for (const s of [...knownSCodes].slice(0, 6)) {  // 試 6 個常用 s
          probeCount++
          const r = await probe(code, c, s, expectName)
          await sleep(100)
          if (r) {
            foundCS = { c, s }
            console.log(`✓ ${code} c=${c} s=${s} 類科:${r.klass} 科目:${r.subj}`)
            fs.writeFileSync(path.join(CACHE, `${examFilter}_${code}_c${c}_s${s}_Q.pdf`), r.buf)
            hits.push({ code, c, s, ...r, buf: undefined })
            break outer
          }
        }
      }
      if (foundCS) {
        // 同 (code, c) 展開所有 s
        for (const s of knownSCodes) {
          if (s === foundCS.s) continue
          probeCount++
          const r = await probe(code, foundCS.c, s, expectName)
          await sleep(100)
          if (r) {
            console.log(`  + s=${s} 科目:${r.subj}`)
            fs.writeFileSync(path.join(CACHE, `${examFilter}_${code}_c${foundCS.c}_s${s}_Q.pdf`), r.buf)
            hits.push({ code, c: foundCS.c, s, ...r, buf: undefined })
          }
        }
        yearHits++
      }
    }
    if (yearHits === 0) console.log(`✗ ${y} 年: 無命中`)
  }

  console.log(`\n命中 ${hits.length} 個 PDF (${probeCount} 次 probe)`)
  fs.writeFileSync(path.join(__dirname, '..', '_tmp', `probe-${examFilter}-${years.join('_')}.json`), JSON.stringify(hits, null, 2))
}
main().catch(e => { console.error(e); process.exit(1) })
