#!/usr/bin/env node
/**
 * 「承上題」題組自足化：把題組根題（含病例/情境的非承上題）的題幹，併入每個
 * 承上題的題幹，讓它在隨機練習單獨出現時也能作答。零成本純文字。
 *
 * 規則：承上題 #N → 同卷(exam_code+subject_tag)往回找最近「非承上題」根題 #M，
 * 把 #M 題幹當題組情境前置。已含「題組情境」者跳過(冪等)。
 *
 * ⚠️ 2026-11-20：**「題號連續」不足以證明那就是根題。** 藥師二階 115090 卷一
 *   #20「承上題，有關調劑流程之SOPs…」配到的 #19 是「對於緩解鼻塞症狀，下列何者
 *   治療效果最佳？」，#78「承上題，下列何者取代erythromycin…」配到的 #78 根題在講
 *   blinatumomab —— 兩邊毫無關係。那份卷有 91 題承上題根本找不到根題，
 *   題庫裡存的前一題不是卷上的前一題。
 *   **根因是分組鍵用了 subject_tag**（兩卷共用同一個 tag，題號互相穿插）。
 *   改成用 subject 分組之後，藥師二階從「可併 2／無根題 91」變成
 *   「可併 72／無根題 0」，而且拿原卷逐題驗過配對是對的。
 *
 *   **掛錯情境比沒有情境更糟**（使用者會照著別題的病例作答），所以另外算一個
 *   「承上題與根題有沒有共同的專有名詞／四字詞」當抽查指標：沒有共同詞的照樣會併，
 *   但會列出來。真的要保守就加 --strict，那些就不併。
 *
 * 用法：node scripts/inline-followup-context.js <questions-file> [--apply] [--strict]
 */
const fs = require('fs')
const FILE = process.argv[2]
const APPLY = process.argv.includes('--apply')
if (!FILE) { console.error('需指定題庫檔'); process.exit(1) }

const MARK = '【題組情境】'
// --strict：只併「看得出是同一組」的。預設是全併 ——
// 真正的保證是「同一卷 + 題號連續」，共同詞只拿來挑抽查對象。
const STRICT = process.argv.includes('--strict')
const isFollow = s => /^\s*承上題?[，,、\s]/.test(s || '')
const alreadyDone = s => (s || '').includes(MARK)

/*
 * 「這兩題看得出是同一組嗎」：共同的專有名詞（5 個字母以上的拉丁字）
 * 或共同的四字中文詞。問句套語（下列何者／敘述正確／最適當…）要先拿掉，
 * 不然每一對都會「有共同詞」。
 */
const STOP = /下列|何者|敘述|正確|錯誤|最適|為何|請問|關於|有關|可能|處置|使用|造成|下述|選項|以下|不包括|何種|哪一|那一|最佳|建議|應該|進行|表現|情形|下圖|如圖/g
function terms(t) {
  const out = new Set()
  const s2 = String(t || '').replace(/^\s*承上題?[，,、\s]*/, '')
  for (const m of s2.match(/[A-Za-z][A-Za-z-]{4,}/g) || []) out.add(m.toLowerCase())
  const cjk = s2.replace(STOP, '\u3000').replace(/[^\u4e00-\u9fff]/g, '\u3000')
  for (const seg of cjk.split('\u3000')) for (let i = 0; i + 4 <= seg.length; i++) out.add(seg.slice(i, i + 4))
  return out
}
function sharedTerm(a, b) {
  const x = terms(a), y = terms(b)
  for (const t of x) if (y.has(t)) return t
  return null
}

/*
 * 光靠四字詞會漏掉兩種很常見、而且一看就知道是同一組的：
 *   1. 兩題都出現同一個人物稱呼 ——「72歲李先生為中風患者…」→「承上題，李先生之
 *      病灶位置最可能為何？」。「李先生」只有三個字，四字詞抓不到。
 *   2. 根題是病例情境、承上題用代名詞回指 ——「一位78歲頸髓第五節完全性損傷的
 *      男性病患…」→「承上題，此患者來物理治療診間運動時該注意：」。沒有任何共同詞。
 *
 * 第 2 條一定要**同時**要求「根題是病例」與「承上題有回指詞」，少一個就會誤收：
 * 藥師二階 115090 #78「承上題，下列何者取代erythromycin…」配到的根題也是病例
 * （35歲女性B細胞急性淋巴性白血病），但它沒有回指詞，而且那一對確實是錯的。
 */
const PERSON = /[王李張陳林黃吳劉蔡楊許鄭謝郭洪曾邱廖賴徐周葉蘇莊呂江何蕭羅高潘簡朱鍾施游詹沈彭胡余盧梁趙顏柯孫魏翁戴方宋范鄧杜侯曹薛丁卓阮馬董唐藍石于姚古紀巫][氏]?(?:先生|小姐|女士|太太|老師|同學|小妹|小弟|媽媽|爸爸|童)/g
const VIGNETTE = /\d+\s*(?:歲|個月大|月大)|病例|個案|案主|病患|患者|主訴|就診|就醫|住院|送醫/
const ANAPHOR = /(?:^|[，,、])\s*承上題?[，,、\s]*[^。？?]{0,30}?(此|該|前述|上述|本案|本例|這位|該位)/
function sameCase(follow, root) {
  const a = new Set(String(root || '').match(PERSON) || [])
  for (const m of String(follow || '').match(PERSON) || []) if (a.has(m)) return m
  if (VIGNETTE.test(root || '') && ANAPHOR.test(follow || '')) return '病例＋回指'
  return null
}

const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'))
const questions = Array.isArray(raw) ? raw : raw.questions

/*
 * 以 (exam_code|**subject**) 分組 —— 一個場次底下每一卷各自是一組。
 *
 * ⚠️ 原本用的是 subject_tag，而 **subject_tag 會跨卷共用**：
 *   藥師二階 115090 的「調劑與臨床」與「藥物治療」tag 都是 pharmacotherapy，
 *   兩卷的題號都從 1 排到 80，混在一起排序之後
 *     · #20「承上題，有關調劑流程之SOPs…」配到的是**另一卷**的 #19
 *       「對於緩解鼻塞症狀，下列何者治療效果最佳？」（原卷的 #19 其實是
 *        「由接受處方箋至交付藥品的流程，下列排序何者正確？」——已拿原卷驗過）
 *     · 題號一直重複，「number 連續遞減」幾乎都不成立 → 91 題被誤判成「無根題」
 *   卷才是題號的作用域，分組就要用卷。
 */
const groups = {}
for (const q of questions) {
  const k = `${q.exam_code}|${q.subject || q.subject_tag || ''}`
  ;(groups[k] = groups[k] || []).push(q)
}
for (const k in groups) groups[k].sort((a, b) => (a.number || 0) - (b.number || 0))

/*
 * 承上題沒有自己的圖時，把根題的圖一起帶過來。
 * ⚠️ 圖有三種存法，三種都要帶：
 *   images[]（補圖工具產的）、image_url（早期的單張圖、重建圖）、
 *   no_image_in_source（原卷本來就沒印那張圖，人工標的）。
 * 只帶 images 的話，根題走 image_url 的那些會變成
 * 「情境提到圖、承上題卻沒有圖」—— 併完反而多出一題壞題。
 */
function inheritFigure(q, root) {
  let touched = false
  if (!(Array.isArray(q.images) && q.images.length) && Array.isArray(root.images) && root.images.length) {
    q.images = [...root.images]; touched = true
  }
  if (!q.image_url && !(Array.isArray(q.images) && q.images.length) && root.image_url) {
    q.image_url = root.image_url; touched = true
  }
  if (!q.no_image_in_source && root.no_image_in_source) { q.no_image_in_source = true; touched = true }
  return touched
}

let fixed = 0, noRoot = 0, skipped = 0, unproven = 0, backfilled = 0
const samples = []
const unprovenList = []
for (const k in groups) {
  const arr = groups[k]
  for (let i = 0; i < arr.length; i++) {
    const q = arr[i]
    /*
     * 併完之後題幹開頭變成「【題組情境】…」，不再是「承上題…」，
     * 所以不能只用 isFollow 判斷要不要處理 —— 第一版漏掉這點，
     * 補搬圖那段變成永遠不會跑到的死碼。
     */
    const mergedFollow = alreadyDone(q.question) && /\n\n\s*承上題/.test(String(q.question || ''))
    if (!isFollow(q.question) && !mergedFollow) continue
    if (alreadyDone(q.question)) {
      // 已經併過文字的，補搬一次圖 —— 第一版只搬 images，漏了 image_url 與
      // no_image_in_source，於是語言治療師 102110 #7 併進「右圖中，標的A 是那條
      // 肌肉？」之後變成一題新的「提到圖但沒有圖」。
      let rootDone = null
      for (let j = i - 1; j >= 0; j--) {
        if (arr[j].number !== arr[j + 1].number - 1) break
        if (!isFollow(arr[j].question)) { rootDone = arr[j]; break }
      }
      if (APPLY && rootDone && inheritFigure(q, rootDone)) backfilled++
      skipped++; continue
    }
    // 往回找最近非承上題根題（number 連續遞減）
    let root = null
    for (let j = i - 1; j >= 0; j--) {
      if (arr[j].number !== arr[j + 1].number - 1) break // number 不連續→不同題組
      if (!isFollow(arr[j].question)) { root = arr[j]; break }
    }
    if (!root) { noRoot++; continue }
    const ctx = (root.question || '').trim()
    if (!ctx) { noRoot++; continue }
    const evid = sharedTerm(q.question, ctx) || sameCase(q.question, ctx)
    if (!evid) {
      unproven++
      unprovenList.push(`#${root.number}→#${q.number} ${String(q.question).replace(/\s+/g, ' ').slice(0, 50)}`)
      if (STRICT) continue
    }
    const cur = (q.question || '').trim()
    const merged = `${MARK}${ctx}\n\n${cur}`
    // 根題有圖、承上題沒圖 → 複製圖過來，讓承上題自足（情境圖如顯微鏡/抹片）
    const copyImg = Array.isArray(root.images) && root.images.length && !(Array.isArray(q.images) && q.images.length)
    if (samples.length < 6) samples.push(`${q.id} #${q.number} ← 根#${root.number}${copyImg ? ' (+圖)' : ''}\n   ${merged.slice(0, 100)}...`)
    if (APPLY) {
      q.question = merged
      if (copyImg) q.images = [...root.images]
      inheritFigure(q, root)
    }
    fixed++
  }
}

console.log(`承上題自足化：可併 ${fixed}，無根題 ${noRoot}，已處理過 ${skipped}`
  + `，看不出關聯 ${unproven}${STRICT ? '（--strict：沒併）' : '（還是併了，建議抽查）'}`
  + (backfilled ? `，補搬圖 ${backfilled}` : ''))
if (unprovenList.length) {
  console.log('\n--- 承上題與根題沒有共同詞，抽查用 ---')
  unprovenList.slice(0, 8).forEach(s => console.log('   ' + s))
  if (unprovenList.length > 8) console.log(`   …還有 ${unprovenList.length - 8}`)
}
console.log('\n--- 範例 ---')
samples.forEach(s => console.log(s))
if (APPLY) {
  fs.writeFileSync(FILE, JSON.stringify(raw, null, 2))
  console.log(`\n✅ 已寫入 ${FILE}`)
} else {
  console.log('\n(dry-run，未寫檔；加 --apply 套用)')
}
