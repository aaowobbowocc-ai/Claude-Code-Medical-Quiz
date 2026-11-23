#!/usr/bin/env node
/**
 * 學測／分科的單選題有五個選項（A~E），但題庫裡有一批只存到 D ——
 * 第五格不是像 repair-ceec-fifth-option.js 那樣「黏在 D 裡面」，而是**整格沒被抓到**，
 * 題庫看起來乾乾淨淨，所以既有的稽核完全看不見。
 *
 *   gsat_105 自然 #8   原卷 (E)戊位於週期表的第二週期   題庫只有 A~D
 *
 * 使用者看到的是一題「四選一」，少了一個選項。答案剛好落在 A~D 時不會答錯，
 * 但題目不等於原卷，而且難度被改掉了。
 *
 * ── 安全閘：補之前要先證明「題庫這題」與「原卷這題」是同一題 ──
 * 光是在卷上找得到 D 的字不夠：同一份卷裡 D 的開頭可能撞到別題。
 * 所以要求 **A、B、C、D 四格都能在原卷上對到以該字母起頭的那一行**，
 * 而且四行在卷面上是遞增相鄰的。四格全中才算對齊，對齊了才去拿 (E)。
 *
 * 其他會擋下來的狀況：
 *   · 卷上有 (F) → 這是詞彙選填（選項排到 (J)），不是五選一
 *   · (E) 之後接的是頁碼／節次標題 → 殘渣，不是選項
 *   · (E) 的內容為空或只有一兩個字 → 多半是切錯
 *
 *   node scripts/repair-ceec-missing-fifth.js            # 試跑
 *   node scripts/repair-ceec-missing-fifth.js --apply
 */
const fs = require('fs');
const path = require('path');
const { atomicWriteJson } = require('./lib/atomic-write');
// 殘渣清單與 repair-ceec-fifth-option.js 共用一份，不要各自抄
const { JUNK, cleanTail } = require('./lib/ceec-tail');

const BK = path.join(__dirname, '..');
const CACHE = path.join(BK, '_tmp', 'ceec-pdf');
const APPLY = process.argv.includes('--apply');
const arg = k => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1];
const ONLY = arg('exam');

const SUBJ = {
  國文: 'zh', 國語文綜合能力測驗: 'zh', 英文: 'en', 社會: 'social', 自然: 'science',
  歷史: 'history', 地理: 'geography', 公民: 'civics', 公民與社會: 'civics',
  物理: 'physics', 化學: 'chemistry', 生物: 'biology', 數學甲: 'mathA', 數學乙: 'mathB',
};

// 比對用：去掉所有空白、全形括號折成半形。PDF 的斷行空白完全不可信。
const nz = s => String(s).replace(/\s+/g, '').replace(/（/g, '(').replace(/）/g, ')');
// 一行是不是「以 (X) 起頭的選項行」
const optHead = (line, letter) => nz(line).startsWith('(' + letter + ')');

let mupdf;
const pageCache = new Map();
async function paperLines(tag) {
  if (pageCache.has(tag)) return pageCache.get(tag);
  const p = path.join(CACHE, `${tag}.pdf`);
  if (!fs.existsSync(p)) { pageCache.set(tag, null); return null; }
  mupdf = mupdf || await import('mupdf');
  const doc = mupdf.Document.openDocument(fs.readFileSync(p), 'application/pdf');
  const out = [];
  for (let i = 0; i < doc.countPages(); i++) {
    const st = JSON.parse(doc.loadPage(i).toStructuredText('preserve-whitespace').asJSON());
    for (const b of st.blocks || []) for (const l of b.lines || []) out.push(l.text || '');
  }
  pageCache.set(tag, out);
  return out;
}

/** 在卷上找出與這題 A~D 四格都對得上、且遞增相鄰的那一段。回傳 D 所在的行號。 */
function alignFour(L, opts) {
  const need = ['A', 'B', 'C', 'D'].map(k => nz(opts[k]).slice(0, 10)).filter(s => s.length >= 4);
  if (need.length < 4) return -1;
  for (let i = 0; i < L.length; i++) {
    if (!(optHead(L[i], 'A') && nz(L[i]).includes(need[0]))) continue;
    let at = i, ok = true;
    for (let n = 1; n < 4; n++) {
      const letter = 'ABCD'[n];
      let found = -1;
      for (let k = at + 1; k < Math.min(L.length, at + 8); k++) {
        if (optHead(L[k], letter) && nz(L[k]).includes(need[n])) { found = k; break; }
      }
      if (found < 0) { ok = false; break; }
      at = found;
    }
    if (ok) return at;
  }
  return -1;
}

(async () => {
  const rows = [], skipped = {};
  const skip = r => { skipped[r] = (skipped[r] || 0) + 1; };

  for (const f of ['questions-gsat.json', 'questions-ast.json']) {
    const fp = path.join(BK, f);
    const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const arr = Array.isArray(j) ? j : j.questions;
    let touched = false;

    for (const q of arr) {
      const o = q.options || {};
      if (o.E || !o.A || !o.B || !o.C || !o.D) continue;
      if (ONLY && q.exam_code !== ONLY) continue;
      const tag = `${q.exam_code}_${SUBJ[q.subject] || q.subject}`;
      const L = await paperLines(tag);
      if (!L) { skip('沒有原卷 PDF'); continue; }

      const di = alignFour(L, o);
      if (di < 0) { skip('A~D 在卷上對不齊'); continue; }

      // D 之後最多 5 行內要出現 (E)
      let ei = -1;
      for (let k = di + 1; k < Math.min(L.length, di + 6); k++) {
        if (optHead(L[k], 'E')) { ei = k; break; }
        if (/^\s*\d{1,2}\s*[.．]\s*\S/.test(L[k])) break;   // 下一題開始了
      }
      if (ei < 0) { skip('原卷這題只有四個選項'); continue; }

      // 續行：往下收到下一個 (X) 標記或下一題為止
      let txt = String(L[ei]).replace(/^\s*[（(]\s*E\s*[)）]\s*/, '');
      for (let k = ei + 1; k < Math.min(L.length, ei + 4); k++) {
        const s = String(L[k]);
        if (/^\s*[（(]\s*[A-J]\s*[)）]/.test(s)) break;
        if (/^\s*\d{1,2}\s*[.．]\s*\S/.test(s)) break;
        if (!s.trim()) break;
        if (JUNK.some(r => r.test(s))) break;
        txt += s;
      }
      if (/^\s*[（(]\s*F\s*[)）]/.test(String(L[ei + 1] || ''))) { skip('詞彙選填（選項排到 F 以後）'); continue; }
      txt = cleanTail(txt).replace(/\s+/g, ' ').trim();
      if (txt.length < 2) { skip('(E) 切出來是空的'); continue; }

      // 補出來的 E 不能跟既有任何一格一樣 —— 一樣就表示切錯了，
      // 而且會在健康報告上多出一筆「選項重複」。
      const same = ['A', 'B', 'C', 'D'].find(k => nz(o[k]) === nz(txt));
      if (same) { skip(`切出來的 E 跟選項 ${same} 一模一樣`); continue; }

      rows.push({ f, id: q.id, exam: q.exam_code, subj: q.subject, n: q.number, ans: q.answer, D: o.D, E: txt });
      if (APPLY) { q.options.E = txt; touched = true; }
    }
    if (APPLY && touched) atomicWriteJson(fp, j);
  }

  for (const r of rows) {
    console.log(`${r.exam} ${r.subj} #${r.n}  ans=${r.ans}`);
    console.log(`   D: ${r.D.slice(0, 70)}`);
    console.log(`   E: ${r.E.slice(0, 70)}`);
  }
  console.log(`\n${APPLY ? '已補' : '可補'} 第五個選項 ${rows.length} 題`);
  if (Object.keys(skipped).length) console.log('跳過:', JSON.stringify(skipped, null, 1));
  if (!APPLY) console.log('(試跑；加 --apply 才寫入)');
})();
