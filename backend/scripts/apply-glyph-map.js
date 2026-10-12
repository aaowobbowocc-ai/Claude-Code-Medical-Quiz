#!/usr/bin/env node
/**
 * 套用 decipher-glyph-map.js 解出來的「壞字 → 正確字」對照表。
 *
 * 這些字是 PDF 字型沒有合法 ToUnicode 對應、當初的抽取器硬猜出來的碼位
 * （猜得很一致，所以是 1:1 替換）。原卷在那些位置是 `�`，讀不回正確字，
 * 對照表是從 1,601 萬字的乾淨語料用 bigram 似然解出來的。
 *
 * **每一處都要通過 bigram 驗證才改**：替換後形成的 (prev,Y) 或 (Y,next)
 * 至少有一組在乾淨語料裡出現過。兩組都沒出現就不改，列出來人工看。
 * 這擋得住「同一個壞字在某些地方其實是別的字」的情況。
 *
 * ⚠️ 刻意不收兩個字：
 *   荊 —— 271 次是合法的（黃荊、牡荊是中藥，荊棘是成語）
 *   蛉 —— 「白蛉」是 sandfly（利什曼原蟲病媒）；但「劑蛉」是劑量。混用，要逐題判。
 *
 *   node scripts/apply-glyph-map.js            # dry-run，列出所有會改的地方
 *   node scripts/apply-glyph-map.js --apply
 */
const fs = require('fs')
const path = require('path')
const { atomicWriteJson } = require('./lib/atomic-write')

const BK = path.join(__dirname, '..')
const APPLY = process.argv.includes('--apply')
const CJK = /[一-鿿]/

/** decipher-glyph-map.js 的結果。margin 標在後面，1.2 以上才收。 */
const MAP = {
  '蜻': '列',  // 8.44
  '蠋': '療',  // 5.88
  '躏': '見',  // 4.85
  '觑': '狀',  // 4.73
  '败': '度',  // 3.46
  '蒠': '塞',  // 3.40
  '蹋': '降',  // 3.15
  '菘': '不',  // 2.57
  '装': '流',  // 2.53
  '褺': '理',  // 1.79
  '甀': '瘀',  // 1.37（margin 低是因為「瘀」本身罕用，例子全對：血甀→血瘀、瀉熱逐甀→瀉熱逐瘀）
  '蜕': '年',  // 1.26
  '葝': '數',  // 1.21（計葝器→計數器、激發次葝→激發次數）
}
// 第二批（2026-10-12）。出現次數少到可以逐一看過，全部查證無誤：
Object.assign(MAP, {
  '襬': '鱗',  // 襬狀細胞癌 / 子宮頸襬狀上皮癌 → 鱗狀
  '裩': '倫',  // 符合醫學裩理 → 醫學倫理
  '蜄': '力',  // 心智能蜄 / 肌蜄 / 氣道阻蜄 / 血流動蜄 / 重症肌無蜄
  '葲': '參',  // 基準葲考線 / 葲與國際衛生組織 / 標準葲考點
  '豣': '切',  // 豣片證實 / 適豣的點頭
})
// 第三批（2026-10-13）。合法用法多的那幾個靠 PROTECT 擋住。
Object.assign(MAP, {
  '蛯': '女',  // 未婚蛯性 / 林蛯士 / 已婚蛯性（3 處）
  '蚮': '兩',  // 蚮側睪丸 / 生產蚮次 / 蚮個ovoid / 生死蚮無憾 / 則蚮地大氣（5 處）
  '蛉': '量',  // 劑蛉 / 量蛉表 / 攝氧蛉 / 容蛉 / 能蛉 / 音蛉（白蛉除外）
  '蹊': '行',  // 執蹊 / 施蹊 / 進蹊 / 逆蹊性 / 平蹊 / 法律上蹊為（鼠蹊、成蹊除外）
  '覄': '立',  // 覄即執行 / 直覄擺放 / 對覄假說（3 處）
  '裶': '律',  // 具法裶上行為（1 處）
  '蝇': '念',  // 照顧理蝇（1 處）
  '谜': '刺',  // 性釋素谜激試驗 / 有棘谜（spur）（2 處）
})

/**
 * 混用的壞字只能做**詞組**取代，不能做字元取代：
 *   蟾 —— 「蟾蜍」是真的（盤古蟾蜍、蟾蜍二烯內酯），但「赇蟾病」是糖尿病
 *   赇 —— 「赇蟾病」「血赇」是糖，「多赇體」是醣（polysaccharide），兩個字不同
 * 詞組先套，剩下的單字再交給 MAP。
 */
const PHRASES = [
  ['赇蟾病', '糖尿病'],
  ['血赇', '血糖'],
  ['多赇體', '多醣體'],
  // 第三批（2026-10-13）
  ['家蹊鼠', '家鼷鼠'],   // Mus musculus 是家鼷鼠，不是「家行鼠」——蹊 在這裡不對到「行」
  ['劑蛉膚', '劑量率'],   // 蛉→量、膚→率，但膚 只有這裡與下面一處是壞的
  ['有效膚', '有效率'],
  ['膳常', '異常'],       // 蛋白質膳常 / 感覺膳常 / 呼吸驅力膳常
  ['差膳', '差異'],       // 無差膳假說 / 有差膳假說
  ['膳位萌出', '異位萌出'],
  // 第四批（2026-10-13）。這幾個壞字的合法用法太多，只能做詞組：
  //   蟾（蟾蜍、蟾酥、金蟾丸都是中藥）、覆（覆蓋、顛覆、覆耳式耳機）、
  //   距（距離、相距，4,427 處）、膚（皮膚、膚電）、西（西醫、西元）
  ['輸蟾管', '輸尿管'],
  ['蟾量', '尿量'],       // ③降低蟾量 ④降低心輸出量——高 PEEP 減少腎灌流
  ['距射', '放射'],       // 放射劑量 / 放射防護屏蔽 / 放射出點（13 處）
  ['覆子', '粒子'],       // 微覆子型樹脂（microfilled）/ 懸浮覆子（aerosol）（10 處）
  ['存活膚', '存活率'],
  ['西床', '臨床'],       // 臨床實務 / 臨床藥學服務 / 臨床診療指引（5 處）
  // bigram 驗證擋下來的 3 處 甀。這些中醫搭配乾淨語料裡沒有，但確實是「瘀」：
  ['聚甀', '聚瘀'],       // 寒留於分肉之間，聚瘀則為痛（靈樞）
  ['甀痺', '瘀痺'],
  ['停甀', '停瘀'],       // 氣血水停瘀腹中
]

/**
 * 保護區：命中這些詞組的字不做任何取代。
 *
 * 第三批有三個字是**合法用法居多**，只有少數是壞的，不保護就會改爛好字：
 *   膚 —— 4,472 處幾乎都是皮膚；180 處非皮膚的全是「膚電反應」
 *          （electrodermal response，心理學正式術語），也是合法的
 *   蹊 —— 108 處幾乎都是鼠蹊部；還有成語「下自成蹊」
 *   膳 —— 514 處幾乎都是膳食、藥膳、《飲膳正要》
 *   蛉 —— 「白蛉」是 sandfly（利什曼原蟲病媒）
 */
const PROTECT = [
  /白蛉/g, /鼠蹊/g, /成蹊/g, /蹊徑/g, /蹊蹺/g,
  /皮膚/g, /膚電/g, /膚色/g, /膚質/g, /肌膚/g, /體膚/g, /膚觸/g, /膚淺/g,
  /膳食/g, /用膳/g, /藥膳/g, /飲膳/g, /團膳/g, /膳宿/g, /供膳/g, /配膳/g, /膳務/g,
]

const SUS = new Set(Object.keys(MAP))

;(async () => {
  const files = fs.readdirSync(BK).filter(f => /^questions(-[a-z0-9-]*)?\.json$/.test(f))

  // ── 乾淨語料的 bigram（不含任何壞字的句子）────────────────────────
  const fwd = new Map()
  const data = {}
  for (const f of files) {
    const j = JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8'))
    const arr = j.questions || j
    if (!Array.isArray(arr)) continue
    data[f] = j
    for (const q of arr) {
      for (const raw of [String(q.question || ''), ...['A', 'B', 'C', 'D'].map(k => String(q.options?.[k] || ''))]) {
        const s = raw.replace(/\s+/g, '')
        if ([...s].some(c => SUS.has(c))) continue
        for (let i = 0; i + 1 < s.length; i++) {
          const a = s[i], b = s[i + 1]
          if (!CJK.test(a) || !CJK.test(b)) continue
          if (!fwd.has(a)) fwd.set(a, new Set())
          fwd.get(a).add(b)
        }
      }
    }
  }
  const seen = (a, b) => fwd.get(a)?.has(b) || false

  /** 回傳 { out, changes:[{from,to,ctx,ok}] }。ok=false 的那一處不會被改。 */
  /** 落在合法詞組裡的位置回 true，這些位置一律不動。 */
  function maskOf(s) {
    const safe = new Array(s.length).fill(false)
    for (const re of PROTECT) {
      re.lastIndex = 0
      let m
      while ((m = re.exec(s)) !== null) {
        for (let j = m.index; j < m.index + m[0].length; j++) safe[j] = true
        if (m.index === re.lastIndex) re.lastIndex++
      }
    }
    return safe
  }

  function fix(text) {
    let s = String(text)
    const phraseHits = []
    // ⚠️ 詞組取代也要看保護區。第一版沒看，結果
    //    「團膳常使用循環菜單」被改成「團異常使用」、
    //    「醫院供膳常見問題」被改成「醫院供異常見」——
    //    那是「團膳 + 常使用」「供膳 + 常見」，膳 字屬於前面的合法詞。
    for (const [a, b] of PHRASES) {
      let at = s.indexOf(a)
      while (at >= 0) {
        const mask = maskOf(s)
        if (mask.slice(at, at + a.length).some(Boolean)) { at = s.indexOf(a, at + 1); continue }
        s = s.slice(0, at) + b + s.slice(at + a.length)
        const hit = phraseHits.find(h => h.from === a)
        if (hit) hit.n++
        else phraseHits.push({ from: a, to: b, n: 1 })
        at = s.indexOf(a, at + b.length)
      }
    }
    if (!s || (![...s].some(c => SUS.has(c)) && !phraseHits.length)) return null
    const chars = [...s]
    const safe = maskOf(s)
    const changes = []
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i]
      if (!SUS.has(c) || safe[i]) continue
      const Y = MAP[c]
      // 前後文取最近的 CJK（跳過空白與標點），用來驗 bigram
      let p = null, n = null
      for (let j = i - 1; j >= 0 && j >= i - 3; j--) { if (CJK.test(chars[j]) && !SUS.has(chars[j])) { p = chars[j]; break } }
      for (let j = i + 1; j < chars.length && j <= i + 3; j++) { if (CJK.test(chars[j]) && !SUS.has(chars[j])) { n = chars[j]; break } }
      const ok = (p && seen(p, Y)) || (n && seen(Y, n)) || (!p && !n)
      const ctx = chars.slice(Math.max(0, i - 6), i + 7).join('')
      changes.push({ from: c, to: Y, ctx, ok })
      if (ok) chars[i] = Y
    }
    for (const h of phraseHits) changes.push({ from: h.from, to: h.to, ctx: h.from + '→' + h.to, ok: true, n: h.n })
    return { out: chars.join(''), changes }
  }

  let nFix = 0, nSkip = 0
  const skipped = []
  const byChar = {}
  const samples = {}
  for (const [f, j] of Object.entries(data)) {
    const arr = j.questions || j
    let touched = false
    for (const q of arr) {
      for (const field of ['question', 'case_context']) {
        const r = fix(q[field])
        if (!r) continue
        for (const c of r.changes) {
          if (c.ok) { nFix++; byChar[c.from] = (byChar[c.from] || 0) + 1; (samples[c.from] ||= []).length < 3 && samples[c.from].push(c.ctx) }
          else { nSkip++; skipped.push({ f, n: q.number, ...c }) }
        }
        if (r.out !== String(q[field])) { if (APPLY) q[field] = r.out; touched = true }
      }
      for (const k of ['A', 'B', 'C', 'D']) {
        if (!q.options || q.options[k] == null) continue
        const r = fix(q.options[k])
        if (!r) continue
        for (const c of r.changes) {
          if (c.ok) { nFix++; byChar[c.from] = (byChar[c.from] || 0) + 1; (samples[c.from] ||= []).length < 3 && samples[c.from].push(c.ctx) }
          else { nSkip++; skipped.push({ f, n: q.number, ...c }) }
        }
        if (r.out !== String(q.options[k])) { if (APPLY) q.options[k] = r.out; touched = true }
      }
    }
    if (touched && APPLY) atomicWriteJson(path.join(BK, f), j)
  }

  console.log('逐字統計（通過 bigram 驗證、已換掉的）：')
  for (const [c, n] of Object.entries(byChar).sort((a, b) => b[1] - a[1])) {
    const to = MAP[c] || (PHRASES.find(p => p[0] === c) || [])[1] || '?'
    console.log(`  ${c} → ${to}   ${String(n).padStart(3)} 處   例：${(samples[c] || []).join('  ')}`)
  }
  console.log(`\n換掉 ${nFix} 處｜bigram 驗不過、保留原字 ${nSkip} 處${APPLY ? '' : '（dry-run）'}`)
  for (const s of skipped) console.log(`  ⊘ ${s.f.replace(/questions-?|\.json/g, '') || 'doctor1'} #${s.n}  ${s.from}→${s.to}  …${s.ctx}…`)
  if (APPLY) console.log('✅ 已寫回')
})().catch(e => { console.error(e.stack); process.exit(1) })
