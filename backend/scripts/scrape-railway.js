#!/usr/bin/env node
// Scrape 鐵路特考佐級 (Railway junior-level special exam) — 運輸營業 + 事務管理.
// 鐵路特考 was discontinued after 112 (台鐵 corporatised 2024). Historical bank
// 100-112, positioned as 台鐵招考 practice material.
//
// 類科 → c-code:  運輸營業 c=903 / 事務管理 c=901
// Papers (all pure MCQ, 佐級):
//   運輸營業: 國文 / 公民與英文 / 企業管理大意 / 鐵路運輸學大意
//   事務管理: 國文 / 公民與英文 / 事務管理大意 / 法學大意
// 國文 has 複選題 (Q36-45, options A-E) — we keep only 單選 (single A-D answer).
//
// Session/class/subject codes per year: scripts/_railway-map.json (probe-railway.js).
// Usage: node scripts/scrape-railway.js [--exam transport|admin] [--year 112]

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const { fetchPdf } = require('./lib/pdf-fetcher')
const pdfjsLib = require('pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js')
const pdfParse = require('pdf-parse')

const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const PUA_RE = new RegExp("[\uE000-\uF8FF]", "g")
// 選項標記 Ⓐ Ⓑ Ⓒ Ⓓ Ⓔ = U+E18C ~ U+E190（見 reference_option_markers）。
// 這是切選項最可靠的訊號：靠 x 間距猜會失手 —— 103070 國文 #2 的四個選項擠在
// 同一列、字距全部小於門檻，整列被當成一個選項，那一題於是整題消失。
// ⚠️ 範圍只到 U+E190。同一張卷還有 U+E1C0~E1C3（題幹裡的 ①②③④），
//    那些不是選項標記，掃進來會把題幹切碎。
const OPT_MARK_RE = /[\uE18C-\uE190]/
// Old (100-105) PDFs use CJK Compatibility Ideographs (U+F900-FAFF, e.g. 路=U+F937).
// NFC canonical normalisation maps them to unified ideographs without touching
// fullwidth punctuation (that would be NFKC).
const stripPUA = s => typeof s === "string" ? s.normalize("NFC").replace(PUA_RE, "").trim() : s

// ── PDF text positioning (same approach as scrape-police4.js) ────────────
async function extractPositionedText(buf) {
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise
  const items = []
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const content = await page.getTextContent()
    for (const it of content.items) {
      if (!it.str.trim()) continue
      items.push({ x: Math.round(it.transform[4]), y: Math.round(it.transform[5]), page: p, str: it.str.normalize('NFC') })
    }
  }
  items.sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x)
  return items
}

function buildLogicalLines(items) {
  const rows = []
  let curY = null, cur = []
  for (const it of items) {
    if (curY === null || Math.abs(it.y - curY) > 3 || (cur.length && cur[0].page !== it.page)) {
      if (cur.length) rows.push(cur)
      cur = [it]; curY = it.y
    } else cur.push(it)
  }
  if (cur.length) rows.push(cur)

  const lines = []
  for (const row of rows) {
    row.sort((a, b) => a.x - b.x)

    // 被字型甩到標記左邊的數字。
    // 107070 事務管理 #7 的四個選項是「1年」「2年」「5年」「7年」，而文字層把
    // 2 5 7 印在**各自標記的左邊**：Ⓐ 1 年 ⟨2⟩ Ⓑ 年 ⟨5⟩ Ⓒ 年 ⟨7⟩ Ⓓ 年。
    // 照 x 切會變成「1年2」「年5」「年7」「年」—— 四個選項全毀，而且答案
    // 指到不存在的選項，那一題於是整題進不了題庫。
    // 只認有縮排的純數字（x >= 50）：題號也是數字，但它在最左邊那一欄（x 約 30~41），
    // 退過去的話克漏字那種「41 Ⓐ… Ⓑ…」會連題號一起吃進選項。
    const strayNum = (it) => /^\s*\d+(\.\d+)?\s*$/.test(it.str) && it.x >= 50 && !OPT_MARK_RE.test(it.str)

    // 這一列的選項是「數字在前」還是「數字在後」？拿選項 A 判 —— 它前面只有 Ⓐ，
    // 沒有別的選項的數字會混進來（把尾巴那串可能屬於 B 的數字先剪掉再看）。
    //
    //   「1年」「2年」…      數字在前，結尾是「年」 -> 夾在中間的數字屬於**後面**那格
    //   「千分之5」「千分之3.5」… 數字在後          -> 那串數字屬於**自己**這格，不能退
    //
    // 少了這一條，109070 運輸學 #49 會被切成「千分之」「5千分之3.5」。
    const optMarks = row.map((it, i) => (OPT_MARK_RE.test(it.str) ? i : -1)).filter((i) => i >= 0)
    let numberFirst = false
    if (optMarks.length >= 2) {
      const a = row.slice(optMarks[0] + 1, optMarks[1]).map((r) => r.str).join('')
        .replace(/[\s\d.]+$/, '').trim()
      numberFirst = /^\d/.test(a) && !/\d$/.test(a)
    }
    // 切點往前退過甩位的數字。兩個條件都要成立才退：
    //
    //  ① 切點本來就落在標記上。落在數字上表示那串數字已經被分到後面那一格了
    //     （105 年公民與英文 #16 的「6歲的小明…」就是這種，再退會把選項 A 的尾巴切掉）。
    //  ② 標記後面緊接著的是**非數字**。這條是防「選項本身就是一串數字」——
    //     「20／12／15／5」那種題，每一格的數字都在自己標記的左邊，退了會整排
    //     位移一格（第一格變空的、最後一格裝兩個數字）。實測會弄壞 22 題。
    //     真的甩位長這樣：Ⓐ 1 年 ⟨2⟩ Ⓑ 年 —— 標記後面是「年」，
    //     一個選項不可能只有「年」，所以那個 2 一定是它的。
    const retreat = (cut, floor) => {
      if (!numberFirst) return cut
      if (!OPT_MARK_RE.test(row[cut]?.str || '')) return cut
      if (!/^[^\d\s]/.test(row[cut + 1]?.str || '')) return cut
      let b = cut
      while (b > floor && strayNum(row[b - 1])) b--
      return b
    }

    const gaps = []
    for (let i = 1; i < row.length; i++) {
      const prevEnd = row[i - 1].x + row[i - 1].str.length * 11
      if (row[i].x - prevEnd > 30 || row[i].x - row[i - 1].x > 80) {
        gaps.push(retreat(i, gaps.length ? gaps[gaps.length - 1] + 1 : 1))
      }
    }
    // 間距切出來的某一格裡**有兩個以上的選項標記** -> 那一格其實裝了好幾個選項，
    // 改用標記切。Ⓐ Ⓑ Ⓒ Ⓓ Ⓔ (U+E18C~E190) 是最可靠的訊號。
    //
    //   103070 國文 #2   四個選項擠在同一列，字距全小於門檻 -> 整列一格 -> 整題消失
    //   107070 運輸學 #4 選項排成 2×2，一格裝 A+B、一格裝 C+D -> 只剩兩個選項
    //
    // ⚠️ 間距已經一格一個標記的列**不要碰**：105 年公民與英文 #16 的選項 Ⓑ 是
    //    「6歲的小明…」，而文字層把那個 6 印在標記 Ⓑ 的左邊（x=262 vs 313）。
    //    照標記切會把 6 併進上一個選項，間距切法反而剛好切對。
    //    把標記當主判準實測會讓 46 題變壞、只救回 1 題。
    const markCount = (chunk) => chunk.filter(it => OPT_MARK_RE.test(it.str)).length
    const gapBreaks = [0, ...gaps, row.length]
    let crowded = false
    for (let b = 0; b < gapBreaks.length - 1; b++) {
      if (markCount(row.slice(gapBreaks[b], gapBreaks[b + 1])) >= 2) { crowded = true; break }
    }
    if (crowded) {
      const marks = row.map((it, i) => (OPT_MARK_RE.test(it.str) ? i : -1)).filter(i => i >= 0)
      const cuts = []
      for (const m of marks) cuts.push(retreat(m, cuts.length ? cuts[cuts.length - 1] + 1 : 0))
      const breaks = cuts[0] > 0 ? [0, ...cuts, row.length] : [...cuts, row.length]
      for (let b = 0; b < breaks.length - 1; b++) {
        const chunk = row.slice(breaks[b], breaks[b + 1])
        const text = chunk.map(r => r.str).join('').trim()
        // 這一段是選項，還是跟選項擠在同一列的題幹？
        // 有標記、而且標記前面只剩（甩位的）數字 -> 是選項。
        const mi = chunk.findIndex(it => OPT_MARK_RE.test(it.str))
        const isOpt = mi >= 0 && chunk.slice(0, mi).every(strayNum)
        if (text) lines.push({ text, x: chunk[0].x, y: row[0].y, col: isOpt ? 'C' + b : 'F' })
      }
      continue
    }
    if (gaps.length >= 3) {
      const breaks = [0, ...gaps, row.length]
      for (let b = 0; b < breaks.length - 1; b++) {
        const chunk = row.slice(breaks[b], breaks[b + 1])
        const text = chunk.map(r => r.str).join('').trim()
        if (text) lines.push({ text, x: chunk[0].x, y: row[0].y, col: 'C' + b })
      }
    } else if (gaps.length >= 1) {
      const left = row.slice(0, gaps[0]).map(r => r.str).join('').trim()
      const right = row.slice(gaps[0]).map(r => r.str).join('').trim()
      if (left) lines.push({ text: left, x: row[0].x, y: row[0].y, col: 'L' })
      if (right) lines.push({ text: right, x: row[gaps[0]].x, y: row[0].y, col: 'R' })
    } else {
      const text = row.map(r => r.str).join('').trim()
      if (text) lines.push({ text, x: row[0].x, y: row[0].y, col: 'F' })
    }
  }
  return lines
}

function extractOptions(items) {
  if (!items.length) return []
  let optX = null   // established left-x of an option line (deeper x = wrap)
  const groups = []
  let curY = null, cur = []
  for (const it of items) {
    if (curY === null || Math.abs(it.y - curY) > 3) {
      if (cur.length) groups.push(cur)
      cur = [it]; curY = it.y
    } else cur.push(it)
  }
  if (cur.length) groups.push(cur)

  const opts = []
  for (const g of groups) {
    g.sort((a, b) => a.x - b.x)
    const cols = new Set(g.map(it => it.col))
    if (cols.has('C0') || cols.has('C1') || cols.has('C2') || cols.has('C3')) {
      for (const it of g) opts.push(it.text)
    } else if (cols.has('L') && cols.has('R')) {
      opts.push(g.filter(it => it.col === 'L').map(it => it.text).join(''))
      opts.push(g.filter(it => it.col === 'R').map(it => it.text).join(''))
    } else {
      // Each option occupies its own full-width line in 佐級 PDFs. Append a
      // line to the previous option only when it is clearly a wrap continuation
      // (indented deeper than the established option-start x).
      const full = g.map(it => it.text).join('')
      const x = g[0].x
      if (opts.length && optX != null && x > optX + 9) {
        opts[opts.length - 1] += full
      } else {
        if (optX == null) optX = x
        opts.push(full)
      }
    }
  }
  return opts
}

// maxOpts: 佐級國文的複選題是**五個**選項（A-E）。預設 4 維持原本行為，
// 補複選題的 fill-railway-multi-select.js 會傳 5。
function parseQuestions(lines, maxOpts = 4) {
  const filtered = lines.filter(l => {
    const t = l.text
    if (/^(代號|類\s*科|科\s*目|考試|頁次|等\s*別|本試題|本科目|座號|※|禁止|共\d+題|請以|不必|不得|說明|一、|二、|三、|甲、|乙、|類科組別)/.test(t)) return false
    if (/^\d+－\d+$/.test(t)) return false
    return true
  })
  // Detect question anchors: a 1-2 digit number at x<62 followed by non-digit
  // text. Tolerate gaps (English cloze/passage questions whose number is not at
  // line start) — accept any number in [expect, expect+4] so one miss does not
  // abort the rest of the paper.
  const qStarts = []
  let expect = 1
  for (let i = 0; i < filtered.length; i++) {
    const line = filtered[i]
    if (line.x > 62) continue
    const m = line.text.match(/^(\d{1,2})(.*)$/)
    if (!m) continue
    const num = parseInt(m[1])
    const rest = m[2]
    // 題號自己佔一行：題幹接在下面（101 年國文 #48 的柬帖整個排成一塊，
    // 題號「48」孤零零在左邊那一欄）。原本要求題號後面一定要有字，
    // 那一題於是整題消失 —— 而且題幹選項都還在卷上，只有缺題盤點看得到。
    // 放寬會多認到表格裡的數字，所以只在「剛好是下一個題號」而且
    // 下一行是縮排的題幹（不是帶標記的選項）時才算。
    if (!rest) {
      const nxt = filtered[i + 1]
      if (num !== expect) continue
      // 下一行就是選項（克漏字那種「41 Ⓐ… Ⓑ… Ⓒ… Ⓓ…」，題幹是上面那篇文章）
      // -> 這一題建不出來，但**題號還是要往前推**。
      // 不推的話 expect 會卡在 41，而題號窗口只容許 +4，
      // 於是第46題以後整段被判成雜訊 —— 一個解不出來的題組害死半張卷
      // （110 年公民與英文的閱讀測驗 #45-50 實測）。
      if (!nxt || nxt.x <= line.x + 8 || OPT_MARK_RE.test(nxt.text)) { expect = num + 1; continue }
      qStarts.push({ idx: i, number: num })
      expect = num + 1
      continue
    }
    if (num < expect || num > expect + 4) continue   // keep sequence monotonic
    // a digit right after the number is ambiguous ("162022年…") — only trust it
    // when the number is exactly the next expected one.
    if (/^[\d.．、]/.test(rest) && num !== expect) continue
    if (/^年\s*(第|公務|專門|國家|特種)/.test(rest)) continue
    qStarts.push({ idx: i, number: num })
    expect = num + 1
  }
  const questions = []
  for (let qi = 0; qi < qStarts.length; qi++) {
    const start = qStarts[qi].idx
    const end = qi + 1 < qStarts.length ? qStarts[qi + 1].idx : filtered.length
    const num = qStarts[qi].number
    const block = filtered.slice(start, end)
    const stemText = block[0].text.slice(String(num).length).trim()
    const rest = block.slice(1)

    // 題幹到哪裡結束：找第一個出現「？」或「：」的行。
    // ⚠️ 引號還開著的時候不能算 —— 國文題先引一大段古文再問，引文裡幾乎一定有
    // 問號（「她有哪一點可愛呢？」），在那裡切斷的話引文後半段會依序填進選項格，
    // 真正的選項被整組擠掉（104070 國文 #40 五格有四格是引文）。
    // 所以要累計引號深度，只在引文已經收尾（深度回到 0）的行上收題幹。
    const qdepth = (t) => (String(t).split('「').length - 1) - (String(t).split('」').length - 1)
    let stemEndIdx = 0
    let depth = qdepth(stemText)
    let ended = /[？：︰?]/.test(stemText) && depth <= 0
    if (!ended) {
      for (let ri = 0; ri < rest.length; ri++) {
        depth += qdepth(rest[ri].text)
        if (/[？：︰?]/.test(rest[ri].text) && depth <= 0) { stemEndIdx = ri + 1; ended = true; break }
      }
    }
    // 引號從頭到尾都沒收（原卷解析本身就缺字）就退回舊判準，不要整題都變選項
    if (!ended) {
      for (let ri = 0; ri < rest.length; ri++) {
        if (/[？：︰?]/.test(rest[ri].text)) { stemEndIdx = ri + 1; ended = true; break }
      }
    }
    const stemParts = [stemText]
    for (let ri = 0; ri < stemEndIdx; ri++) stemParts.push(rest[ri].text)
    let opts = extractOptions(rest.slice(stemEndIdx))
    // 題幹收完了，但「問句那一行」被切到選項裡去：引文／現代詩先鋪一大段，
    // 真正的提問（「下列敘述，符合詩中作者想法的選項是：」）自己獨立一行，
    // 上面那條規則在引文中途就收了題幹，提問行於是變成選項 A，
    // 五個選項整組往後擠一格、最後一個整個掉出去（105070 國文 #42 實測）。
    // 選項**不會**用問號或冒號收尾，所以這種格子一定是題幹的一部分。
    const PROMPT = /(下列|下述|何者|那一|哪一|為何|請問|選出|符合|正確的|錯誤的|敘述)/
    // 以問號收尾的格子幾乎不可能是選項 —— 但「下列哪個句子屬於…」這種題**四格
    // 都是問句**，那是真的選項，所以全部都以問號收尾時不能動。
    const allQ = opts.length >= 3 && opts.every(t => /[？?]\s*$/.test(String(t).trim()))
    let cut = -1
    for (let oi = 0; oi < opts.length - 2; oi++) {
      const t = String(opts[oi]).trim()
      const short = t.replace(/\s/g, '').length <= 45
      if (/[？?]$/.test(t) && !allQ) { cut = oi; continue }
      if (/[：︰:]$/.test(t) && PROMPT.test(t) && short) cut = oi
    }
    if (cut >= 0) {
      for (let oi = 0; oi <= cut; oi++) stemParts.push(opts[oi])
      opts = opts.slice(cut + 1)
    }
    if (opts.length >= 2) {
      const options = {}
      const labels = ['A', 'B', 'C', 'D', 'E']
      for (let oi = 0; oi < Math.min(opts.length, maxOpts); oi++) options[labels[oi]] = stripPUA(opts[oi])
      questions.push({ number: num, question: stripPUA(stemParts.join(' ').trim()), options })
    }
  }
  return questions
}

// ── Answer PDF: positioned grid (第N題 → letter) ─────────────────────────
async function parseAnswers(buf) {
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise
  const items = []
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const content = await page.getTextContent()
    for (const it of content.items) {
      if (!it.str.trim()) continue
      items.push({ x: Math.round(it.transform[4]), y: Math.round(it.transform[5]), str: it.str.trim() })
    }
  }
  const answers = {}
  const qItems = items.filter(it => /^第\d{1,3}題$/.test(it.str))
  // each answer cell: a single A-E letter (E appears in 複選 — kept raw, filtered later)
  const aItems = items.filter(it => /^[ABCDE]$/.test(it.str))
  for (const q of qItems) {
    const num = parseInt(q.str.match(/^第(\d+)題$/)[1])
    let best = null, bestDy = Infinity
    for (const a of aItems) {
      if (Math.abs(a.x - q.x) > 18) continue
      const dy = q.y - a.y
      if (dy > 0 && dy < 34 && dy < bestDy) { bestDy = dy; best = a }
    }
    if (best) answers[num] = best.str
  }
  return answers
}

// ── Column-aware fallback for old (100-105) PDFs without ABCD markers ────
let columnParser = null
try { columnParser = require('./lib/moex-column-parser') } catch {}

async function parseQuestionsAny(buf) {
  const items = await extractPositionedText(buf)
  let qs = parseQuestions(buildLogicalLines(items))
  if (qs.length < 20 && columnParser) {
    try {
      const cp = await columnParser.parseColumnAware(buf)
      const nums = Object.keys(cp).map(Number).sort((a, b) => a - b)
      if (nums.length > qs.length) {
        qs = nums.map(n => ({ number: n, question: stripPUA(cp[n].question), options: {
          A: stripPUA(cp[n].options.A), B: stripPUA(cp[n].options.B),
          C: stripPUA(cp[n].options.C), D: stripPUA(cp[n].options.D),
        } }))
      }
    } catch {}
  }
  return qs
}

async function parseAnswersAny(buf) {
  let a = await parseAnswers(buf)                       // 第N題 grid (103+)
  if (Object.keys(a).length < 10 && columnParser) {
    // continuous "答案ABCD…" format (100-102 half-width / older full-width)
    try {
      const { text } = await pdfParse(buf)
      const ta = columnParser.parseAnswersText(text.normalize('NFC'))
      if (Object.keys(ta).length > Object.keys(a).length) a = ta
    } catch {}
  }
  if (Object.keys(a).length < 10 && columnParser) {
    try {
      const ca = await columnParser.parseAnswersColumnAware(buf)
      if (Object.keys(ca).length > Object.keys(a).length) a = ca
    } catch {}
  }
  return a
}

// ── Subject resolution ───────────────────────────────────────────────────
function resolveS(subjects, keyword) {
  for (const [s, name] of Object.entries(subjects)) {
    if (name.includes(keyword)) return s
  }
  return null
}

// 類科 → ordered papers. matchKey resolves the per-year s-code.
const EXAMS = {
  transport: {
    file: 'questions-railway-transport.json',
    cKey: 'transport',
    papers: [
      { subject: '國文', tag: 'chinese', match: '國文', singleChoiceOnly: true },
      { subject: '公民與英文', tag: 'civics_english', match: '公民' },
      { subject: '企業管理大意', tag: 'business_mgmt', match: '企業管理' },
      { subject: '鐵路運輸學大意', tag: 'transport_studies', match: '運輸學' },
    ],
  },
  admin: {
    file: 'questions-railway-admin.json',
    cKey: 'admin',
    papers: [
      { subject: '國文', tag: 'chinese', match: '國文', singleChoiceOnly: true },
      { subject: '公民與英文', tag: 'civics_english', match: '公民' },
      { subject: '事務管理大意', tag: 'office_mgmt', match: '事務管理' },
      { subject: '法學大意', tag: 'law_basics', match: '法學' },
    ],
  },
}

function atomicWrite(p, obj) {
  const tmp = p + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2))
  fs.renameSync(tmp, p)
}

async function scrapeExam(examKey, map, yearFilter) {
  const def = EXAMS[examKey]
  const file = path.join(__dirname, '..', def.file)
  let data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : { total: 0, questions: [] }
  const seen = new Set(data.questions.map(q => `${q.exam_code}_${q.subject_tag}_${q.number}`))
  let nextId = data.questions.length ? Math.max(...data.questions.map(q => q.id || 0)) + 1 : 1
  const added = []

  for (const roc of Object.keys(map).sort()) {
    if (yearFilter && roc !== yearFilter) continue
    const ym = map[roc]
    const cls = ym[def.cKey]
    if (!cls) { console.log(`  ${roc}: no ${examKey} 類科`); continue }
    console.log(`\n── ${roc} ${ym.sessionCode} c=${cls.c} ──`)

    for (const paper of def.papers) {
      const s = resolveS(cls.subjects, paper.match)
      if (!s) { console.log(`  ✗ ${paper.subject}: no s-code`); continue }
      const qUrl = `${BASE}?t=Q&code=${ym.sessionCode}&c=${cls.c}&s=${s}&q=1`
      const aUrl = `${BASE}?t=S&code=${ym.sessionCode}&c=${cls.c}&s=${s}&q=1`
      let qBuf, aBuf
      try { qBuf = await fetchPdf(qUrl) } catch (e) { console.log(`  ✗ ${paper.subject} (s=${s}): Q ${e.message}`); continue }
      try { aBuf = await fetchPdf(aUrl) } catch (e) { console.log(`  ⚠ ${paper.subject} (s=${s}): no answers ${e.message}`); aBuf = null }

      // verify exam name
      try {
        const { text } = await pdfParse(qBuf)
        if (!/鐵路/.test(text.normalize('NFC').slice(0, 600))) {
          console.log(`  ✗ ${paper.subject} (s=${s}): PDF not 鐵路 — skip`)
          if (process.env.DEBUG) console.log(`     head: ${JSON.stringify(text.slice(0, 120))}`)
          continue
        }
      } catch (e) { if (process.env.DEBUG) console.log(`     pdfParse err: ${e.message}`) }

      const parsed = await parseQuestionsAny(qBuf)
      const answers = aBuf ? await parseAnswersAny(aBuf) : {}

      let kept = 0, dropped = 0
      for (const q of parsed) {
        const ans = answers[q.number]
        if (!ans || !/^[ABCD]$/.test(ans)) { dropped++; continue }  // drop 複選 / unanswered
        const o = q.options
        if (!o.A || !o.B || !o.C || !o.D) { dropped++; continue }
        const key = `${ym.sessionCode}_${paper.tag}_${q.number}`
        if (seen.has(key)) continue
        seen.add(key)
        added.push({
          id: nextId++, roc_year: roc, session: '第一次', exam_code: ym.sessionCode,
          subject: paper.subject, subject_tag: paper.tag, subject_name: paper.subject,
          stage_id: 0, number: q.number,
          question: q.question, options: { A: o.A, B: o.B, C: o.C, D: o.D },
          answer: ans, explanation: '',
        })
        kept++
      }
      console.log(`  ✓ ${paper.subject} (s=${s}): ${kept} kept / ${parsed.length} parsed / ${Object.keys(answers).length} answers (dropped ${dropped})`)
      if (process.env.DEBUG) {
        const got = new Set(parsed.map(q => q.number))
        const maxN = Math.max(...Object.keys(answers).map(Number), 0)
        const miss = []
        for (let n = 1; n <= maxN; n++) if (!got.has(n)) miss.push(n)
        if (miss.length) console.log(`     missing #: ${miss.join(',')}`)
      }
      await sleep(450)
    }
  }

  if (!added.length) { console.log('\n(nothing new)'); return }
  data.questions.push(...added)
  data.total = data.questions.length
  atomicWrite(file, data)
  console.log(`\n✅ ${examKey}: +${added.length} → ${data.questions.length} total`)
}

async function main() {
  const args = process.argv.slice(2)
  const examArg = args.includes('--exam') ? args[args.indexOf('--exam') + 1] : null
  const yearArg = args.includes('--year') ? args[args.indexOf('--year') + 1] : null
  const map = JSON.parse(fs.readFileSync(path.join(__dirname, '_railway-map.json'), 'utf-8'))
  const exams = examArg ? [examArg] : ['transport', 'admin']
  for (const e of exams) {
    if (!EXAMS[e]) { console.error(`unknown exam: ${e}`); process.exit(1) }
    console.log(`\n═══════ ${e} ═══════`)
    await scrapeExam(e, map, yearArg)
  }
}
if (require.main === module) main().catch(e => { console.error(e); process.exit(1) })

// 補複選題的腳本要重用同一套版面解析（別再自己抄一份，見 reference_moex_shared_libs）
module.exports = { extractPositionedText, buildLogicalLines, parseQuestions, extractOptions, stripPUA, EXAMS, resolveS, BASE, atomicWrite }
