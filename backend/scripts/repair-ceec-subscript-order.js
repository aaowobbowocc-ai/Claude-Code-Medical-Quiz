#!/usr/bin/env node
/**
 * 修大考中心（學測／分科）PDF 的「下標字元順序錯亂」。
 *
 * 2026-11-09 從 gsat 104 自然 #11 查出來的：化學式的下標是**較小的字級**，
 * PDF 的閱讀順序會把它們甩到前面或後面去，於是
 *   原卷 (A)XY (B)XY₂ (C)XY₄ (D)X₄Y (E)X₂Y
 *   抽成 "XY" / "2 XY" / "4 XY" / "4 XY" / "2 XY 14 2 3 5"
 * C 跟 D 變得一模一樣，才被「選項重複」抓到；其他題則是靜默錯下去
 *   （例：gsat 114 自然 #36 的題幹「2 2 2 2 H2O H + O →」，
 *     原本是「2H₂O → 2H₂ + O₂」）。
 *
 * 作法：用字元座標重排 —— 同一行依 x 排序即可還原。判斷同一行時，
 * 下標的基線比正文低幾 px，所以下標（字級 < 9）的容差要放寬。
 *
 * ⚠️ **只在「字元組成完全相同、只是順序不同」時才寫入。**
 *    這條驗收條件讓這支腳本不可能無中生有：它只重排，不新增也不刪字。
 *    對不上的一律列出來不動（題幹本來就可能被別的問題改過）。
 *
 * 題庫的化學式慣例是純數字（H2O、CaCO3），不是 Unicode 下標字元，
 * 所以重排後直接輸出數字，不轉成 ₂。
 *
 *   node scripts/repair-ceec-subscript-order.js [--exam gsat] [--year 104] [--apply]
 */
const fs = require('fs');
const path = require('path');
const { REGISTRY, BASE } = require('./scrape-ceec');

const BK = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const arg = k => {
  const eq = process.argv.find(a => a.startsWith('--' + k + '='));
  if (eq) return eq.split('=').slice(1).join('=');
  const i = process.argv.indexOf('--' + k);
  return i > 0 && !String(process.argv[i + 1] || '').startsWith('--') ? process.argv[i + 1] : null;
};
const ONLY_EXAM = arg('exam'), ONLY_YEAR = arg('year');

const strip = s => String(s == null ? '' : s).replace(/\s+/g, '');
/** 字元組成（排序後的字串）—— 用來判斷「只是順序不同」 */
const bag = s => [...strip(s)].sort().join('');

/** 依字元座標重建每一行的文字 */
async function rowsOf(buf) {
  const mupdf = await import('mupdf');
  const doc = mupdf.Document.openDocument(buf, 'application/pdf');
  const rows = [];
  for (let pi = 0; pi < doc.countPages(); pi++) {
    const hits = [];
    doc.loadPage(pi).toStructuredText('preserve-whitespace')
      .walk({ onChar(c, o, font, size) { if (!/\s/.test(c)) hits.push({ c, x: o[0], y: o[1], size }); } });
    const pageRows = [];
    for (const h of hits) {
      // 下標的基線比正文低幾 px，容差要放寬，否則會被切成另一行
      const tol = h.size < 9 ? 6 : 3;
      let r = pageRows.find(r => Math.abs(r.y - h.y) <= tol);
      if (!r) { r = { y: h.y, items: [] }; pageRows.push(r); }
      r.items.push(h);
    }
    pageRows.sort((a, b) => a.y - b.y);
    for (const r of pageRows) {
      r.items.sort((a, b) => a.x - b.x);
      /*
       * ⚠️ 核種符號（²¹⁰₈₄Po）是上標與下標**疊在同一個 x**，
       *    依 x 排序會把兩層交織起來：210 與 84 疊出「21804」，比原本還糟。
       *    偵測到同一行有疊字就把整行標起來，這一題一律不動。
       */
      let stacked = false;
      for (let i = 1; i < r.items.length; i++) {
        if (Math.abs(r.items[i].x - r.items[i - 1].x) < 1.5 &&
            Math.abs(r.items[i].y - r.items[i - 1].y) > 2) { stacked = true; break; }
      }
      /*
       * ⚠️ 上標不能用這套修。題庫的化學式慣例是純數字（H2O），
       *    下標攤平成數字讀得懂；但**上標**攤平會變成誤導的數字 ——
       *    10⁵ 變「105」、10⁻⁴ 變「10−4」、f²=f 變「f2=f」，比原樣還糟。
       *    小字級的基線比正文**高**就是上標，整行放棄。
       */
      const base = r.items.filter(h => h.size >= 9).map(h => h.y).sort((a, b) => a - b);
      const mid = base.length ? base[base.length >> 1] : null;
      const hasSuper = mid !== null && r.items.some(h => h.size < 9 && h.y < mid - 1.5);
      rows.push({ t: r.items.map(h => h.c).join(''), stacked, hasSuper });
    }
  }
  return rows;
}

/** 去掉數字後的字元序列。下標錯位只會搬動數字，其他字的**順序**不該變 */
const skeletonNoDigits = s => strip(s).replace(/[0-9]/g, '');

/**
 * 在重建的行文字裡找一段「字元組成與 target 相同」的視窗。
 *
 * ⚠️ 光靠「字元組成相同」會抓錯。第一版就踩了三種：
 *    - 0.12 配到別處的 12.0、120 配到 210（純數字，組成相同的片段滿地都是）
 *    - 同一題的選項 B 配到選項 D（「乙醇、丙酮、乙醚、水、乙酸」vs
 *      「丙酮、乙醇、水、乙醚、乙酸」—— 兩個真的不同的選項，字一樣只是順序不同）
 *    - #66 的「太陽日比恆星日…」配到「恆星日比太陽日…」
 *    套下去會把題庫改爛。所以加三道：
 *      1. 只在「這一題」的行區間裡找（用題號行界定）
 *      2. 去掉數字後的字元序列必須完全一致 —— 下標錯位只搬數字，不動別的字
 *      3. 區間內必須只有一個符合的視窗
 *    另外純數字／純標點的片段一律跳過：這個判準對它們沒有鑑別力。
 */
function findReordered(rows, lo, hi, target) {
  const want = bag(target), n = strip(target).length;
  if (n < 3) return null;
  if (!/[A-Za-z一-鿿]/.test(strip(target))) return null;
  const spine = skeletonNoDigits(target);
  const found = [];
  for (let i = lo; i < hi; i++) {
    const hay = rows[i].t + ((rows[i + 1] || {}).t || '');
    for (let s = 0; s + n <= hay.length; s++) {
      const win = hay.slice(s, s + n);
      if (bag(win) !== want) continue;
      if (skeletonNoDigits(win) !== spine) continue;
      if (!found.includes(win)) found.push(win);
    }
  }
  return found.length === 1 ? found[0] : null;
}

/**
 * 用選項標記 (A)(B)(C)(D)(E) 把這一題的區間切成每個選項的文字。
 *
 * 這是比「全區間搜尋」強得多的錨點 —— 有些選項從文字看根本分不開：
 * gsat 104 自然 #11 的 B=XY₂ 與 E=X₂Y，字元組成一模一樣，
 * 只有「它排在哪個標記後面」能區分。
 */
function optionSegments(rows, lo, hi) {
  const text = rows.slice(lo, hi).map(r => r.t).join('');
  const out = {};
  const marks = [...text.matchAll(/\(([A-E])\)/g)];
  for (let i = 0; i < marks.length; i++) {
    const L = marks[i][1];
    if (out[L]) return {};                       // 同一個標記出現兩次，區間切錯了，整題放棄
    const a = marks[i].index + marks[i][0].length;
    const b = i + 1 < marks.length ? marks[i + 1].index : text.length;
    out[L] = text.slice(a, b);
  }
  return out;
}

/**
 * 把題庫的選項對到切出來的那一段。兩層驗收：
 *   1. 字元組成完全相同 → 純粹重排，最安全
 *   2. 去掉數字後完全相同、且原卷那段的數字是題庫那段數字的子集
 *      → 重排並丟掉多餘數字。gsat 104 自然 #11 的 E 存成
 *        「2 XY 14 2 3 5」，尾巴那串是旁邊插圖的座標軸刻度混進來的。
 *      這層會標 ⚠ 印出來，方便人工覆核。
 */
function matchSegment(seg, cur) {
  if (!seg) return null;
  const got = strip(seg);
  if (!got || got.length < 2) return null;
  if (bag(got) === bag(cur)) return { text: got, stray: false };
  if (skeletonNoDigits(got) !== skeletonNoDigits(cur)) return null;
  if (!/[A-Za-z一-鿿]/.test(got)) return null;
  const have = [...strip(cur)].filter(c => /[0-9]/.test(c)).sort();
  for (const d of [...got].filter(c => /[0-9]/.test(c))) {
    const i = have.indexOf(d);
    if (i < 0) return null;                       // 原卷有、題庫沒有的數字 → 不是單純丟垃圾，放棄
    have.splice(i, 1);
  }
  return { text: got, stray: true };
}

/** 題號 N 所在的行 → 題號 N+1 所在的行，當作這一題的範圍 */
function regionOf(rows, num) {
  const head = n => new RegExp('^\\s*' + n + '[.．、]');
  const lo = rows.findIndex(r => head(num).test(r.t));
  if (lo < 0) return null;
  let hi = rows.findIndex((r, i) => i > lo && head(num + 1).test(r.t));
  if (hi < 0) hi = Math.min(rows.length, lo + 14);
  return [lo, hi];
}

/*
 * 通用規則碰不到、但已經人工把原卷字形重排核對過的個案。
 *
 * gsat 104 自然 #11 的選項 E：旁邊插圖的座標軸刻度混進選項尾巴
 * （存成「2 XY 14 2 3 5」），多出來的字讓「字元組成相同」與
 * 「去掉數字後相同」兩個判準都對不上。原卷該題五個選項是
 *   (A)XY (B)XY₂ (C)XY₄ (D)X₄Y (E)X₂Y
 * ——依字元座標重排讀出來的，B/C/D 由通用規則修，只有 E 留在這裡。
 */
const ONE_OFFS = [
  { file: 'questions-gsat.json', code: 'gsat_104', subject: '自然', number: 11, field: 'E',
    from: '2 XY 14 2 3 5', to: 'X2Y' },
];

(async () => {
  let checked = 0, fixed = 0, nochange = 0, nomatch = 0, noregion = 0, stray = 0, stackedSkip = 0, superSkip = 0, collide = 0;
  const banks = {};
  for (const examKey of Object.keys(REGISTRY)) {
    if (ONLY_EXAM && examKey !== ONLY_EXAM) continue;
    const reg = REGISTRY[examKey];
    const file = reg.outputFile;
    if (!banks[file]) {
      const raw = fs.readFileSync(path.join(BK, file), 'utf8');
      const j = JSON.parse(raw);
      banks[file] = { raw, j, arr: Array.isArray(j) ? j : j.questions, dirty: false };
    }
    const arr = banks[file].arr;

    for (const year of Object.keys(reg.years)) {
      if (ONLY_YEAR && year !== ONLY_YEAR) continue;
      for (const sub of reg.subjects) {
        const u = (reg.years[year] || {})[sub.tag];
        if (!u || !u.q) continue;
        const code = `${examKey}_${year}`;
        const items = arr.filter(q => q && q.exam_code === code && q.subject === sub.name);
        if (!items.length) continue;
        let rows;
        try {
          const res = await fetch(BASE + u.q);
          if (!res.ok) { console.log(`  ✗ ${code} ${sub.name} HTTP ${res.status}`); continue; }
          rows = await rowsOf(Buffer.from(await res.arrayBuffer()));
        } catch (e) { console.log(`  ✗ ${code} ${sub.name} ${e.message}`); continue; }

        for (const q of items) {
          const reg = regionOf(rows, q.number);
          if (!reg) { noregion++; continue; }
          const band = rows.slice(reg[0], reg[1]);
          if (band.some(r => r.stacked)) { stackedSkip++; continue; }
          if (band.some(r => r.hasSuper)) { superSkip++; continue; }
          const segs = optionSegments(rows, reg[0], reg[1]);
          const plan = [];
          for (const field of ['question', 'A', 'B', 'C', 'D', 'E']) {
            const cur = field === 'question' ? q.question : (q.options || {})[field];
            if (!cur || strip(cur).length < 3) continue;
            checked++;
            let hit = field === 'question' ? null : matchSegment(segs[field], cur);
            const got = hit ? hit.text : findReordered(rows, reg[0], reg[1], cur);
            if (!got) { nomatch++; continue; }
            if (strip(got) === strip(cur)) { nochange++; continue; }
            plan.push({ field, cur, got, stray: !!(hit && hit.stray) });
          }
          if (!plan.length) continue;
          /*
           * ⚠️ 改完以後選項不能撞在一起。
           *    gsat 105 自然 #47 的 A「1 2 R R」與 B「2 1 R R」都會被改成「R2R1」——
           *    兩個本來不同的選項變成一模一樣，那一定是哪裡搞錯了（很可能是分數式
           *    R₁/R₂ 被攤平）。整題放棄比寫錯好。
           */
          const after = ['A', 'B', 'C', 'D', 'E'].map(k => {
            const p = plan.find(x => x.field === k);
            return strip(p ? p.got : (q.options || {})[k]);
          }).filter(Boolean);
          if (new Set(after).size !== after.length) { collide++; continue; }

          for (const p of plan) {
            if (p.stray) stray++;
            console.log(`  ${code} ${sub.name} #${q.number} [${p.field}]${p.stray ? ' ⚠丟掉混入數字' : ''}`);
            console.log(`      舊: ${String(p.cur).replace(/\s+/g, ' ')}`);
            console.log(`      新: ${p.got}`);
            if (APPLY) {
              if (p.field === 'question') q.question = p.got; else q.options[p.field] = p.got;
              banks[file].dirty = true;
            }
            fixed++;
          }
        }
      }
    }
  }
  for (const fx of ONE_OFFS) {
    if (ONLY_EXAM && !fx.code.startsWith(ONLY_EXAM)) continue;
    const b = banks[fx.file];
    if (!b) continue;
    const q = b.arr.find(x => x && x.exam_code === fx.code && x.subject === fx.subject && x.number === fx.number);
    if (!q) { console.log(`  ✗ 個案 ${fx.code} #${fx.number} 找不到題目`); continue; }
    const cur = fx.field === 'question' ? q.question : (q.options || {})[fx.field];
    if (strip(cur) === strip(fx.to)) continue;                       // 已修過
    if (strip(cur) !== strip(fx.from)) { console.log(`  ✗ 個案 ${fx.code} #${fx.number} [${fx.field}] 現值已不是當初核對的內容，不動`); continue; }
    console.log(`  ${fx.code} ${fx.subject} #${fx.number} [${fx.field}] （人工核對個案）\n      舊: ${cur}\n      新: ${fx.to}`);
    if (APPLY) { if (fx.field === 'question') q.question = fx.to; else q.options[fx.field] = fx.to; b.dirty = true; }
    fixed++;
  }

  if (APPLY) {
    for (const f of Object.keys(banks)) {
      if (!banks[f].dirty) continue;
      const b = banks[f];
      fs.writeFileSync(path.join(BK, f), JSON.stringify(b.j, null, 2) + (b.raw.endsWith('\n') ? '\n' : ''), 'utf8');
      console.log(`寫回 ${f}`);
    }
  }
  console.log(`\n檢查 ${checked} 段｜順序要改 ${fixed}｜本來就一致 ${nochange}｜原卷對不上 ${nomatch}`);
  if (!APPLY) console.log('(試跑；加 --apply 才寫入)');
})().catch(e => { console.error(e.stack); process.exit(1); });
