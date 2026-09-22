#!/usr/bin/env node
/**
 * 補齊公職卷（警察/警特四等/關務）缺的測驗題。
 *
 * 這些卷是「申論題 + 測驗題」混合，題庫只收測驗題。版型的關鍵特徵：
 * **選項開頭帶 PUA 標記** U+E18C/E18D/E18E/E18F = Ⓐ/Ⓑ/Ⓒ/Ⓓ。
 * 標記直接標明了是第幾個選項，所以不必像其他卷那樣靠 x/y 座標猜順序
 * （那個猜法在雙欄版型會整組轉一格，見 reference_moex_shared_libs）。
 *
 *   node scripts/audit-civil-gaps.js          先產生 _tmp/civil-gaps.json
 *   node scripts/fill-civil-gaps.js [--apply]
 */
const fs = require('fs');
const path = require('path');
const { resolvePaper, fetchSheet } = require('./lib/moex-paper-resolve');
const { answerMap } = require('./lib/moex-answer-geo');
const { paperPassages } = require('./fill-passage-context');
const { skeleton } = require('./lib/moex-normalize');

const BK = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const only = (process.argv.find(a => a.startsWith('--exam=')) || '').split('=')[1];
const MARK = { '': 'A', '': 'B', '': 'C', '': 'D' };

/**
 * 把一個 text run 接到已累積的字串後面。
 *
 * 兩件事不能靠 `+= l.t.trim()` 硬接：
 * - **英文填空題的空格是兩個 run 之間的水平間隙**（關務 115 英文 #8：
 *   "She was" 結束在 x=99，下一個 run 從 x=141 開始）。trim 掉就變成
 *   「She wasfor the scholarship」，使用者看不出要填哪裡。間隙夠大就還原成 `_____`。
 * - **換行處**硬接會黏成「extracurricularactivities」。但中文不能補空白
 *   （中文是在詞中間斷行的，補了會變成「中文 文字」），所以只在前後都是英數時補。
 */
function appendRun(acc, l, prev) {
  const t = l.t.trim();
  if (!t) return acc;
  if (!acc) return t;
  let sep = '';
  if (prev && prev.p === l.p && Math.abs(prev.y - l.y) <= 3) {
    const gap = l.x - (prev.x + prev.w);
    if (gap > 12) sep = ' _____ ';
    else if (gap > 2) sep = ' ';
  } else if (/[A-Za-z0-9]$/.test(acc) && /^[A-Za-z0-9]/.test(t)) {
    sep = ' ';
  }
  return acc + sep + t;
}

async function paperQuestions(code, c, s) {
  const buf = await fetchSheet('Q', code, c, s);
  const mupdf = await import('mupdf');
  const doc = mupdf.Document.openDocument(buf, 'application/pdf');
  const lines = [];
  for (let p = 0; p < doc.countPages(); p++) {
    const st = JSON.parse(doc.loadPage(p).toStructuredText('preserve-whitespace').asJSON());
    for (const b of st.blocks || []) for (const l of b.lines || []) {
      const raw = (l.text || '');
      if (!raw.trim()) continue;
      const t = raw.normalize('NFC');
      if (/^(代號|頁次|座號|等別|類科|科目|考試時間|考試別|考試名稱)\s*[：:]/.test(t.trim())) continue;
      // w 給 labelParse 判斷兩個 run 是否水平重疊（重疊處的字會重複）
      lines.push({ p, y: Math.round(l.bbox.y), x: Math.round(l.bbox.x), w: Math.round(l.bbox.w), t });
    }
  }
  // 同列的 run y 會差 1~2px，先分桶成列再依 x 排，否則同一列的四個選項會亂序
  const YB = 6;
  lines.sort((a, b) => a.p - b.p || Math.round(a.y / YB) - Math.round(b.y / YB) || a.x - b.x);

  const out = new Map();
  let cur = null;
  let prev = null;                 // 上一個被接進題幹／選項的 run，用來判斷間隙
  for (const l of lines) {
    const mark = MARK[l.t[0]];
    // 題號是**獨立一行**（只有數字，x≈64），題幹在右邊另一行（x≈85）。
    // 不要寫成「數字後面接題幹」——那樣一題都抓不到。
    const numM = /^(\d{1,3})\s*$/.exec(l.t.trim());
    if (!mark && numM && l.x < 80) {
      if (cur && cur.n && Object.keys(cur.options).length === 4) out.set(cur.n, cur);
      cur = { n: +numM[1], stem: '', options: {}, last: null };
      prev = null;
      continue;
    }
    if (!cur) continue;
    if (mark) { cur.options[mark] = l.t.slice(1).trim(); cur.last = mark; prev = l; continue; }
    // 沒有標記 → 接續前一個選項，或還沒開始選項就接續題幹
    if (cur.last) cur.options[cur.last] = appendRun(cur.options[cur.last], l, prev);
    else cur.stem = appendRun(cur.stem, l, prev);
    prev = l;
  }
  if (cur && cur.n && Object.keys(cur.options).length === 4) out.set(cur.n, cur);
  if (out.size) return out;
  const viaStream = streamParse(lines);
  return viaStream.size ? viaStream : labelParse(lines);
}

/**
 * 備用版型：標記黏在**前一行的結尾**，而不是自己那行的開頭。
 *   x=47 "36 "
 *   x=72 "His father was ___ and put in jail as a result of his crime. Ⓐ"
 *   x=86 "arrested Ⓑ"   x=201 "cheated Ⓒ"   …
 * 上面那個逐行看開頭的解析法在這種卷一題都認不到（鐵路特考「公民與英文」實測）。
 * 這裡改成把整題的文字接成一條字串再依標記切：標記之前是題幹，Ⓐ 之後是選項 A，以此類推。
 * 只在嚴格版一題都沒抓到時才用，避免動到已經解析正確的卷。
 */
function streamParse(lines) {
  const out = new Map();
  let cur = null;
  const flush = () => {
    if (!cur) return;
    const parts = cur.buf.split(/([-])/);
    const q = { n: cur.n, stem: parts[0].trim(), options: {}, last: null };
    for (let i = 1; i < parts.length; i += 2) {
      const k = MARK[parts[i]];
      if (k) q.options[k] = (parts[i + 1] || '').trim();
    }
    if (Object.keys(q.options).length === 4 && q.stem) out.set(q.n, q);
  };
  for (const l of lines) {
    const numM = /^(\d{1,3})\s*$/.exec(l.t.trim());
    if (numM && l.x < 80) { flush(); cur = { n: +numM[1], buf: '' }; continue; }
    if (cur) cur.buf += ' ' + l.t;
  }
  flush();
  return out;
}

/**
 * 把同一列的 text run 依 x 接起來。
 *
 * 這種版型的 run 會**水平重疊**，而且後一個 run 的開頭重複了前一個 run 的結尾字：
 *   x=28  w=189  "40.有關利尿劑腎臟造影（diuretic renogra"
 *   x=212 w=154  "aphy）的敘述，下列何者錯誤？"      ← 28+189=217 > 212，'a' 重複了
 * 直接接會得到 renogra+aphy = "renograaphy"、"同時或"+"或後給與" = "同時或或後給與"。
 * 只有在兩個 run 真的重疊時才去掉重複字，避免砍掉「剛好疊字」的正常文字。
 */
function joinRuns(runs) {
  let out = '';
  let prev = null;
  for (const r of runs) {
    const t = r.t.trim();
    if (!t) continue;
    if (prev && r.x < prev.x + prev.w) {
      for (let k = 3; k >= 1; k--) {
        if (out.length >= k && t.length >= k && out.slice(-k) === t.slice(0, k)) {
          out += t.slice(k);
          prev = r;
          break;
        }
        if (k === 1) { out += t; prev = r; }
      }
    } else { out += t; prev = r; }
  }
  return out;
}

/**
 * 第三種版型：沒有 PUA 標記，改用明示的「9.」「A.」「B.」標籤（醫事類各卷都是這種）。
 *   x=31 y=60  "9."
 *   x=39 y=59  "62Cu、"   x=67 "64Cu 與"   x=101 "67Cu 同位素之比較，下列何者正確？"
 *   x=39 y=90  "B."       x=48 y=89 "67Cu 半衰期最長，為2.6 天"
 * 注意標籤與它的內容被切成不同的 text run，而且 y 還差 1px，所以要先把同一列併起來。
 *
 * 這種卷用 `pdfText` 看會是「110 110 110 110 年…」——整份文字重複四遍（PDF 把字畫了四次），
 * 所以不要用扁平文字判斷這類卷解析不了，toStructuredText 出來是乾淨的。
 */
function labelParse(lines) {
  // 同一列的 run y 差 1~2px，要先併成一列再依 x 接起來。
  // 不能用「y 除以桶寬取整」——桶的邊界會從中間切開同一列：
  // 實測 "C.美國FDA 已核准"(y=105) 與它後半 "64Cu-ATSM…"(y=104) 落在不同桶，
  // 於是後半被接到上一個選項去。改成依 y 排序後做鄰近聚類。
  const sorted = lines.slice().sort((a, b) => a.p - b.p || a.y - b.y || a.x - b.x);
  const rows = [];
  for (const l of sorted) {
    const last = rows[rows.length - 1];
    if (last && last[0].p === l.p && Math.abs(l.y - last[0].y) <= 3) last.push(l);
    else rows.push([l]);
  }
  const ordered = rows.map(runs => joinRuns(runs.slice().sort((u, v) => u.x - v.x)));

  const out = new Map();
  let cur = null;
  const flush = () => {
    if (cur && cur.n && Object.keys(cur.options).length === 4 && cur.stem) out.set(cur.n, cur);
  };
  for (const row of ordered) {
    const t = row.trim();
    if (!t) continue;
    const numM = /^(\d{1,3})[.、](.*)$/.exec(t);
    // 題號後面若直接接 A. 就不是題號行（例如小數點）
    if (numM && !/^[A-D][.、]/.test(numM[2].trim())) {
      flush();
      cur = { n: +numM[1], stem: numM[2].trim(), options: {}, last: null };
      continue;
    }
    if (!cur) continue;
    const optM = /^([A-D])[.、](.*)$/.exec(t);
    if (optM) { cur.options[optM[1]] = optM[2].trim(); cur.last = optM[1]; continue; }
    if (cur.last) cur.options[cur.last] += t;
    else cur.stem += t;
  }
  flush();
  return out;
}

module.exports = { paperQuestions, MARK };

if (require.main !== module) return;

(async () => {
  const gaps = JSON.parse(fs.readFileSync(path.join(BK, '_tmp', 'civil-gaps.json'), 'utf8'))
    .filter(r => r.missing && r.missing.length).filter(r => !only || r.exam === only);
  const banks = {};
  let added = 0, skipped = 0;
  const touched = new Set();
  for (const r of gaps) {
    const f = `questions-${r.exam}.json`;
    if (!banks[f]) { const j = JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8')); banks[f] = { j, a: Array.isArray(j) ? j : j.questions }; }
    const arr = banks[f].a;
    const items = arr.filter(q => q.exam_code === r.code && q.subject === r.subject);
    const model = items[0];
    if (!model) { console.log('✗', r.key, '題庫無範本題'); continue; }
    let p;
    try { p = await resolvePaper({ exam: r.exam, code: r.code, subject: r.subject, year: String(r.code).slice(0, 3), items }); }
    catch (e) { console.log('✗', r.key, 'resolve 失敗'); continue; }
    if (!p) { console.log('✗', r.key, '對不到官方卷'); continue; }
    const qs = await paperQuestions(r.code, p.c, p.s);
    // 英文克漏字/閱測要有文章才作答得了，先把該卷的文章段落抓出來
    let pgs = [];
    try { pgs = await paperPassages(r.code, p.c, p.s); } catch (_) {}
    const passageFor = (n) => { const g = pgs.find(x => n >= x.from && n <= x.to); return g ? g : null; };
    const am = await answerMap(r.code, p.c, p.s, r.target, p.subject).catch(() => null);
    // 信任門檻要用「題幹逐題號對得上」，不能用「答案對齊率」——
    // 我們正是要修那些錯答案，拿答案當門檻是循環論證（實測會把題幹 35/35
    // 完全吻合的卷擋掉，只因為它本來就有一半答案是錯的）。
    let hit = 0, tot = 0;
    for (const it of items) {
      const s2 = qs.get(+it.number); if (!s2) continue;
      tot++;
      if (skeleton(it.question).slice(0, 20) === skeleton(s2.stem).slice(0, 20)) hit++;
    }
    const rate = tot ? hit / tot : 0;
    const have = new Set(items.map(q => +q.number));
    let n = 0, noAns = 0, noStem = 0, badOpt = 0;
    for (const num of r.missing) {
      const src = qs.get(num);
      if (!src || have.has(num)) { skipped++; continue; }
      const ans = (am && rate >= 0.9) ? am.map.get(num) : null;
      if (!ans) { noAns++; skipped++; continue; }   // 沒有可信答案就不補，寧缺勿錯
      // 英文克漏字的題幹是空的（空格在文章裡）；閱讀測驗題指涉「this passage」
      // 而文章沒被抓進來。這兩種補進去就是壞題，直接跳過。
      let stem = String(src.stem || '').trim();
      const pg = passageFor(num);
      // 有抓到文章 → 題目可以自足，克漏字的空題幹也補得起來
      if (!pg) {
        if (stem.length < 10) { noStem++; skipped++; continue; }
        if (/this passage|the passage|下文|上文|本文|above passage|following passage/i.test(stem)) { noStem++; skipped++; continue; }
      } else if (stem.length < 10) {
        stem = `依上文文意，選出最適合填入空格（${num}）的選項。`;
      }
      // 選項完整性也要擋。英文閱讀測驗的選項常常解析不乾淨：有空選項、
      // 或下一段文章整段跑進最後一個選項（實測 108070 補進 8 題壞題才發現）。
      const ov = ['A', 'B', 'C', 'D'].map(k => String(src.options[k] || '').trim());
      if (ov.some(v => !v)) { badOpt++; skipped++; continue; }
      if (ov.some(v => /請依下文|請依上文|回答第\s*\d+\s*題至/.test(v))) { badOpt++; skipped++; continue; }
      const L = ov.map(v => v.length).sort((x, y) => x - y);
      if (L[3] > L[0] * 6 || L[3] - L[0] > 120) { badOpt++; skipped++; continue; }
      const q = {
        id: `${r.code}_${model.subject_tag || 'x'}_${num}`,
        roc_year: model.roc_year, session: model.session, exam_code: r.code,
        subject: r.subject, subject_tag: model.subject_tag, subject_name: model.subject_name,
        stage_id: model.stage_id, number: num,
        question: stem, options: { A: src.options.A, B: src.options.B, C: src.options.C, D: src.options.D },
        answer: ans, explanation: '',
      };
      if (pg) q.case_context = `（第 ${pg.from}～${pg.to} 題共用下文）${pg.passage}`;
      if (APPLY) arr.push(q);
      n++; added++; touched.add(f);
    }
    console.log(`${r.exam} ${r.code} ${r.subject}: 缺 ${r.missing.length}，原卷解析 ${qs.size} 題，題幹對齊 ${(100*rate).toFixed(0)}% → ${APPLY ? '已補' : '可補'} ${n}${noAns ? `（${noAns} 無答案）` : ''}${noStem ? `（${noStem} 克漏字/閱測無題幹）` : ''}${badOpt ? `（${badOpt} 選項不完整）` : ''}`);
  }
  if (APPLY) for (const f of touched) {
    const { j, a } = banks[f];
    a.sort((x, y) => String(x.exam_code).localeCompare(String(y.exam_code)) || String(x.subject).localeCompare(String(y.subject)) || (+x.number - +y.number));
    fs.writeFileSync(path.join(BK, f), JSON.stringify(j, null, 2), 'utf8');
    console.log('已寫入', f);
  }
  console.log(`\n${APPLY ? '已補' : '可補'} ${added} 題，跳過 ${skipped} 題`);
})().catch(e => { console.error(e.stack); process.exit(1); });
