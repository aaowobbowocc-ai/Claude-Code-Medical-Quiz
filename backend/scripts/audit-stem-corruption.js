#!/usr/bin/env node
/**
 * 題幹文字損壞稽核：這題確實印在這張卷上，但**我們存的文字跟原卷不一樣**。
 *
 * 為什麼需要：既有的稽核都只問「這題在不在這張卷上」。
 * 醫師二階 103030 醫學(四) #38 我們存的是「有關**狂犬病**（scabies）的敘述」，
 * 原卷是「有關**疥瘡**（scabies）」——rabies / scabies 搞混。
 * 題幹大部分都對，所以「在不在卷上」永遠回答「在」，這類錯誤看不見。
 *
 * 這類比「外來題」危險：營養師考卷出現中醫題，使用者一看就知道不對；
 * 「狂犬病（scabies）」看起來像正常題目，會被直接背下去。
 * 同一卷還有「足蟲（tinea pedis）」（足癬）、「脾子偶硬」（頸子僵硬）、
 * 「陣述」（陳述）、「費寶」（寶寶）——整批是當初走 OCR 補題留下的。
 *
 * 判準：題幹的 8 字滑動視窗，有多少比例出現在原卷文字裡。
 *   乾淨的題是 100%，壞掉的落在 35~87%。
 *   醫師二階 103030 醫學(四) 校準（已知 16 壞 / 64 好）：
 *     門檻 0.90 → 抓到 15/16，**誤報 0**。
 *
 * ⚠️ 題組題會自然偏低：`【題組情境】` 是把上一題的情境併進來的
 * （[[project_followup_questions]]），那段文字在原卷的別處。這種會標記出來分開看。
 * ⚠️ 只讀不寫。輸出是「要人看一眼的清單」，而且修的時候要逐題對原卷，
 * 不能整批照抄——原卷解析本身也會壞（見 repair-cross-exam-overwrite.js 的教訓）。
 *
 *   node scripts/audit-stem-corruption.js --exam=doctor2
 *   node scripts/audit-stem-corruption.js --exam=doctor2 --min=0.95
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const { resolvePaper, fetchSheet, pdfText } = require('./lib/moex-paper-resolve')
const { pdfTextClean } = require('./lib/moex-run-overlap')
const { skeleton } = require('./lib/moex-normalize')

const BK = path.join(__dirname, '..')
const only = (process.argv.find(a => a.startsWith('--exam=')) || '').split('=')[1]
const MIN = +((process.argv.find(a => a.startsWith('--min=')) || '').split('=')[1]) || 0.90
const N = 8                      // 滑動視窗長度
const MIN_LEN = N + 4            // 太短的題幹比不動

const SKIP = new Set(['gsat', 'ast', 'driver-car', 'driver-moto', 'post-indoor', 'post-outdoor',
  'railway-admin', 'railway-transport', 'state-finance', 'state-hr', 'state-it', 'state-mgmt',
  'teacher-elementary', 'teacher-kindergarten', 'teacher-secondary', 'teacher-special', 'teacher-special-gifted'])
const EXAM = f => f.replace('questions-', '').replace('questions.json', 'doctor1').replace('.json', '')

/** 題幹的 N 字滑動視窗有多少比例出現在原卷文字裡（兩種抽法任一命中即可）。 */
function cover(stem, texts) {
  const k = skeleton(String(stem))
  if (k.length < MIN_LEN) return null
  let hit = 0, tot = 0
  for (let i = 0; i + N <= k.length; i++) {
    tot++
    const w = k.slice(i, i + N)
    if (texts.some(T => T.includes(w))) hit++
  }
  return tot ? hit / tot : null
}

;(async () => {
  const files = fs.readdirSync(BK).filter(f => /^questions(-[a-z0-9-]*)?\.json$/.test(f))
  const report = []
  let papers = 0, unresolved = 0, judged = 0
  for (const f of files) {
    const exam = EXAM(f)
    if (SKIP.has(exam) || (only && exam !== only)) continue
    const arr = (j => j.questions || j)(JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8')))
    if (!Array.isArray(arr)) continue

    const groups = new Map()
    for (const q of arr) {
      if (!q.exam_code || !q.subject) continue
      const k = q.exam_code + '\u0000' + q.subject
      if (!groups.has(k)) groups.set(k, [])
      groups.get(k).push(q)
    }
    for (const [k, items] of groups) {
      const [code, subject] = k.split('\u0000')
      let texts
      try {
        const p = await resolvePaper({ exam, code: String(code), subject, year: String(items[0].roc_year), items })
        if (!p) throw new Error('no paper')
        const buf = await fetchSheet('Q', String(code), p.c, p.s)
        texts = [skeleton(await pdfText(buf)), skeleton(await pdfTextClean(buf))]
      } catch { unresolved++; continue }
      if (!texts[0] || texts[0].length < 200) { unresolved++; continue }

      const scored = items.map(q => ({ q, c: cover(q.question, texts) })).filter(x => x.c !== null)
      if (!scored.length) { unresolved++; continue }
      // 自我檢查：整卷中位數就低的話，多半是對到錯的卷或原卷文字層壞掉，整卷不判。
      const med = scored.map(x => x.c).sort((a, b) => a - b)[Math.floor(scored.length / 2)]
      if (med < 0.9) { unresolved++; continue }
      papers++
      judged += scored.length

      for (const { q, c } of scored) {
        if (c >= MIN) continue
        const group = /【題組情境】|^承上題/.test(String(q.question))
        report.push({ exam, code, subject, n: q.number, cover: +c.toFixed(3), group,
          stem: String(q.question).replace(/\s+/g, ' ').slice(0, 80) })
      }
    }
  }

  report.sort((a, b) => a.cover - b.cover)
  const plain = report.filter(r => !r.group)
  for (const r of plain.slice(0, 60)) {
    console.log(`${(r.cover * 100).toFixed(0).padStart(3)}%  ${r.exam} ${r.code} ${r.subject.slice(0, 16)} #${r.n}  ${r.stem.slice(0, 56)}`)
  }
  const dest = path.join(BK, '_tmp', only ? `stem-corruption-${only}.json` : 'stem-corruption.json')
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, JSON.stringify(report, null, 1))
  console.log(`\n判了 ${papers} 卷 ${judged} 題（${unresolved} 卷對不到／整卷可疑而跳過）`)
  console.log(`覆蓋率 < ${MIN}：${report.length} 題（其中題組題 ${report.length - plain.length} 題，另計）`)
  console.log(`📄 ${dest}`)
})().catch(e => { console.error(e.stack); process.exit(1) })
