#!/usr/bin/env node
/**
 * 修「同場次代碼 + 同題號」的覆蓋：某個題號被別張卷（甚至別個考試）的題佔走。
 *
 * 怎麼發現的：dental2 104090 卷一 #50/#63/#78 的題幹在原卷整卷都找不到，
 * 同樣的題幹出現在 doctor2 104090 醫學(五) 的**同題號、同答案**。
 * 104090 同時是醫師與牙醫的場次代碼，爬蟲拿「場次代碼 + 題號」當寫入位置，
 * 於是互相覆蓋。全站掃下來有 50 題同樣的簽章，8 個考試 31 卷
 * （最大一群是營養師的三個科目裝著中醫師二階的題）。
 *
 * ⚠️ 命中率體檢抓不到這種：dental2 104090 卷一 80 題有 77 題題號完全相符（96%），
 * 遠在 audit-paper-alignment.js「<50% 才告警」的門檻之上。
 *
 * 清單來自 audit-foreign-questions.js，但**這裡會重新驗一次**，不信那份 JSON：
 *   閘 1  我們現存的題幹，在自己那張原卷上整卷找不到（確認是外來的）
 *   閘 2  同樣的題幹在同場次代碼、同題號的另一張卷找得到（確認覆蓋來源）
 * 原卷解析不出乾淨的四個選項就不動。id 一律保留。
 *
 * 前置：bash scripts/run-foreign-audit.sh
 *
 *   node scripts/repair-cross-exam-overwrite.js            # dry-run
 *   node scripts/repair-cross-exam-overwrite.js --apply
 *   node scripts/repair-cross-exam-overwrite.js --exam=nutrition
 *
 * --hide-unfixable：原卷解析不乾淨、還原不了的，標 incomplete 先隱藏。
 *   這些題現在正在把「別科的題 + 錯的答案」送到使用者面前（營養師的公共衛生
 *   營養學裝著中醫外科的題，而且答案跟中醫那份還不一樣），隱藏嚴格優於照舊。
 *   等選項能從原卷幾何重建出來再放回去。
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const { resolvePaper, fetchSheet, pdfText } = require('./lib/moex-paper-resolve')
const { skeleton } = require('./lib/moex-normalize')
const { pdfTextClean } = require('./lib/moex-run-overlap')
const { paperQuestions } = require('./fill-civil-gaps')
const { markerOptions } = require('./lib/moex-marker-options')
const { sheetMap } = require('./lib/moex-answer-geo')
const { atomicWriteJson } = require('./lib/atomic-write')

const BK = path.join(__dirname, '..')
const APPLY = process.argv.includes('--apply')
const only = (process.argv.find(a => a.startsWith('--exam=')) || '').split('=')[1]
const HIDE = process.argv.includes('--hide-unfixable')
const SRC = path.join(BK, '_tmp', 'foreign-questions-all.json')
const L = ['A', 'B', 'C', 'D']
const FILE = e => e === 'doctor1' ? 'questions.json' : `questions-${e}.json`

// 與 audit-foreign-questions.js 同一組門檻。低於這個長度比不動，硬比只會誤報。
const MIN = 24
const near = (a, b) => {
  const x = skeleton(String(a)), y = skeleton(String(b))
  if (!x || !y || x.length < MIN || y.length < MIN) return false
  return x.includes(y.slice(0, MIN)) || y.includes(x.slice(0, MIN))
}

// 「這題在這張卷上嗎」：**用整卷原始文字，不要用 pdfStems**。
// pdfStems 會逐題切塊，公式與表格密集的題一切就壞（藥師一階卷三實測：
// 題幹頭被吃掉、表格內容蓋掉問句），於是好題被誤判成外來題。
// 2026-10-11 就是這樣把 pharma1 的 6 題好內容覆寫成更爛的解析，已回退。
//
// 多點取樣：題幹的開頭、1/4、中段各取 20 字，任一命中就算存在。
// 刻意偏向「判定為非外來」——漏抓一題外來題，遠比毀掉一題好題便宜。
const PROBE = 20
// paperText 傳陣列：原始文字 + 消除 run 重疊後的文字，**任一命中就算在卷上**。
// 有些卷的每一列是好幾個互相重疊一個字的 run，直接串會變成
// 「一位266 歲服役中的的男性」，整卷題幹都對不上（醫師二階 103030 醫學(四)
// 命中率 78%，消重疊後 93%）。但抽樣 46 卷只有這兩卷受益、還有一卷變差，
// 所以不改共用的 pdfText，只在這裡當備援。見 lib/moex-run-overlap.js。
function inPaper(stem, texts) {
  const k = skeleton(String(stem))
  const list = [].concat(texts).filter(Boolean)
  if (k.length < PROBE || !list.length) return true        // 比不動就當它在，不要亂動
  const at = [0, Math.floor(k.length / 4), Math.floor(k.length / 2)]
  return list.some(T => at.some(i => i + PROBE <= k.length && T.includes(k.slice(i, i + PROBE))))
}


;(async () => {
  if (!fs.existsSync(SRC)) { console.error('缺 ' + SRC + '，先跑 bash scripts/run-foreign-audit.sh'); process.exit(1) }
  const rows = JSON.parse(fs.readFileSync(SRC, 'utf8'))
    .filter(r => r.sameCodeDonor.length && (!only || r.exam === only))
  console.log(`清單 ${rows.length} 題（強簽章）\n`)

  const cache = {}
  const load = e => cache[FILE(e)] || (cache[FILE(e)] = JSON.parse(fs.readFileSync(path.join(BK, FILE(e)), 'utf8')))

  const byPaper = new Map()
  for (const r of rows) {
    const k = [r.exam, r.code, r.subject].join('\u0000')
    if (!byPaper.has(k)) byPaper.set(k, [])
    byPaper.get(k).push(r)
  }

  let fixed = 0, imageOpt = 0
  const skipped = []
  const needFigure = []
  for (const [k, items] of byPaper) {
    const [exam, code, subject] = k.split('\u0000')
    const arr = (j => j.questions || j)(load(exam))
    const all = arr.filter(q => String(q.exam_code) === String(code) && q.subject === subject)
    let text, parsed, ans, marker = null
    try {
      const p = await resolvePaper({ exam, code: String(code), subject, year: String(all[0]?.roc_year), items: all })
      if (!p) throw new Error('對不到原卷')
      const qbuf = await fetchSheet('Q', String(code), p.c, p.s)
      text = [skeleton(await pdfText(qbuf)), skeleton(await pdfTextClean(qbuf))]
      parsed = await paperQuestions(String(code), p.c, p.s)
      ans = (await sheetMap(String(code), p.c, p.s, Math.max(80, all.length))).map
      // 後備解析：paperQuestions 在某些卷上四個選項全空（標記與文字不在同一個 y、
      // 一列裡有兩到四個選項）。見 lib/moex-marker-options.js。
      try { marker = await markerOptions(qbuf) } catch { marker = null }
    } catch (e) {
      for (const r of items) skipped.push({ ...r, why: '原卷取不到：' + e.message.slice(0, 30) })
      continue
    }
    if (!text || !text[0] || text[0].length < 200) {
      for (const r of items) skipped.push({ ...r, why: '原卷文字層讀不出來' })
      continue
    }

    for (const r of items) {
      const q = all.find(x => +x.number === +r.n)
      if (!q) { skipped.push({ ...r, why: '題庫裡找不到' }); continue }
      // 閘 1：現場重驗「在自己的卷上找不到」
      if (inPaper(q.question, text)) { skipped.push({ ...r, why: '重驗時在原卷找得到，不是外來題' }); continue }
      // 閘 2：現場重驗覆蓋來源
      let from = null
      for (const d of new Set(r.sameCodeDonor.map(x => x.split(' ')[0]))) {
        const dArr = (j => j.questions || j)(load(d))
        const hit = dArr.find(x => String(x.exam_code) === String(code) && +x.number === +r.n
          && !(d === exam && x.subject === subject) && near(x.question, q.question))
        if (hit) { from = `${d} ${hit.subject} #${hit.number}（答${hit.answer}）`; break }
      }
      if (!from) { skipped.push({ ...r, why: '重驗時找不到覆蓋來源' }); continue }

      let o = parsed.get(+r.n)
      const off = ans.get(+r.n)
      const bare0 = t => String(t).replace(/[-​-‏﻿\s　]/g, '')
      const clean0 = x => x && L.every(k => bare0(x.options[k])) && new Set(L.map(k => bare0(x.options[k]))).size === 4
      if (!clean0(o) && marker && clean0(marker.get(+r.n))) o = marker.get(+r.n)
      if (!o || !off || !/^[ABCD]$/.test(String(off))) { skipped.push({ ...r, why: '原卷解析不到或答案不明' }); continue }
      const opts = L.map(x => String(o.options[x] || ''))

      // ── 選項本身是圖的題（化學結構式、定序圖譜、姿勢照片）──
      // 文字解析必然抽到四個空格，不是解析壞掉。題幹是好的，所以照樣還原題幹，
      // 選項標成 image_options 交給 crop-option-images-geometric.js 去裁圖
      // （那支純用 mupdf 讀 PDF 內嵌圖片座標，零成本）。
      const blank = opts.filter(x => !bare0(x)).length
      if (blank >= 3 && String(o.stem || '').replace(/\s/g, '').length >= 12) {
        console.log(`${exam} ${code} ${subject.slice(0, 16)} #${r.n}  ← ${from}  [選項是圖]`)
        console.log(`  移除: ${String(q.question).replace(/\s+/g, ' ').slice(0, 52)}`)
        console.log(`  還原: ${String(o.stem).replace(/\s+/g, ' ').slice(0, 52)}  (答${off})
`)
        if (APPLY) {
          q.question = String(o.stem)
          // 既有慣例是「(圖)」佔位，不是空字串——空字串會讓 audit-all-questions
          // 報 empty_options / answer_not_in_options（2026-10-18 踩到）。
          q.options = { A: '(圖)', B: '(圖)', C: '(圖)', D: '(圖)' }
          q.answer = String(off)
          q.explanation = ''
          delete q.disputed
          delete q.images
          delete q.option_images
          delete q.incomplete_reason
          q.incomplete = 'image_options'
        }
        imageOpt++
        continue
      }

      // ⚠️ `!x.trim()` 擋不住「看起來空、其實塞著 PUA 或零寬字元」的格。
      // 語言治療師 101110 #70/#72/#75/#76/#77 就是這樣過關的：還原後選項變成
      // 「② | ④ |（空）|（空）」，比原本的壞內容還糟。先清掉不可見字元再判。
      const bare = t => String(t).replace(/[-​-‏﻿\s　]/g, '')
      if (opts.some(x => !bare(x)) || new Set(opts.map(bare)).size !== 4) { skipped.push({ ...r, why: '原卷選項不乾淨' }); continue }
      // 下標/上標炸開的簽章：護理師 104030 #60 還原成「NaHCO3 3 _____ 2 ___」。
      if (opts.some(x => /_{3,}/.test(x))) { skipped.push({ ...r, why: '原卷選項下標炸開' }); continue }
      if (opts.some(x => /(?:[A-Z]\d){3,}/.test(x))) { skipped.push({ ...r, why: '原卷上下標炸開' }); continue }
      if (opts.some(x => /代號[：:]|頁次[：:]|座號[：:]/.test(x))) { skipped.push({ ...r, why: '原卷選項黏到頁首' }); continue }
      if (opts.some(x => /^[,.，、]/.test(x.trim()))) { skipped.push({ ...r, why: '原卷選項首位數字跑位' }); continue }
      // 題幹指向圖或圖上編號的，選項通常是「①②③④」而原卷解析撐不住，
      // 而且沒有圖就算還原了也不能作答。一律不還原，走隱藏。
      if (/[下附上右左]\s*[圖表]|如圖|圖示|編號\s*[①-⑩]|[①-⑩]\s*的/.test(String(o.stem))) {
        skipped.push({ ...r, why: '還原出來是含圖題，沒有圖不能作答' }); continue
      }

      console.log(`${exam} ${code} ${subject.slice(0, 16)} #${r.n}  ← ${from}`)
      console.log(`  移除: ${String(q.question).replace(/\s+/g, ' ').slice(0, 56)}  (答${q.answer})`)
      console.log(`  還原: ${String(o.stem).replace(/\s+/g, ' ').slice(0, 56)}  (答${off})`)
      console.log(`  選項: ${opts.join(' | ').slice(0, 92)}\n`)
      if (APPLY) {
        q.question = String(o.stem)
        q.options = { A: opts[0], B: opts[1], C: opts[2], D: opts[3] }
        q.answer = String(off)
        q.explanation = ''
        delete q.disputed
        delete q.images
      }
      fixed++
    }
  }

  // 還原不了的先隱藏：它們現在送到使用者面前的是別科的題 + 錯的答案。
  let hidden = 0
  if (HIDE) {
    for (const s of skipped) {
      if (!/原卷/.test(s.why)) continue          // 只處理「原卷解析不出來」，不碰重驗沒過的
      const arr = (j => j.questions || j)(load(s.exam))
      const q = arr.find(x => String(x.exam_code) === String(s.code) && x.subject === s.subject && +x.number === +s.n)
      if (!q || q.incomplete) continue
      if (APPLY) {
        q.incomplete = true
        q.incomplete_reason = `同場次同題號被 ${s.sameCodeDonor[0]} 覆蓋，原卷選項解析不出來，暫時隱藏`
      }
      hidden++
    }
    console.log(`
暫時隱藏 ${hidden} 題（標 incomplete）`)
  }

  console.log(`還原 ${fixed} 題｜選項是圖、待裁圖 ${imageOpt} 題｜跳過 ${skipped.length}${APPLY ? '' : '（dry-run）'}`)
  const why = {}
  for (const s of skipped) why[s.why] = (why[s.why] || 0) + 1
  if (skipped.length) {
    console.log('跳過原因：' + JSON.stringify(why))
    for (const s of skipped) console.log(`  ⊘ ${s.exam} ${s.code} ${s.subject} #${s.n}：${s.why}`)
  }
  if (APPLY && (fixed || hidden || imageOpt)) {
    for (const [f, j] of Object.entries(cache)) {
      const arr = j.questions || j
      if (j.total !== undefined) j.total = arr.length
      atomicWriteJson(path.join(BK, f), j)
    }
    console.log('✅ 已寫回')
    if (imageOpt) console.log(`⚠️ ${imageOpt} 題的選項是圖，接著跑：node scripts/crop-option-images-geometric.js --all --apply`)
    if (needFigure.length) {
      console.log(`⚠️ 還原的含圖題（${needFigure.length}）還沒有圖：${needFigure.join(', ')}`)
      console.log('   接著跑 node scripts/extract-missing-figures.js --exam=<exam> --apply')
    }
  }
})().catch(e => { console.error(e.stack); process.exit(1) })
