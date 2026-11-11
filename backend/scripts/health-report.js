#!/usr/bin/env node
/**
 * 題庫健康總覽：一次掃出所有「使用者會看到的壞資料」。
 *
 * 分成兩類，處理優先序不同：
 *   A. 已被擋住的 —— 標了 incomplete，前端不會顯示。是待辦，不是傷害。
 *   B. 還看得到的 —— 沒有任何標記，使用者現在就會遇到。這才是要優先處理的。
 *
 * 用法：node scripts/health-report.js
 */
const fs = require('fs')
const path = require('path')
const { skeleton, normText } = require('./lib/moex-normalize')
const { IMAGE_REF } = require('./lib/image-ref')

const DIR = path.join(__dirname, '..')
const PUA = /[-]/
const HEADER = /^(代號|頁次|座號|等別|類科名稱|科目名稱|考試時間|考試名稱)\s*[：:]/
const INVIS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u200B-\u200D\u2060\uFEFF]/

const files = fs.readdirSync(DIR).filter(f => /^questions(-.*)?\.json$/.test(f) && !/\.bak/.test(f))
const tally = { total: 0, incomplete: {}, visible: {} }
const detail = {}

// image_url 是相對於 frontend/public 的網址路徑（/signs/… 或 /question-images/…）。
// 這些圖走 Vercel 不走 jsDelivr，所以檔案就在隔壁的 frontend/public 底下。
const PUBLIC = path.join(DIR, '..', 'frontend', 'public')
const existCache = new Map()
const imgExists = url => {
  const u = String(url).replace(/^\//, '').split('?')[0]
  if (!existCache.has(u)) existCache.set(u, fs.existsSync(path.join(PUBLIC, u)))
  return existCache.get(u)
}

const bump = (bucket, key, exam) => {
  tally[bucket][key] = (tally[bucket][key] || 0) + 1
  const d = (detail[key] = detail[key] || {})
  d[exam] = (d[exam] || 0) + 1
}

for (const f of files) {
  const raw = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'))
  const arr = Array.isArray(raw) ? raw : raw.questions
  if (!arr) continue
  const exam = f === 'questions.json' ? 'doctor1' : f.replace('questions-', '').replace('.json', '')
  const dupKeys = new Map()

  for (const q of arr) {
    tally.total++
    if (q.incomplete) { bump('incomplete', String(q.incomplete), exam); continue }

    const opts = q.options || {}
    const vals = ['A', 'B', 'C', 'D'].map(k => String(opts[k] ?? ''))
    const stem = String(q.question ?? '')

    // 標誌辨識題的題幹本來就是空的——題目就是那張標誌圖，選項是它的含義。
    // 駕照 127+100 題都是這種，把它們算成壞題會讓數字虛胖。有圖就不算。
    const hasImg = !!(q.image_url || q.image || (q.images && q.images.length))
    const headStyle = /[一-鿿]\s*$/.test(stem) && Math.max(0, ...vals.map(v => skeleton(v).length)) >= 6
    // 英文克漏字的題幹**本來就該是空的**：空格在共用引文裡，題目沒有自己的問句。
    // 引文放在 case_context（前端 Practice.jsx 會單獨渲染一塊），裡面已經標了
    // 「本題問第 N 格」。要求這種題有題幹，只會逼人去塞上一題的選項進去 ——
    // repair-cloze-group-stems.js 清掉的正是那種假題幹。
    if (!stem.trim()) { if (!hasImg && !q.case_context) bump('visible', '題幹空白且無圖', exam) }
    // 題幹短不一定壞：「汽車油箱加油時：」就是完整的題目。
    // 真正壞的是短到不成句、選項也撐不住語意的（例如只剩 "lasted"）。
    // 收尾是冒號或問號就是完整的提問，不管多短 ——「膽囊位於：」「何謂主刑？」
    // 都是好題。加這條之後 10 筆剩 5 筆，而剩下的「8 m / s ）」「有一 60」
    // 確實是題幹被截斷（兩筆都已修回原卷：ast 114 物理其實是 #6、radiology 106100 #3）。
    //
    // 2026-11-11 再收一次誤報：公路局題庫有一種「題幹是句子的開頭、由選項接完」的
    // 寫法，機車法規 930 題裡有 379 題結尾沒有任何標點 ——
    //   「機車」＋「不可以借用他車牌照行駛」、「騎車時應」＋「正視前方並注意左右來車」
    // 短不代表壞。而剛修掉的那兩筆真截斷，收尾是 `）` 與數字，不是中文字。
    // 判準：**收尾是中文字、而且選項撐得起語意**（最長的選項 ≥6 字）就當它是完整的。
    else if (skeleton(stem).length < 5 && !hasImg && !headStyle && !/[：:？?。]\s*$/.test(stem)) bump('visible', '題幹殘缺(<5字)', exam)
    // 選項數量不是一律 4 個：駕照是非題只有 ○/✕ 兩個、部分選擇題只有三個。
    // 一律要求 ABCD 齊全會把 2,405 題正常的駕照題算成壞題。
    // 真正的壞是「可選的選項少於兩個」或「中間有洞」（A、C 有但 B 空）。
    const filled = vals.map(v => !!v.trim())
    const nOpt = filled.filter(Boolean).length
    if (nOpt < 2) bump('visible', '可選項不足兩個', exam)
    else if (filled.slice(0, nOpt).some(x => !x)) bump('visible', '選項中間有空洞', exam)
    if (vals.some(v => HEADER.test(v))) bump('visible', '選項是頁首頁尾', exam)
    if (PUA.test(stem) || vals.some(v => PUA.test(v))) bump('visible', 'PUA 豆腐字', exam)
    // 看不見的字元：題源的選項標記被當 cp1252 解過一次變成 C1 控制字元，黏在選項開頭。
    // 畫面上完全看不出來，但字串比對會靜默失效（見 strip-invisible-chars.js）。
    // PUA 那條規則抓不到它們 —— 2026-11-09 全站 805 題就是這樣躲了很久。
    if (INVIS.test(stem) || vals.some(v => INVIS.test(v))) bump('visible', '看不見的控制字元', exam)
    // 複選題的答案是 "A,B,C"，那是正常資料（律師一試、部分公職考）。
    const ansRaw = String(q.answer ?? '').trim()
    const ansOk = /^[A-E](\s*[,、]\s*[A-E])*$/.test(ansRaw) || /^[○✕]/.test(ansRaw)
    if (!ansOk && !q.disputed) bump('visible', '答案格式無法辨識', exam)
    // 比選項是否重複不能用 skeleton：它會連減號一起去掉，
    // 放射師的「10 -4 / 10 -2 / 10 2 / 10 4」（10⁻⁴、10⁻²、10²、10⁴）
    // 會全部變成 "104"，460 題裡絕大多數是這樣誤判出來的。
    // 這裡只做 NFC＋去空白，保留所有符號。
    // 選項是圖的題（中藥材辨識、血球圖、化學結構式），options 文字就是
    // 「(圖)(圖)(圖)(圖)」，前端靠 option_images 顯示。那不是重複，是正常資料。
    // 還有一種：**原卷自己就印了兩個一模一樣的選項**（考選部的排版錯誤）。
    // 逐字還原就一定會重複，改掉反而是竄改試題。核對過原卷的題標 duplicate_in_source，
    // 跟「原卷就沒有圖」的 no_image_in_source 同一個用法。
    const optImg = q.option_images && Object.keys(q.option_images).length >= 4
    const nonEmpty = (optImg || q.duplicate_in_source) ? [] : vals.filter(v => v.trim()).map(v => normText(v))
    if (nonEmpty.length >= 2 && new Set(nonEmpty).size < nonEmpty.length) bump('visible', '選項重複', exam)
    // ⚠️ 這條與下面的 imgKey 原本各自寫 `!q.images && !q.image`，**漏掉 image_url**——
    //    而同一個檔案上面的 hasImg 是認得的。全站 1,104 題走 image_url（駕照標誌題、
    //    醫事類含圖題；前端 QuestionImages 的 imageUrl prop 一直在顯示它），
    //    於是 42 題明明有圖卻被報成「提到圖但沒有圖」。一律用 hasImg。
    if (IMAGE_REF.test(stem) && !hasImg && !q.no_image_in_source) bump('visible', '提到圖但沒有圖', exam)
    // 反過來的風險：image_url 變成「不必修也能閉嘴」的後門。所以檔案不在就照樣報。
    if (q.image_url && !imgExists(q.image_url)) bump('visible', '圖片路徑指到不存在的檔', exam)
    // 組合題「①②③」的圈號被 PDF 字型全壓成 ①（見 decode-circled-options.js）。
    // 這種壞法原本完全看不見：只有剛好壓成四個選項一模一樣時才會被「選項重複」抓到，
    // 壓成「①①①／①①②」就靜默錯下去。一個選項裡出現兩個以上同一個圈號就是壞的。
    // ⚠️ 光看「同一個圈號出現兩次」會大量誤報，重複往往是題目本意：
    //      dental2 101010 #69「①② 正確，且 ② 為 ① 之合理解釋」（正誤＋理由題型）
    //      pt 110101 #21「①①①①①①→休息一分鐘→②②②②②②」（集團練習排程）
    //      radiology 115090 #37「線性衰減係數：①＞②＞③＞④；CT值：①＞②＞③＞④」
    //    真的塌掉的選項幾乎只剩圈號 —— 去掉圈號與連接詞後留不下兩個字以上的內容。
    //    另外，排序題的選項會用滿題幹的 ①..K（只是順序不同、可以重複）：
    //      radiology 115090 #55 線圈由內而外 ④③①②①（真空層出現兩次）
    //      rt 101100 #73 PALS 去顫循環 ⑤②④③⑤②①
    //    字型真的塌掉時，四個選項湊不滿題幹的 ①..K —— 用這點把排序題擇出來。
    const kStem = Math.max(0, ...[...stem].filter(c => /[①-⑳]/.test(c)).map(c => c.codePointAt(0) - 0x245F))
    const seen = new Set(vals.join('').match(/[①-⑳]/g) || [])
    const covers = kStem > 0 && seen.size >= kStem
    const bare = vals.map(v => v.replace(/[①-⑳\s、，和及僅]/g, ''))
    if (!covers && vals.some((v, i) => /(①)[^①]*\1/.test(v) && bare[i].length <= 2)) bump('visible', '選項圈號塌掉', exam)

    // 看圖辨識題的題幹與選項本來就一模一樣，**差別在圖**：
    //   dental2 102020 卷二 #68/#69「下圖中有何種牙齒相關的病變？」答 A / D
    //   rt 106020 #19/#20「下圖為何種通氣模式？」答 B / A
    // 兩題各有自己的圖，是兩道不同的題，不是重複。圖要一起進比對鍵，
    // 否則這類題會永遠掛在「同卷內完全重複」裡誤導人。
    // image_url 也要進鍵：駕照 car_sign_5/10/14/86 題幹都只有「狹路」、選項都是 ○/✕，
    // 答案 A/B/B/B —— 差別整個在那張標誌圖（sign_005/010/014/086.png）。
    // 危險感知題同理，差別在**影片**：moto_hazard_72/74 題幹與選項一字不差、
    // 答案都是 B，看的是 4213 與 4215 兩支不同的影片。
    const imgKey = JSON.stringify(q.images || q.image || q.image_url || q.video_url || q.option_images || null)
    const k = `${q.exam_code}|${q.subject}||${skeleton(stem)}||${vals.map(skeleton).join('|')}||${imgKey}`
    if (skeleton(stem).length >= 8) {
      if (dupKeys.has(k)) bump('visible', '同卷內完全重複', exam)
      else dupKeys.set(k, 1)
    }
  }
}

const show = (title, obj) => {
  const rows = Object.entries(obj).sort((a, b) => b[1] - a[1])
  const sum = rows.reduce((s, r) => s + r[1], 0)
  console.log(`\n${title}（共 ${sum} 題）`)
  for (const [k, n] of rows) {
    const by = Object.entries(detail[k] || {}).sort((a, b) => b[1] - a[1]).slice(0, 4)
      .map(([e, c]) => `${e} ${c}`).join('、')
    console.log(`  ${String(n).padStart(5)}  ${k.padEnd(24)} ${by}`)
  }
}

console.log(`全站 ${tally.total.toLocaleString()} 題`)
show('■ 使用者現在看得到的問題', tally.visible)
show('□ 已標 incomplete（前端隱藏，屬待辦）', tally.incomplete)
