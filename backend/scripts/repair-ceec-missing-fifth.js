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
 * ── 做法：把原卷整份拆成「選項片段」再對齊 ──
 * 大考中心的選項排法有兩種，同一份卷會混用：
 *     (A)甲                      ← 一行一個
 *     (A) 12 cm/s   (B) 7.5 cm/s ← 一行兩個（雙欄）
 * 所以不能用「一行就是一個選項」。先掃過每一行、用 (X) 標記切成片段，
 * 沒有標記的續行併回前一段，得到一條 A,B,C,D,E,A,B,C,D… 的片段流。
 *
 * ── 安全閘：補之前要先證明「題庫這題」與「原卷這題」是同一題 ──
 * 要求 A、B、C、D 四格在片段流裡**連續相鄰**，而且每一格與題庫的字互為前綴。
 * 四格全中才去拿緊接著的第五段，而且那段的標記必須是 (E)。
 *
 * 用「互為前綴」而不是「題庫的前 10 個字出現在那一行」：自然科有大量
 * 「16」「中午」「正斷層」這種兩三個字的選項，用前綴長度門檻會整批漏掉
 * （第一版就因此在 gsat_105 自然漏了 17 題）；而連續四格全中已經夠強，
 * 短選項反而因為要完全對上而更安全。
 *
 * 其他會擋下來的狀況：
 *   · 第五段的標記是 (F) → 詞彙選填（選項排到 (J)），不是五選一
 *   · (E) 之後接的是頁碼／節次標題 → 殘渣，用 lib/ceec-tail.js 剪掉
 *   · 切出來跟 A~D 任一格一樣 → 一定是切錯
 *
 *   node scripts/repair-ceec-missing-fifth.js            # 試跑
 *   node scripts/repair-ceec-missing-fifth.js --apply
 */
const fs = require('fs');
const path = require('path');
const { atomicWriteJson } = require('./lib/atomic-write');
// 殘渣清單與 repair-ceec-fifth-option.js 共用一份，不要各自抄
const { cleanTail } = require('./lib/ceec-tail');

const BK = path.join(__dirname, '..');
const CACHE = path.join(BK, '_tmp', 'ceec-pdf');
const APPLY = process.argv.includes('--apply');
const arg = k => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1];
const ONLY = arg('exam');

// 哪些科目真的有五選一。學測國文／社會／歷史／地理／公民的單選題一律四個選項，
// 在那些卷上「找到 (E)」一定是圖說或別題的東西（gsat_112 國文 #12 差點被補上
// 一段圖說「看V 星的運動路徑 A1→A2→A3→A4→A5」）。英文只有篇章結構是 A~E，
// 文意選填排到 (J)、綜合測驗是四選一，靠下面的 (F) 閘與標記閘擋掉。
const FIVE_OPT_SUBJECTS = new Set(['自然', '物理', '化學', '生物', '地球科學', '英文']);

const SUBJ = {
  國文: 'zh', 國語文綜合能力測驗: 'zh', 英文: 'en', 社會: 'social', 自然: 'science',
  歷史: 'history', 地理: 'geography', 公民: 'civics', 公民與社會: 'civics',
  物理: 'physics', 化學: 'chemistry', 生物: 'biology', 數學甲: 'mathA', 數學乙: 'mathB',
};

// 比對用：去掉所有空白、全形括號折成半形。PDF 的斷行空白完全不可信。
const nz = s => String(s).replace(/\s+/g, '').replace(/（/g, '(').replace(/）/g, ')');
// 互為前綴就算對上（題庫可能已經把尾巴的殘渣剪過）
const pref = (x, y) => x.length && y.length && (x.startsWith(y) || y.startsWith(x));

let mupdf;
const segCache = new Map();

/** 把整份卷拆成 [{letter, text}] 的片段流。 */
async function paperSegments(tag) {
  if (segCache.has(tag)) return segCache.get(tag);
  const p = path.join(CACHE, `${tag}.pdf`);
  if (!fs.existsSync(p)) { segCache.set(tag, null); return null; }
  mupdf = mupdf || await import('mupdf');
  const doc = mupdf.Document.openDocument(fs.readFileSync(p), 'application/pdf');
  const segs = [];
  const MARK = /[（(]\s*([A-J])\s*[)）]/g;
  for (let i = 0; i < doc.countPages(); i++) {
    const st = JSON.parse(doc.loadPage(i).toStructuredText('preserve-whitespace').asJSON());
    for (const b of st.blocks || []) for (const l of b.lines || []) {
      const line = String(l.text || '');
      const x = (l.bbox && l.bbox.x) || 0;
      const hits = [...line.matchAll(MARK)];
      if (!hits.length) {
        // 沒有標記的續行要併回前一段，否則換行的選項會被攔腰截斷。
        // 但「下一題的題幹」也同樣沒有標記 —— 只看有沒有標記，就會把下一題
        // 整段收進上一題的選項 E（ast_112 物理 #11 被收進了「這個新元素就以
        // 太陽的希臘文命名為氦…」）。用版面位置分辨：選項的續行一定對齊或
        // 縮在選項文字之內，新題目則退回左邊界。
        const last = segs[segs.length - 1];
        if (!last || last.closed) continue;
        if (x + 2 < last.x || /^\s*\d{1,2}\s*[.．]\s*\S/.test(line)) { last.closed = true; continue; }
        last.text += ' ' + line;
        continue;
      }
      for (let h = 0; h < hits.length; h++) {
        const from = hits[h].index + hits[h][0].length;
        const to = h + 1 < hits.length ? hits[h + 1].index : line.length;
        segs.push({ letter: hits[h][1], text: line.slice(from, to), x });
      }
    }
  }
  segCache.set(tag, segs);
  return segs;
}

/** 在片段流裡找連續的 A,B,C,D 四格。回傳 A 的位置，找不到回 -1。 */
function alignFour(segs, o) {
  const want = ['A', 'B', 'C', 'D'].map(k => nz(o[k]));
  if (want.some(s => !s)) return -1;
  for (let i = 0; i + 3 < segs.length; i++) {
    let ok = true;
    for (let n = 0; n < 4; n++) {
      const s = segs[i + n];
      if (s.letter !== 'ABCD'[n] || !pref(nz(s.text), want[n])) { ok = false; break; }
    }
    if (ok) return i;
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
      if (!FIVE_OPT_SUBJECTS.has(q.subject)) { skip('這科的單選題只有四個選項'); continue; }
      const tag = `${q.exam_code}_${SUBJ[q.subject] || q.subject}`;
      // A~D 裡本來就黏著 (E)~(J) 的標記，表示這題在題庫裡已經是壞的
      //（gsat_104 自然 #58 的 D 是「…(E)…(F)…」三格黏成一格、
      // gsat_100 英文 #30 的 D 是「popular (E)」）。那是另一種壞法，不在這裡處理。
      if (['A', 'B', 'C', 'D'].some(k => /[（(]s*[E-J]s*[)）]/.test(String(o[k])))) {
        skip('A~D 裡還黏著別的選項標記'); continue;
      }

      const segs = await paperSegments(tag);
      if (!segs) { skip('沒有原卷 PDF'); continue; }

      const ai = alignFour(segs, o);
      if (ai < 0) { skip('A~D 在卷上對不齊'); continue; }

      const e = segs[ai + 4];
      if (!e) { skip('原卷這題只有四個選項'); continue; }
      if (e.letter === 'F') { skip('詞彙選填（選項排到 F 以後）'); continue; }
      if (segs[ai + 5] && segs[ai + 5].letter === 'F') { skip('詞彙選填（選項排到 F 以後）'); continue; }
      if (e.letter !== 'E') { skip('原卷這題只有四個選項'); continue; }

      let txt = cleanTail(e.text).replace(/\s+/g, ' ').trim();
      if (txt.length < 1) { skip('(E) 切出來是空的'); continue; }
      const same = ['A', 'B', 'C', 'D'].find(k => nz(o[k]) === nz(txt));
      if (same) { skip(`切出來的 E 跟選項 ${same} 一模一樣`); continue; }

      // 五個選項的長度不會差一個數量級。E 比最長的兄弟長太多，就是又吃到
      // 下一題的東西了 —— 這種寧可不補：少一個選項只是不完整，補進一段別題
      // 的文字是把題目弄壞。
      const maxSib = Math.max(...['A', 'B', 'C', 'D'].map(k => nz(o[k]).length));
      if (nz(txt).length > Math.max(40, maxSib * 2.5)) { skip('切出來的 E 長得不合理，多半吃到別題'); continue; }

      // 數學式被 PDF 打散成一個個字元（「1 2 2 1 M R M R」）。這種題
      // 解析器救不了（見 procedure_unextractable_text），補上去只是多一串亂碼。
      const tok = txt.split(/\s+/).filter(Boolean);
      if (tok.length >= 4 && tok.filter(t => t.length === 1).length * 2 > tok.length) {
        skip('選項是被打散的數學式'); continue;
      }

      // A~D 全是純數字時，E 一定也是純數字。「29.0 中子 n 中子 n 中子 n」
      // 是把旁邊那張圖的標籤收進來了（gsat_115 自然 #20，A~D 是 4.2/5.8/7.4/21.0）。
      // 兄弟選項已經證明了這一格該長什麼樣，所以切到數字為止是有根據的，
      // 切不出數字就整題跳過。
      const NUM = /^[-+]?[0-9.,]+$/;
      if (['A', 'B', 'C', 'D'].every(k => NUM.test(nz(o[k]))) && !NUM.test(nz(txt))) {
        const m = txt.match(/^[-+]?[0-9.,]+/);
        if (!m) { skip('兄弟選項都是數字，這格切出來不是'); continue; }
        txt = m[0];
      }

      rows.push({ exam: q.exam_code, subj: q.subject, n: q.number, ans: q.answer, D: o.D, E: txt });
      if (APPLY) { q.options.E = txt; touched = true; }
    }
    if (APPLY && touched) atomicWriteJson(fp, j);
  }

  for (const r of rows) {
    console.log(`${r.exam} ${r.subj} #${r.n}  ans=${r.ans}`);
    console.log(`   D: ${String(r.D).slice(0, 70)}`);
    console.log(`   E: ${r.E.slice(0, 70)}`);
  }
  console.log(`\n${APPLY ? '已補' : '可補'} 第五個選項 ${rows.length} 題`);
  if (Object.keys(skipped).length) console.log('跳過:', JSON.stringify(skipped, null, 1));
  if (!APPLY) console.log('(試跑；加 --apply 才寫入)');
})();
