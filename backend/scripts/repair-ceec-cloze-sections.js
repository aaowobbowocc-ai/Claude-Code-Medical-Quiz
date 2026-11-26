#!/usr/bin/env node
/**
 * 修「整節綜合測驗都沒有文章」—— gsat_100/101/102 的英文 #16~#30。
 *
 * 克漏字的空格在文章裡，卷上沒有題幹。scrape-ceec 靠「第16至20題為題組」那行
 * 宣告去抓共用文章，但這三年的卷子**沒有印那行**（題組是隱含的：一段文章，
 * 後面接著它的幾個選項區塊）。結果 45 題進題庫時：
 *   · 沒有 case_context —— 使用者看到的是四個選項跟一句沒有上下文的話
 *   · 題幹欄位收進了自己的選項列（「(A) for (B) by (C) after (D) into」）
 *   · 每一節最後一題（#30）的選項整組是下一節「文意選填」的字庫
 *
 * 這三年的版面其實比有宣告的年份好認：選項區塊開頭就印著題號（「16. (A) for」）。
 * 所以直接走版面：
 *   1. 取「綜合測驗」到「文意選填」之間的行。
 *   2. 開頭是「N.（A」的行＝選項區塊；其餘的行累積成文章。
 *   3. 一段文章後面連續的那幾個選項區塊，就是共用它的那一組。
 *
 * **身分驗證**：每一題都拿卷上那個區塊的四個選項跟題庫比。全組都對得上才掛文章
 * （掛錯文章比沒有文章更糟）。只有對不上的那幾格才用卷上的覆蓋，而且答案那個
 * 字母必須在新選項裡。答案本身不動 —— 答案是用題號查答案卷的，題號沒壞。
 *
 *   node scripts/repair-ceec-cloze-sections.js            # 試跑
 *   node scripts/repair-ceec-cloze-sections.js --apply
 */
const fs = require('fs');
const path = require('path');
const { atomicWriteJson } = require('./lib/atomic-write');
const { passageContext, markBlanks } = require('./lib/cloze-blanks');
const { cleanTail } = require('./lib/ceec-tail');
const { stripPageFurniture } = require('./lib/ceec-page-furniture');

const BK = path.join(__dirname, '..');
const PDF = path.join(BK, '_tmp', 'ceec-pdf');
const APPLY = process.argv.includes('--apply');
const TARGETS = ['gsat_100_en', 'gsat_101_en', 'gsat_102_en'];

const OPTLINE = /^\s*(\d{1,2})\s*[.．]\s*[（(]\s*A\s*[)）]/;
const MARK = /[（(]\s*([A-D])\s*[)）]/g;
const cmp = s => String(s).normalize('NFKC').replace(/\s+/g, '').toLowerCase();
const flat = s => String(s).replace(/\s+/g, ' ').trim();
/** 這一行有多少比例是中文 */
function cjkRatio(t) {
  const s = String(t).replace(/\s/g, '');
  if (!s) return 0;
  const n = (s.match(/[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/g) || []).length;
  return n / s.length;
}

/** 卷上「綜合測驗」到「文意選填」之間的行（按版面順序） */
async function sectionLines(tag) {
  const mupdf = await import('mupdf');
  const doc = mupdf.Document.openDocument(fs.readFileSync(path.join(PDF, `${tag}.pdf`)), 'application/pdf');
  const out = [];
  let on = false;
  for (let i = 0; i < doc.countPages(); i++) {
    const st = JSON.parse(doc.loadPage(i).toStructuredText('preserve-whitespace').asJSON());
    for (const b of st.blocks || []) for (const l of b.lines || []) {
      const t = String(l.text || '');
      const bare = t.replace(/\s+/g, '');
      if (/綜合測驗/.test(bare)) { on = true; continue; }
      if (on && /(文意選填|篇章結構|閱讀測驗)/.test(bare)) return out;
      if (on) out.push({ t, x: Math.round((l.bbox && l.bbox.x) || 0), y: Math.round((l.bbox && l.bbox.y) || 0) });
    }
  }
  return out;
}

/** 把一行（或同一列的幾行）切成 A~D */
function optsOf(rows) {
  const line = rows.map(r => r.t).join(' ');
  const hits = [...line.matchAll(MARK)];
  const o = {};
  for (let i = 0; i < hits.length; i++) {
    const L = hits[i][1];
    if (L !== 'ABCD'[i]) return null;
    const from = hits[i].index + hits[i][0].length;
    const to = i + 1 < hits.length ? hits[i + 1].index : line.length;
    const t = cleanTail(line.slice(from, to)).trim();
    if (!t) return null;
    o[L] = t;
  }
  return Object.keys(o).length === 4 ? o : null;
}

(async () => {
  const report = [], skipped = {};
  const skip = r => { skipped[r] = (skipped[r] || 0) + 1; };
  const fp = path.join(BK, 'questions-gsat.json');
  const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
  const arr = Array.isArray(j) ? j : j.questions;
  let dirty = false;

  for (const tag of TARGETS) {
    const exam = tag.replace(/_en$/, '');
    const lines = await sectionLines(tag);
    if (!lines.length) { skip(`${tag} 找不到綜合測驗那一節`); continue; }

    // 依版面切成「文章段」與「選項區塊」
    const groups = [];   // {passage, items: [{num, opts}]}
    let buf = [], cur = null;
    for (let i = 0; i < lines.length; i++) {
      const m = OPTLINE.exec(lines[i].t);
      if (!m) {
        if (cur) { groups.push(cur); cur = null; buf = []; }
        // 英文克漏字的文章是純英文，有中文的那些行是節次標題跟作答說明
        //（「測驗（占13分）」、「說明：第16題至第30題…該題以零分計算。」）——
        // 比對關鍵字穩，因為 PDF 會把粗體標題重疊印成「測驗 測驗 測驗」這種碎片
        if (!lines[i].t.trim()) continue;
        if (cjkRatio(lines[i].t) >= 0.2) continue;
        buf.push(lines[i].t);
        continue;
      }
      // 同一列（y 相近）的其他欄位就是 B/C/D
      const row = [lines[i]];
      for (let k = i + 1; k < lines.length && Math.abs(lines[k].y - lines[i].y) <= 4; k++) { row.push(lines[k]); i = k; }
      const o = optsOf(row);
      if (!o) { skip(`${tag} #${m[1]} 卷上切不出四個選項`); continue; }
      // 頁首頁尾會夾在文章中間（「第 3 頁 101年學測 共 7 頁 英文考科」）
      // 頁首頁尾會夾在文章中間。中文那半已經被濾掉，剩下的「- 3 -」
      // 没有那「連續兩個 token」可以湊，要自己切（不能碰 1859-1911 這種没空白的）
      if (!cur) cur = {
        passage: stripPageFurniture(flat(buf.join(' ')))[0]
          .replace(/(^|\s)[-－]\s*\d{1,3}\s*[-－](?=\s|$)/g, ' ')
          .replace(/\s{2,}/g, ' ').trim(),
        items: [],
      };
      cur.items.push({ num: +m[1], opts: o });
    }
    if (cur) groups.push(cur);

    for (const g of groups) {
      if (!g.passage || g.items.length < 2) { skip(`${tag} 這一組沒有文章或只有一題`); continue; }
      const from = g.items[0].num, to = g.items[g.items.length - 1].num;
      if (g.items.some((it, k) => it.num !== from + k)) { skip(`${tag} ${from}~${to} 題號不連續`); continue; }

      // 全組身分驗證：每一題至少三格跟題庫一樣，才算同一組題
      const rows = g.items.map(it => ({
        it, q: arr.find(x => x.exam_code === exam && x.subject_tag === 'en' && +x.number === it.num),
      }));
      if (rows.some(r => !r.q || r.q.incomplete)) { skip(`${tag} ${from}~${to} 題庫缺題`); continue; }
      const same = rows.map(r => 'ABCD'.split('').filter(k => cmp(r.it.opts[k]) === cmp((r.q.options || {})[k] || '')).length);
      if (same.filter(n => n >= 3).length < rows.length - 1) { skip(`${tag} ${from}~${to} 選項對不上原卷，不敢掛文章`); continue; }

      // 克漏字的空格印的就是題號，文章裡每一題都要標得到。
      // 一格都標不到代表抓錯段落，標不全也不該挂（使用者會以為是錯字）
      const mk = markBlanks(g.passage, from, to).marked;
      if (mk !== g.items.length) { skip(`${tag} ${from}~${to} 文章裡只標到 ${mk}/${g.items.length} 個空格`); continue; }

      for (const r of rows) {
        const chg = 'ABCD'.split('').filter(k => cmp(r.it.opts[k]) !== cmp((r.q.options || {})[k] || ''));
        if (chg.length && !r.it.opts[r.q.answer]) { skip(`${tag} #${r.it.num} 答案字母不在卷上的選項裡`); continue; }
        const ctx = passageContext({ passage: g.passage, groupFrom: from, groupTo: to, num: r.it.num });
        report.push({ exam, num: r.it.num, from, to, chg, before: r.q.options, after: r.it.opts, ctx });
        if (APPLY) {
          if (chg.length) r.q.options = r.it.opts;
          r.q.question = `請依文意選出第 ${r.it.num} 格最適當的一個選項`;
          r.q.case_context = ctx;
          dirty = true;
        }
      }
    }
  }
  if (APPLY && dirty) atomicWriteJson(fp, j);

  let lastGroup = '';
  for (const r of report) {
    const g = `${r.exam} ${r.from}~${r.to}`;
    if (g !== lastGroup) { console.log(`\n── ${g} ──\n   文章: ${r.ctx.slice(0, 120)}…`); lastGroup = g; }
    console.log(`   #${r.num}${r.chg.length ? `  選項改 ${r.chg.length} 格: ` + r.chg.map(k => `${k}) ${JSON.stringify(String(r.before[k] || '').slice(0, 24))}→${JSON.stringify(r.after[k].slice(0, 24))}`).join('  ') : ''}`);
  }
  console.log(`\n${APPLY ? '已修' : '可修'} ${report.length} 題`);
  if (Object.keys(skipped).length) console.log('跳過:', JSON.stringify(skipped, null, 1));
  if (!APPLY) console.log('(試跑；加 --apply 才寫入)');
})();
