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
      lines.push({ p, y: Math.round(l.bbox.y), x: Math.round(l.bbox.x), t });
    }
  }
  // 同列的 run y 會差 1~2px，先分桶成列再依 x 排，否則同一列的四個選項會亂序
  const YB = 6;
  lines.sort((a, b) => a.p - b.p || Math.round(a.y / YB) - Math.round(b.y / YB) || a.x - b.x);

  const out = new Map();
  let cur = null;
  for (const l of lines) {
    const mark = MARK[l.t[0]];
    // 題號是**獨立一行**（只有數字，x≈64），題幹在右邊另一行（x≈85）。
    // 不要寫成「數字後面接題幹」——那樣一題都抓不到。
    const numM = /^(\d{1,3})\s*$/.exec(l.t.trim());
    if (!mark && numM && l.x < 80) {
      if (cur && cur.n && Object.keys(cur.options).length === 4) out.set(cur.n, cur);
      cur = { n: +numM[1], stem: '', options: {}, last: null };
      continue;
    }
    if (!cur) continue;
    if (mark) { cur.options[mark] = l.t.slice(1).trim(); cur.last = mark; continue; }
    // 沒有標記 → 接續前一個選項，或還沒開始選項就接續題幹
    if (cur.last) cur.options[cur.last] += l.t.trim();
    else cur.stem += l.t.trim();
  }
  if (cur && cur.n && Object.keys(cur.options).length === 4) out.set(cur.n, cur);
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
