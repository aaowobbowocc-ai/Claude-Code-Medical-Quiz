#!/usr/bin/env node
/**
 * 用 PDF 欄位幾何重建被拆碎的選項。
 *
 * 問題：考選部試題的選項可能是單欄、雙欄或四欄排版，而同一個「格子」內的文字
 * 有時會被拆成多個 text run（例如選項以數字開頭：「50歲以上…」會變成 x=71 的 "50"
 * 加 x=85 的 "歲以上…"）。現有 parser 把每個 run 當成一個選項，於是 4 個格子被
 * 5 個碎片佔滿，**最後一個真正的選項整個消失**，使用者看到的就是無法作答的壞題。
 *
 * 作法：
 *   1. 用題號行（x<55 且純數字）切出每題的區塊
 *   2. 以既有題幹比對，切掉題幹行，剩下的就是選項行
 *   3. 依 y 分列、依 x 分欄（欄距 > GAP 才算換欄），同一格的碎片直接黏起來
 *   4. 只有「剛好 4 格、皆非空、彼此相異」才採用，否則跳過（寧可不動）
 *
 * 用法：
 *   node scripts/fix-column-fragments.js <questions-file> <code> <c> <s> <subject_tag> [--apply]
 * 例：
 *   node scripts/fix-column-fragments.js questions-nutrition.json 107030 103 0202 nutrition_science
 */

const fs = require('fs');
const path = require('path');
const { fetchPdf, buildMoexUrl } = require('./lib/pdf-fetcher');

const { diagnose } = require('./scan-broken-options.js');

const [file, code, c, s, tag] = process.argv.slice(2);
const APPLY = process.argv.includes('--apply');
if (!file || !code || !c || !s || !tag) {
  console.error('用法: node scripts/fix-column-fragments.js <questions-file> <code> <c> <s> <subject_tag> [--apply]');
  process.exit(1);
}

const UA = 'Mozilla/5.0';
const REF = 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx';
const CACHE_DIR = path.join(__dirname, '..', '_tmp', 'bullet-cloze');
const GAP = 45;          // x 間距超過這個才算換欄（同格碎片通常只差 10-30）
const ROW_TOL = 8;       // y 差距在這之內視為同一列

const norm = (x) => (x || '').replace(/\s+/g, '').replace(/[－–—]/g, '-');

async function getPdf() {
  const cached = path.join(CACHE_DIR, `Q_${code}_${c}_${s}.pdf`);
  if (fs.existsSync(cached) && fs.statSync(cached).size > 1000) return fs.readFileSync(cached);
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const buf = await fetchPdf(buildMoexUrl('Q', code, c, s), { userAgent: UA, referer: REF });
  fs.writeFileSync(cached, buf);
  return buf;
}

async function readLines(buf) {
  const mupdf = await import('mupdf');
  const doc = mupdf.Document.openDocument(buf, 'application/pdf');
  const out = [];
  for (let p = 0; p < doc.countPages(); p++) {
    const st = JSON.parse(doc.loadPage(p).toStructuredText('preserve-whitespace').asJSON());
    for (const b of st.blocks || []) {
      for (const l of b.lines || []) {
        const t = (l.text || '').trim();
        if (!t) continue;
        const y = Math.round(l.bbox.y);
        // 跨頁的題目區塊會吃進下一頁的頁首（代號／頁次／座號…），必須先濾掉，
        // 否則它們會被當成多出來的選項格子，整題就被判定成「不是 4 格」而跳過。
        if (y < 75) continue;
        if (/^(代號|頁次|座號|等\s*別|類\s*科|科\s*目|考試時間)[：:]/.test(t)) continue;
        out.push({ p, y, x: Math.round(l.bbox.x), t });
      }
    }
  }
  out.sort((a, b) => a.p - b.p || a.y - b.y || a.x - b.x);
  return out;
}

/** PDF 偶爾把同一段文字畫兩次，接起來會變成「整頓頓（Sieton）」→ 去掉重疊的部分 */
function dropOverlap(prev, next) {
  const max = Math.min(6, prev.length, next.length);
  for (let k = max; k > 0; k--) {
    if (prev.slice(-k) === next.slice(0, k)) return next.slice(k);
  }
  return next;
}

/** 把選項行依 (列, 欄) 收成格子，同格碎片黏起來，回傳依閱讀順序排好的字串陣列 */
function cellsFromLines(lines) {
  // 分列
  const rows = [];
  for (const l of lines) {
    let row = rows.find(r => r.p === l.p && Math.abs(r.y - l.y) <= ROW_TOL);
    if (!row) { row = { p: l.p, y: l.y, items: [] }; rows.push(row); }
    row.items.push(l);
  }
  rows.sort((a, b) => a.p - b.p || a.y - b.y);

  // 每列內依 x 分欄；cur 必須「每列重置」，否則下一列開頭會被黏到上一列的格子
  const cells = [];
  rows.forEach((row, ri) => {
    row.items.sort((a, b) => a.x - b.x);
    let cur = null;
    for (const it of row.items) {
      if (cur && it.x - cur.startX <= GAP) { cur.t += dropOverlap(cur.t, it.t); }
      else { cur = { x: it.x, startX: it.x, t: it.t, row: ri }; cells.push(cur); }
    }
  });
  // 依 列 → 欄(x) 排序＝閱讀順序
  cells.sort((a, b) => a.row - b.row || a.x - b.x);
  // 選項標記（Ⓐ Ⓑ…）在 PDF 裡是 PUA 造字，trim() 清不掉，會變成選項開頭的豆腐字。
  // 注意只剝「開頭」，因為 ①②③④ 在選項內容裡是合法字元（複選題常用）。
  return cells
    // 只剝掉「開頭那一個」選項標記造字。不能貪婪剝除，也不能剝結尾——
    // 有些卷的圈號數字（①②③…）本身就是 PUA 造字，貪婪剝除會把選項內容吃掉
    // （2026-09-12 抽驗抓到：「①④⑤」被改成「④⑤」）。
    // PDF 夾帶 CJK 相容表意文字（U+F900-U+FAFF，字形同但碼位不同，會讓搜尋失效）
    // → 統一正規化成 NFC。不用 NFKC，以免全形標點被改掉、失去原卷排版。
    .map(c => c.t.normalize('NFC').replace(/^[-�]?\s*/, '').trim())
    // 希臘字母（ω-3、α-hydroxylase…）常被 PDF 當成另一個 run 畫在行尾，
    // 依 x 排序就被接到字尾。特徵是「開頭是連字號、結尾是孤立希臘字母」→ 搬回開頭。
    // 首字元（數字或希臘字母）常被 PDF 另外畫在行尾，依 x 排序就被接到字尾。
    // 特徵是「開頭是接續符號、結尾是孤立數字/希臘字母」→ 搬回開頭。
    .map(t => t.replace(/^([-－，,〜~～].*?)([0-9α-ωΑ-Ω])$/u, '$2$1'))
    .filter(Boolean);
}

(async () => {
  const buf = await getPdf();
  const lines = await readLines(buf);

  // 題號行：x < 55 且純數字
  const marks = [];
  lines.forEach((l, i) => {
    if (l.x < 55 && /^\d{1,3}$/.test(l.t)) marks.push({ num: +l.t, i });
  });

  const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));
  const arr = Array.isArray(data) ? data : data.questions;
  // 一定要同時比對場次碼與科目，只靠題號跨年度匹配會改到別卷的題
  const paper = arr.filter(q => String(q.exam_code) === String(code) && q.subject_tag === tag);
  if (!paper.length) { console.error(`找不到 exam_code=${code} subject_tag=${tag} 的題目`); process.exitCode = 1; return; }

  let fixed = 0, skipped = 0;
  const report = [];

  for (const q of paper) {
    const mi = marks.findIndex(m => m.num === +q.number);
    if (mi < 0) continue;
    const from = marks[mi].i + 1;
    const to = mi + 1 < marks.length ? marks[mi + 1].i : lines.length;
    const block = lines.slice(from, to);

    // 切掉題幹：逐行吃掉，直到累積文字已覆蓋題幹
    const stem = norm(q.question);
    let acc = '', cut = 0;
    for (let i = 0; i < block.length; i++) {
      if (norm(acc).length >= stem.length) break;
      acc += block[i].t; cut = i + 1;
    }
    const DBG = process.env.ONLY && +process.env.ONLY === +q.number;
    if (DBG) console.log('DBG #' + q.number, '區塊行數', block.length, '題幹吃掉', cut, '行');
    if (!norm(acc).startsWith(stem.slice(0, Math.min(12, stem.length)))) {
      if (DBG) console.log('DBG 題幹比對失敗 acc=', JSON.stringify(norm(acc).slice(0, 40)), ' stem=', JSON.stringify(stem.slice(0, 40)));
      skipped++; continue;
    }

    const cells = cellsFromLines(block.slice(cut));
    if (DBG) console.log('DBG 重建格子', cells.length, JSON.stringify(cells));
    if (cells.length !== 4) { skipped++; continue; }
    if (new Set(cells.map(norm)).size !== 4) { skipped++; continue; }
    if (cells.some(t => norm(t).length < 1)) { skipped++; continue; }
    // 重建後仍以接續符號開頭 ＝ 還是碎片，整題放棄（寧可不修也不要寫進爛資料）
    if (cells.some(t => /^[，,〜~～、。）)]/.test(t.trim()))) { skipped++; continue; }

    // 只改「掃描器判定為破損」的題。否則像英文克漏字那種題號內嵌在文章裡的版型，
    // 區塊切分會錯位，把別題的選項整組搬過來（2026-09-12 抽驗抓到關務英文
    // 「Cure/Diet/Evidence」被換成「but/still/yet」），而那些題原本根本沒壞。
    if (!diagnose(q)) { skipped++; continue; }

    const now = ['A', 'B', 'C', 'D'].map(k => String((q.options || {})[k] || ''));

    // 複選組合題（選項是「①②③」這種圈號序列）版型最脆弱：圈號在部分卷裡是 PUA 造字，
    // 位置也常被拆到別的格子，重建容易「少吃掉幾個圈號」而使答案語意整個改變。
    // 規則：重建後圈號總數只要比原本少，就整題放棄（2026-09-12 抽驗抓到 ②③⑤⑦ → ②③⑤）。
    const circles = (t) => (String(t).match(/[①-⑳㉑-㊿]/g) || []).length;
    const beforeCircles = now.reduce((n, t) => n + circles(t), 0);
    const afterCircles = cells.reduce((n, t) => n + circles(t), 0);
    if (beforeCircles > afterCircles) { skipped++; continue; }
    if (now.map(norm).join('|') === cells.map(norm).join('|')) continue;

    report.push({ num: q.number, id: q.id, before: now, after: cells });
    if (APPLY) {
      q.options = { A: cells[0], B: cells[1], C: cells[2], D: cells[3] };
      delete q.vision_uncertain;
    }
    fixed++;
  }

  console.log(`${code}/${tag}: 重建 ${fixed} 題，跳過 ${skipped} 題`);
  for (const r of report) {
    console.log(`\n#${r.num} (id ${r.id})`);
    ['A', 'B', 'C', 'D'].forEach((k, i) => {
      const same = norm(r.before[i]) === norm(r.after[i]);
      console.log(`  ${k} ${same ? ' ' : '✏️'} ${JSON.stringify(r.before[i])}${same ? '' : '  →  ' + JSON.stringify(r.after[i])}`);
    });
  }

  if (APPLY && fixed) {
    fs.writeFileSync(path.join(__dirname, '..', file), JSON.stringify(data, null, 2), 'utf8');
    console.log('\n✅ 已寫入');
  } else if (!APPLY) {
    console.log('\n(dry-run，加 --apply 才會寫入)');
  }
})().catch(e => { console.error(e); process.exit(1); });
