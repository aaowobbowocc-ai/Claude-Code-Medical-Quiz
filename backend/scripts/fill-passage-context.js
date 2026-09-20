#!/usr/bin/env node
/**
 * 把「請依下文回答第X題至第Y題」的文章抓出來，附加到覆蓋範圍內的題目。
 *
 * 英文閱讀測驗與克漏字的題目本身不自足：閱測題問「this passage」、克漏字的
 * 題幹根本是空的（空格在文章裡）。沒有文章就是不能作答的壞題，所以先前
 * fill-civil-gaps 一律跳過（公職 102 題）；同樣的成因也造成 cloze_parse_failed。
 *
 * 文章的界線：宣告行之後，到「第 X 題的題號行」之前。題號是獨立一行且靠左
 * （x<80），所以用行座標切最準——用純文字切會把文章裡的數字誤判成題號。
 *
 *   node scripts/fill-passage-context.js [--exam police] [--apply]
 */
const fs = require('fs');
const path = require('path');
const { resolvePaper, fetchSheet } = require('./lib/moex-paper-resolve');

const BK = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const only = (process.argv.find(a => a.startsWith('--exam=')) || '').split('=')[1];
// 宣告用語有兩種：有冒號（警察）與沒冒號（關務），冒號後面也可能先接一段說明。
// 只要求「第X題至第Y題」，冒號改為可選，否則關務整批抓不到。
const DECL = /(?:請)?依下[文列]回答第\s*(\d{1,3})\s*題至第\s*(\d{1,3})\s*題([^：:]{0,40})[：:]?/;

async function paperLines(code, c, s) {
  const buf = await fetchSheet('Q', code, c, s);
  const mupdf = await import('mupdf');
  const doc = mupdf.Document.openDocument(buf, 'application/pdf');
  const lines = [];
  for (let p = 0; p < doc.countPages(); p++) {
    const st = JSON.parse(doc.loadPage(p).toStructuredText('preserve-whitespace').asJSON());
    for (const b of st.blocks || []) for (const l of b.lines || []) {
      const t = (l.text || '').normalize('NFC');
      if (!t.trim()) continue;
      if (/^(代號|頁次|座號|等別|類科|科目|考試時間|考試別|考試名稱)\s*[：:]/.test(t.trim())) continue;
      lines.push({ p, y: Math.round(l.bbox.y), x: Math.round(l.bbox.x), t });
    }
  }
  lines.sort((a, b) => a.p - b.p || Math.round(a.y / 6) - Math.round(b.y / 6) || a.x - b.x);
  return lines;
}

/** 回傳 [{from,to,passage}]，passage 已去掉選項標記 */
function passages(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = DECL.exec(lines[i].t);
    if (!m) continue;
    const from = +m[1], to = +m[2];
    // 宣告行本身在冒號之後可能就接了文章開頭
    const after = lines[i].t.slice(lines[i].t.indexOf(m[0]) + m[0].length);
    const buf = [after];
    for (let k = i + 1; k < lines.length; k++) {
      const L = lines[k];
      const num = /^(\d{1,3})\s*$/.exec(L.t.trim());
      if (num && L.x < 80 && +num[1] === from) break;      // 碰到第一題的題號行，文章結束
      if (DECL.test(L.t)) break;                            // 碰到下一段文章宣告
      buf.push(L.t);
    }
    const passage = buf.join('').replace(/[-]/g, '').replace(/\s+/g, ' ').trim();
    if (passage.length >= 40) out.push({ from, to, passage });
  }
  return out;
}

async function paperPassages(code, c, s) { return passages(await paperLines(code, c, s)); }
module.exports = { paperLines, passages, paperPassages };

if (require.main !== module) return;

(async () => {
  const files = fs.readdirSync(BK).filter(f => /^questions(-[a-z0-9-]*)?\.json$/.test(f));
  let tAdd = 0, tPapers = 0, errs = 0;
  for (const f of files) {
    const exam = f.replace('questions-', '').replace('questions.json', 'doctor1').replace('.json', '');
    if (only && exam !== only) continue;
    const j = JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8'));
    const arr = Array.isArray(j) ? j : j.questions; if (!arr) continue;
    const g = {};
    for (const q of arr) { if (!q.exam_code) continue; const k = q.exam_code + '|' + q.subject; (g[k] = g[k] || []).push(q); }
    let touched = false;
    for (const k of Object.keys(g)) {
      const [code, ...rest] = k.split('|'); const subject = rest.join('|');
      const items = g[k];
      let ps;
      try {
        const p = await resolvePaper({ exam, code, subject, year: String(code).slice(0, 3), items });
        if (!p) continue;
        ps = passages(await paperLines(code, p.c, p.s));
      } catch (e) { errs++; continue; }
      if (!ps.length) continue;
      let n = 0;
      for (const pg of ps) {
        for (const it of items) {
          const num = +it.number;
          if (num < pg.from || num > pg.to) continue;
          if (it.case_context) continue;
          if (APPLY) { it.case_context = `（第 ${pg.from}～${pg.to} 題共用下文）${pg.passage}`; touched = true; }
          n++; tAdd++;
        }
      }
      if (n) { tPapers++; console.log(`${exam} ${code} ${subject}: ${ps.length} 段文章 → ${APPLY ? '已附加' : '可附加'} ${n} 題`); }
    }
    if (APPLY && touched) fs.writeFileSync(path.join(BK, f), JSON.stringify(j, null, 2), 'utf8');
  }
  console.log(`\n${tPapers} 卷 | ${APPLY ? '已附加' : '可附加'} ${tAdd} 題${errs ? ` | ⚠️ ${errs} 卷失敗` : ''}`);
})().catch(e => { console.error(e.stack); process.exit(1); });
