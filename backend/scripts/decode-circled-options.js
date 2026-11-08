#!/usr/bin/env node
/**
 * 修「組合題選項的圈號 ①②③④ 全塌成 ①」。
 *
 * 2026-11-09 發現：考選部 PDF 的題幹與選項常用**兩套字型**
 * （題幹 PMingLiU、選項 MingLiU）。選項那套的 ToUnicode 壞掉，
 * ②③④⑤ 全被解成 U+2460（①），偶爾解成別的數字。
 * 於是「①②③」「②③④」存進題庫都變成「①①①」。
 * 全站 43 卷 65 題，而且**健康報告完全看不到**
 * （只有剛好塌成完全相同的那幾題會被「選項重複」抓到）。
 *
 * ⚠️ 兩個判準都單獨不可信，必須合用：
 *   1. 字形比對：把字形切出來跟題幹的 ①②③④（解得對）比。
 *      跨字型的噪音（10~12）跟數字彼此的差距（②③ 只差 10.4）同量級，
 *      實測會把 ⑤ 判成 ③、把 ② 判成 ③。
 *   2. 遞增約束：組合題選項內的數字一定由小到大。
 *      但它只給偏序 —— 實測「①②③④ / ②③④⑤」兩個選項，
 *      光靠遞增無法決定首尾那兩個字形是 ① 還是 ②。
 * 作法：用遞增約束**篩**出所有合法指派，再用字形距離**選**總分最低的那組，
 * 且要求最佳解唯一（與次佳有明顯差距）才寫入。
 *
 * 驗證過的真值：counseling-psychology 103100 團體諮商與心理治療，
 * 字形圖人工判讀 = ①②③④⑤①④②⑤③，與本演算法輸出完全一致。
 *
 *   node scripts/decode-circled-options.js --exam tcm2 --code 106030 --subject "中醫臨床醫學(三)"
 *   node scripts/decode-circled-options.js --all [--apply]
 *   加 --montage 會輸出 _tmp/glyphs-<exam>-<code>.png 供人工抽檢
 */
const fs = require('fs');
const path = require('path');
const { resolvePaper, fetchSheet } = require('./lib/moex-paper-resolve');

const BK = path.join(__dirname, '..');
const arg = k => {
  const eq = process.argv.find(a => a.startsWith('--' + k + '='));
  if (eq) return eq.split('=').slice(1).join('=');
  const i = process.argv.indexOf('--' + k);
  return i > 0 && !String(process.argv[i + 1] || '').startsWith('--') ? process.argv[i + 1] : null;
};
const APPLY = process.argv.includes('--apply');
const ALL = process.argv.includes('--all');
const MONTAGE = process.argv.includes('--montage');

const FILE = e => (e === 'doctor1' ? 'questions.json' : 'questions-' + e + '.json');
const CIRCLED = /[①-⑳]/;            // ①..⑳
const MARKER = /[-]/;             // ⒶⒷⒸⒹ 的 PUA 標記
const flat = s => String(s).replace(/\s+/g, '');
const Z = 8, S = 112, Q = 32;
const LIB = path.join(__dirname, "data", "circled-glyph-lib.json");

/** 把一個字的墨水範圍裁出來、置中貼到 S×S，不縮放（同字級才可比） */
function glyphBitmap(px, W, H, quad) {
  const x0 = Math.max(0, Math.floor(quad[0] * Z) - 3), x1 = Math.min(W, Math.ceil(quad[6] * Z) + 3);
  const y0 = Math.max(0, Math.floor(quad[1] * Z) - 3), y1 = Math.min(H, Math.ceil(quad[5] * Z) + 3);
  let ix0 = x1, ix1 = x0, iy0 = y1, iy1 = y0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++)
    if (px[y * W + x] < 200) { if (x < ix0) ix0 = x; if (x > ix1) ix1 = x; if (y < iy0) iy0 = y; if (y > iy1) iy1 = y; }
  if (ix1 <= ix0 || iy1 <= iy0) return null;
  const w = ix1 - ix0 + 1, h = iy1 - iy0 + 1;
  if (w > S || h > S) return null;
  const g = new Uint8Array(S * S).fill(255);
  const ox = (S - w) >> 1, oy = (S - h) >> 1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[(oy + y) * S + ox + x] = px[(iy0 + y) * W + ix0 + x];
  // 跨卷用的簽章：把墨水框縮放到 Q×Q 二值化。不同卷的字級可能不同，
  // 所以跨卷比對一定要縮放過；同卷內的分群則用上面不縮放的 g（較精確）。
  const sig = new Uint8Array(Q * Q);
  for (let j = 0; j < Q; j++) for (let i = 0; i < Q; i++) {
    const sx0 = ix0 + Math.floor(i * w / Q), sx1 = Math.max(sx0 + 1, ix0 + Math.floor((i + 1) * w / Q));
    const sy0 = iy0 + Math.floor(j * h / Q), sy1 = Math.max(sy0 + 1, iy0 + Math.floor((j + 1) * h / Q));
    let s = 0, c = 0;
    for (let y = sy0; y < sy1; y++) for (let x = sx0; x < sx1; x++) { s += px[y * W + x]; c++; }
    sig[j * Q + i] = (s / c) < 170 ? 1 : 0;
  }
  return { g: g, sig: sig };
}
/** 跨卷字形簽章的距離：容許 ±1 格位移的不同位元比例（%） */
function sigDist(a, b) {
  let best = Infinity;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    let d = 0, c = 0;
    for (let y = 1; y < Q - 1; y++) for (let x = 1; x < Q - 1; x++) { if (a[y * Q + x] !== b[(y + dy) * Q + x + dx]) d++; c++; }
    const m = (d / c) * 100; if (m < best) best = m;
  }
  return best;
}
const sigEncode = s => Buffer.from(s).toString('base64');
const sigDecode = s => new Uint8Array(Buffer.from(s, 'base64'));
/** 容許 ±2px 位移的平均絕對差 */
function dist(a, b) {
  let best = Infinity;
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    let s = 0, c = 0;
    for (let y = 3; y < S - 3; y++) for (let x = 3; x < S - 3; x++) { s += Math.abs(a.g[y * S + x] - b.g[(y + dy) * S + x + dx]); c++; }
    const m = s / c; if (m < best) best = m;
  }
  return best;
}

/** 讀一份卷：回傳依閱讀順序的字元陣列，圈號字附上字形群號 */
async function readPaper(buf) {
  const mupdf = await import('mupdf');
  const doc = mupdf.Document.openDocument(buf, 'application/pdf');
  const chars = [], clusters = [];
  for (let pi = 0; pi < doc.countPages(); pi++) {
    const page = doc.loadPage(pi);
    const st = page.toStructuredText('preserve-whitespace');
    const hits = [];
    st.walk({ onChar(c, o, font, size, quad) { hits.push({ c, quad, size }); } });
    if (!hits.some(h => CIRCLED.test(h.c))) { for (const h of hits) chars.push({ c: h.c }); continue; }
    const pm = page.toPixmap(mupdf.Matrix.scale(Z, Z), mupdf.ColorSpace.DeviceGray);
    const px = pm.getPixels(), W = pm.getWidth(), H = pm.getHeight();
    for (const h of hits) {
      if (!CIRCLED.test(h.c)) { chars.push({ c: h.c }); continue; }
      const b = glyphBitmap(px, W, H, h.quad);
      if (!b) { chars.push({ c: h.c }); continue; }
      let hit = clusters.find(cl => dist(cl.rep, b) <= 4);
      if (!hit) { hit = { rep: b, id: clusters.length, n: 0 }; clusters.push(hit); }
      hit.n++;
      chars.push({ c: h.c, g: hit.id });
    }
  }
  return { chars, clusters };
}

/**
 * 跨卷字形庫。一張卷通常只有 1~3 題組合題，約束不夠把所有字形釘死；
 * 但字形是跨卷共用的，所以把釘死過的存起來，下一張卷就少一個未知數。
 * （實測：只靠單卷 65 題裡只修得動 12 題，接上字形庫後大幅提升。）
 */
const lib = {
  items: [],
  load() {
    try { this.items = JSON.parse(fs.readFileSync(LIB, 'utf8')).map(r => ({ digit: r.digit, src: r.src, sig: sigDecode(r.sig) })); }
    catch (e) { this.items = []; }
    return this;
  },
  /** 回傳已知數字，或 null。閾值 4% 以內視為同一個字形 */
  lookup(sig) {
    if (!sig) return null;
    let best = null, bd = Infinity;
    for (const it of this.items) { const d = sigDist(sig, it.sig); if (d < bd) { bd = d; best = it; } }
    return bd <= 4 ? best.digit : null;
  },
  add(sig, digit, src) {
    if (!sig) return false;
    for (const it of this.items) {
      if (sigDist(sig, it.sig) > 4) continue;
      // 同一個字形被判成兩個不同數字 —— 一定有一邊錯了，寧可都不信
      if (it.digit !== digit) { it.conflict = true; }
      return false;
    }
    this.items.push({ digit: digit, src: src, sig: sig });
    return true;
  },
  save() {
    const keep = this.items.filter(it => !it.conflict);
    const dropped = this.items.length - keep.length;
    fs.mkdirSync(path.dirname(LIB), { recursive: true });
    fs.writeFileSync(LIB, JSON.stringify(keep.map(it => ({ digit: it.digit, src: it.src, sig: sigEncode(it.sig) })), null, 1), 'utf8');
    return dropped;
  },
};

/**
 * 每個數字的參考字形。
 * 一個字形群若在整份卷裡**只被解成同一個字元**，那個解碼多半是對的
 * （壞掉的那套字型會把好幾個不同字形都解成 ①，所以反過來說，
 *  同一群只對應一種解碼、而且別的群沒搶同一個字元，就可信）。
 */
function buildRefs(chars, clusters) {
  const decodes = {};
  for (const ch of chars) if (ch.g !== undefined) (decodes[ch.g] = decodes[ch.g] || new Set()).add(ch.c);
  const claim = {};
  for (const cl of clusters) {
    const d = decodes[cl.id];
    if (!d || d.size !== 1) continue;
    const n = [...d][0].codePointAt(0) - 0x245F;       // ①=1
    (claim[n] = claim[n] || []).push(cl);
  }
  const refs = {};
  for (const n of Object.keys(claim)) {
    // 同一個字元被多個字形群搶：那是壞字型造成的，不可信
    if (claim[n].length === 1) refs[n] = claim[n][0];
  }
  return refs;
}

/**
 * 解**整卷**：一個字形只能對應一個數字。
 *
 * ⚠️ 一題一題各自解會出錯。實測 counseling-psychology 104030：
 *    同一個字形群 g6 在 #4 被判成 ②（對）、在 #22 被判成 ①（錯），
 *    因為單題的約束不足以釘死它。把整卷的選項一起解，
 *    #4 釘住的 g6=② 就會把 #22 的錯解排除掉。
 *
 * cases: [{ seqs:[[群號…]×4], K }]  回傳 { ok, map:{群號→數字}, margin }
 */
function decodePaper(cases, clusters, refs) {
  const used = [...new Set(cases.flatMap(c => c.seqs.flat()))];
  if (!used.length) return { why: '沒有圈號' };
  const maxK = Math.max.apply(null, cases.map(c => c.K));
  if (used.length > 16 || maxK > 12) return { why: '字形群或項目數過多' };
  // 每個字形群的上限 = 它出現過的題目裡最小的 K
  const cap = {};
  for (const g of used) cap[g] = maxK;
  for (const c of cases) for (const g of new Set(c.seqs.flat())) cap[g] = Math.min(cap[g], c.K);

  /*
   * 成本表。兩個來源，字形庫優先：
   *   - 跨卷字形庫：之前在別張卷釘死過同一個字形 → 指派成那個數字成本 0，其餘 40。
   *     字形是跨卷共用的，所以 A 卷釘死的字形到 B 卷就是已知條件。
   *     但它不是硬性約束 —— 仍要通過遞增與互異檢查，萬一庫裡是錯的會解不出來而不是靜默寫錯。
   *   - 同卷題幹的參考字形：拿不到庫的時候用，但跨字型噪音大（見檔頭）。
   */
  const cost = {};
  for (const g of used) {
    cost[g] = {};
    const known = lib.lookup(clusters[g].rep.sig);
    for (let d = 1; d <= maxK; d++) {
      cost[g][d] = known ? (d === known ? 0 : 40)
        : (refs[d] ? dist(clusters[g].rep, refs[d].rep) : 15);
    }
  }
  // 相鄰約束：序列裡前一個一定小於後一個
  const pairs = [];
  for (const c of cases) for (const s of c.seqs) for (let i = 1; i < s.length; i++) pairs.push([s[i - 1], s[i]]);

  // minScore[g][d] = 「把字形 g 指派成數字 d」時，整卷能達到的最低總分。
  // 用它判斷每個字形**各自**有多確定，比看整卷總分的次佳差距細緻得多：
  // 兩個解可能只差一個字形，整卷邊際很小，但其餘字形其實都釘死了。
  const minScore = {};
  const feasible = {};
  for (const g of used) { minScore[g] = {}; feasible[g] = new Set(); for (let d = 1; d <= maxK; d++) minScore[g][d] = Infinity; }
  const asg = {};
  let best = null, nodes = 0;
  (function dfs(i) {
    if (nodes++ > 3e6) return;
    if (i === used.length) {
      for (const c of cases) {
        const keys = c.seqs.map(s => s.map(g => asg[g]).join(','));
        if (new Set(keys).size !== keys.length) return;        // 同一題的四個選項必須互不相同
      }
      const score = used.reduce((t, g) => t + cost[g][asg[g]], 0);
      for (const g of used) { if (score < minScore[g][asg[g]]) minScore[g][asg[g]] = score; feasible[g].add(asg[g]); }
      if (!best || score < best.score) best = { map: Object.assign({}, asg), score };
      return;
    }
    const g = used[i];
    for (let d = 1; d <= cap[g]; d++) {
      asg[g] = d;
      // 兩端都指派好的相鄰約束，馬上檢查
      let bad = false;
      for (const pr of pairs) {
        if (pr[0] !== g && pr[1] !== g) continue;
        if (asg[pr[0]] === undefined || asg[pr[1]] === undefined) continue;
        if (!(asg[pr[0]] < asg[pr[1]])) { bad = true; break; }
      }
      if (!bad) dfs(i + 1);
    }
    delete asg[g];
  })(0);
  if (nodes > 3e6) return { why: '搜尋空間過大' };
  if (!best) return { why: '遞增約束下無解' };
  /*
   * 一個字形算「釘死」只有兩種情況：
   *   1. 所有合法解都指派同一個數字 —— 純粹由遞增＋互異約束決定，與字形距離無關。
   *   2. 跨卷字形庫完全命中 —— 之前在別張卷用 (1) 釘死過同一個字形。
   *
   * ⚠️ **不可以**用字形距離當判準。跨字型噪音跟數字彼此的差距同量級；
   *    而且題幹參考字形常常建不起來（壞字型把好幾個字形都解成同一個字元，
   *    buildRefs 就會全部放棄），成本表退化成中性值後，距離會做出任意的決定。
   *    實測 clinical-psychology 106030 #17 就是這樣把 ②③ 解成 ①③，
   *    還把那個 ② 當成 ① 餵進字形庫污染後面的卷。
   *    距離只留著當同分時的排序，不參與「敢不敢寫」的判斷。
   */
  const confident = {}, shaky = [];
  for (const g of used) {
    confident[g] = feasible[g].size === 1 || lib.lookup(clusters[g].rep.sig) === best.map[g];
    if (!confident[g]) shaky.push('g' + g + '(' + [...feasible[g]].sort().join('/') + '?)');
  }
  return { ok: true, map: best.map, confident: confident, shaky: shaky };
}

async function doPaper(exam, code, subject, targets, stats) {
  const p0 = path.join(BK, FILE(exam));
  const rawText = fs.readFileSync(p0, "utf8");
  const j = JSON.parse(rawText);
  const arr = Array.isArray(j) ? j : j.questions;
  const items = arr.filter(q => q && String(q.exam_code) === code && q.subject === subject).sort((a, b) => a.number - b.number);
  const p = await resolvePaper({ exam, code, subject, year: String(code).slice(0, 3), items });
  if (!p) { console.log('  ✗ 對不到官方卷'); stats.nopaper++; return false; }
  const buf = await fetchSheet('Q', code, p.c, p.s);
  if (!buf) { console.log('  ✗ 抓不到 PDF'); stats.nopaper++; return false; }
  const r0 = await readPaper(buf);
  const chars = r0.chars, clusters = r0.clusters;
  const refs = buildRefs(chars, clusters);
  const ftext = chars.map(c => c.c).join('').replace(/\s+/g, '');
  const map = []; chars.forEach((c, i) => { if (!/\s/.test(c.c)) map.push(i); });

  /*
   * --probe：不改題庫，只把原卷「每一組四個選項標記」前面的題幹與解好的選項列出來。
   * 用在槽位被覆蓋、題庫裡題幹是空的、沒辦法用題幹定位的時候
   * （counseling-psychology 103100 的三題就是這樣）。
   * 圈號一律查跨卷字形庫，查不到就原樣印出來，由人判讀。
   */
  if (process.argv.includes('--probe')) {
    const mkAll = [];
    chars.forEach((c, i) => { if (MARKER.test(c.c)) mkAll.push(i); });
    for (let k = 0; k + 3 < mkAll.length; k += 4) {
      const stemFrom = k === 0 ? 0 : mkAll[k - 1];
      const stem = chars.slice(Math.max(stemFrom, mkAll[k] - 420), mkAll[k]).map(c => c.c).join('').replace(/\s+/g, ' ').trim();
      const opts = [];
      for (let o = 0; o < 4; o++) {
        const a = mkAll[k + o] + 1, b = o === 3 ? Math.min(chars.length, mkAll[k + 4] !== undefined ? mkAll[k + 4] : chars.length) : mkAll[k + o + 1];
        opts.push(chars.slice(a, b).map(c => {
          if (c.g === undefined) return c.c;
          const d = lib.lookup(clusters[c.g].rep.sig);
          return d ? String.fromCodePoint(0x245F + d) : c.c + '?';
        }).join('').replace(/\s+/g, ' ').trim().slice(0, 90));
      }
      console.log('\n--- 題幹: ' + stem.slice(-200));
      ['A', 'B', 'C', 'D'].forEach((L, i) => console.log('    ' + L + '. ' + opts[i]));
    }
    return false;
  }

  // 第一趟：把每一題的選項區段與項目數定位出來
  const cases = [];
  for (const q of items) {
    if (!targets.includes(q.number)) continue;
    const probe = flat(q.question).slice(0, 20);
    if (probe.length < 10) { console.log('  ⚠ #' + q.number + ' 題幹太短，略過'); stats.skip++; continue; }
    const fi = ftext.indexOf(probe);
    if (fi < 0) { console.log('  ⚠ #' + q.number + ' 原卷找不到題幹'); stats.skip++; continue; }
    if (ftext.indexOf(probe, fi + 1) >= 0) { console.log('  ⚠ #' + q.number + ' 題幹在原卷出現多次'); stats.skip++; continue; }
    const start = map[fi];
    const mk = [];
    for (let i = start; i < chars.length && mk.length < 5; i++) if (MARKER.test(chars[i].c)) mk.push(i);
    if (mk.length < 4) { console.log('  ⚠ #' + q.number + ' 找不到四個選項標記'); stats.skip++; continue; }
    const stem = chars.slice(start, mk[0]).map(c => c.c).join('');
    const stemDigits = [...stem].filter(c => CIRCLED.test(c)).map(c => c.codePointAt(0) - 0x245F);
    const K = stemDigits.length ? Math.max.apply(null, stemDigits) : 0;
    if (!K) { console.log('  ⚠ #' + q.number + ' 題幹沒有 ①②③ 項目'); stats.skip++; continue; }

    const runs = [], seqs = [];
    for (let k = 0; k < 4; k++) {
      const a = mk[k] + 1;
      const b = k === 3 ? (mk[4] !== undefined ? mk[4] : chars.length) : mk[k + 1];
      let run = chars.slice(a, b);
      if (k === 3) {
        // 最後一個選項要在「下一題題號」處打住。
        // ⚠️ 題號與題幹之間、題號與前一個選項之間都可能有空白，
        //    所以找下一個非空白字時要跳過空白，否則整段下一題會被當成選項 D。
        for (let i = 1; i < run.length; i++) {
          if (!/\d/.test(run[i].c)) continue;
          let jx = i; while (jx + 1 < run.length && /[\d\s]/.test(run[jx + 1].c)) jx++;
          const after = run.slice(jx).find(c => !/[\d\s]/.test(c.c));
          if (after && /[一-鿿①-⑳]/.test(after.c)) { run = run.slice(0, i); break; }
        }
      }
      runs.push(run);
      seqs.push(run.filter(c => c.g !== undefined).map(c => c.g));
    }
    if (seqs.some(s => !s.length)) { console.log('  ⚠ #' + q.number + ' 有選項不含圈號'); stats.skip++; continue; }
    cases.push({ q: q, runs: runs, seqs: seqs, K: K });
  }

  let changed = 0;
  if (!cases.length) { if (MONTAGE && clusters.length) await writeMontage(exam, code, subject, clusters); return false; }
  const r = decodePaper(cases, clusters, refs);
  if (!r.ok) {
    console.log('  ✗ 整卷解不出來：' + r.why);
    stats.skip += cases.length;
    if (MONTAGE && clusters.length) await writeMontage(exam, code, subject, clusters);
    return false;
  }

  if (r.shaky.length) console.log('  （沒釘死的字形：' + r.shaky.join(' ') + '，用到它們的題會略過）');
  // 只從**真的被採用**的題學字形。
  // ⚠️ 早期版本是「凡是釘死的字形都學」，結果 clinical-psychology 106030
  //    整題被略過（兩個字形沒釘死），卻還是把 4 個字形寫進庫，其中一個 ② 被標成 ①，
  //    再透過字形庫污染後面的卷。學習的門檻必須跟寫入一樣嚴。
  const learnFrom = new Set();

  // 第二趟：用整卷共用的字形→數字對照重建選項
  for (const cs of cases) {
    const q = cs.q, runs = cs.runs, seqs = cs.seqs, K = cs.K;
    const un = [...new Set(seqs.flat())].filter(g => !r.confident[g]);
    if (un.length) { console.log('  ⚠ #' + q.number + ' 用到沒釘死的字形 ' + un.map(g => 'g' + g).join(',')); stats.skip++; continue; }
    const rebuilt = runs.map(run => run.map(c => (c.g !== undefined ? String.fromCodePoint(0x245F + r.map[c.g]) : c.c)).join('').replace(/\s+/g, ' ').trim());
    // 安全檢查：非圈號的字必須跟題庫現存的一致（確認抓到的是同一題的選項）
    const strip = s => String(s).replace(/[①-⑳\s]/g, '');
    const keys = ['A', 'B', 'C', 'D'];
    const mismatch = keys.findIndex((k, i) => strip((q.options || {})[k]) !== strip(rebuilt[i]));
    if (mismatch >= 0) {
      console.log('  ⚠ #' + q.number + ' 選項 ' + keys[mismatch] + ' 的非圈號文字對不上，略過');
      console.log('      題庫:' + JSON.stringify(String((q.options || {})[keys[mismatch]]).slice(0, 40)) + '  原卷:' + JSON.stringify(rebuilt[mismatch].slice(0, 40)));
      stats.skip++; continue;
    }
    const before = keys.map(k => (q.options || {})[k]).join(' / ');
    const after = rebuilt.join(' / ');
    seqs.flat().forEach(g => learnFrom.add(g));
    if (before === after) { stats.nochange++; continue; }
    if (MONTAGE) console.log("      群序: " + seqs.map(function(s,i){return "ABCD"[i]+"="+s.map(function(g){return "g"+g+"→"+r.map[g]}).join(" ")}).join("  "));
    console.log("  #" + q.number + '  ' + before + '   →   ' + after + '   (K=' + K + ')');
    if (APPLY) keys.forEach((k, i) => { q.options[k] = rebuilt[i]; });
    changed++; stats.fixed++;
  }
  let learned = 0;
  for (const g of learnFrom) if (lib.add(clusters[g].rep.sig, r.map[g], exam + ' ' + code)) learned++;
  const dropped = learnFrom.size ? lib.save() : 0;
  if (learned) console.log('  （字形庫 +' + learned + (dropped ? '，剔除衝突 ' + dropped : '') + '）');
  if (MONTAGE && clusters.length) await writeMontage(exam, code, subject, clusters);
  // 保留原本的檔尾換行，否則每個題庫檔都會多一筆「\ No newline at end of file」的雜訊 diff
  if (APPLY && changed) fs.writeFileSync(p0, JSON.stringify(j, null, 2) + (rawText.endsWith('\n') ? '\n' : ''), 'utf8');
  return changed > 0;
}

async function writeMontage(exam, code, subject, clusters) {
  const mupdf = await import('mupdf');
  const PAD = 8, CW = S + PAD * 2, W2 = CW * clusters.length, H2 = S + PAD * 2;
  const pm = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, W2, H2], false);
  const dst = pm.getPixels(); dst.fill(255);
  clusters.forEach((c, i) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) dst[(y + PAD) * W2 + i * CW + PAD + x] = c.rep.g[y * S + x];
    for (let y = 0; y < H2; y++) dst[y * W2 + i * CW] = 0;
  });
  fs.mkdirSync(path.join(BK, '_tmp'), { recursive: true });
  const f = path.join(BK, '_tmp', 'glyphs-' + exam + '-' + code + '-' + subject.replace(/[^\w一-鿿]/g, '') + '.png');
  fs.writeFileSync(f, pm.asPNG());
  console.log('  [字形圖] ' + f + '  共 ' + clusters.length + ' 群（左到右 g0..g' + (clusters.length - 1) + '）');
}

(async () => {
  const jobs = {};
  for (const f of fs.readdirSync(BK).filter(n => /^questions(-.*)?\.json$/.test(n) && !/\.bak/.test(n))) {
    const exam = f === 'questions.json' ? 'doctor1' : f.replace(/^questions-/, '').replace(/\.json$/, '');
    let raw; try { raw = JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8')); } catch (e) { continue; }
    const arr = Array.isArray(raw) ? raw : raw.questions; if (!Array.isArray(arr)) continue;
    for (const q of arr) {
      const o = q && q.options; if (!o) continue;
      if (!['A', 'B', 'C', 'D', 'E'].some(k => (String(o[k] || '').match(/①/g) || []).length >= 2)) continue;
      const key = exam + '|' + q.exam_code + '|' + q.subject;
      (jobs[key] = jobs[key] || []).push(q.number);
    }
  }
  let keys = Object.keys(jobs).sort();
  // ⚠️ mupdf 在同一個 process 連跑多卷會 handle leak（實測第 40 卷左右 malloc 失敗），
  //    所以批次要用 --list 列出工作，外面一卷開一個 node。
  if (process.argv.includes('--list')) { keys.forEach(k => console.log(k)); return; }
  if (!ALL) {
    const e = arg('exam'), c = arg('code'), s = arg('subject');
    if (!e || !c || !s) { console.error('需要 --exam --code --subject，或 --all'); process.exit(1); }
    keys = [e + '|' + c + '|' + s];
    if (!jobs[keys[0]]) jobs[keys[0]] = (arg('nums') || '').split(',').filter(Boolean).map(Number);
  }
  lib.load();
  // 字形庫自檢圖：每一列是「被判成同一個數字」的所有字形。
  // 一列裡出現不同數字就是庫髒了 —— 套用前一定要看這張。
  if (process.argv.includes('--lib-montage')) {
    const mupdf = await import('mupdf');
    const digits = [...new Set(lib.items.map(i => i.digit))].sort((a, b) => a - b);
    const cols = Math.max.apply(null, digits.map(d => lib.items.filter(i => i.digit === d).length));
    const C = Q * 2 + 6, W2 = C * cols, H2 = C * digits.length;
    const pm = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, W2, H2], false);
    const dst = pm.getPixels(); dst.fill(255);
    digits.forEach((d, row) => {
      lib.items.filter(i => i.digit === d).forEach((it, col) => {
        for (let y = 0; y < Q * 2; y++) for (let x = 0; x < Q * 2; x++)
          dst[(row * C + 3 + y) * W2 + col * C + 3 + x] = it.sig[(y >> 1) * Q + (x >> 1)] ? 0 : 255;
      });
      for (let x = 0; x < W2; x++) dst[(row * C) * W2 + x] = 0;
    });
    fs.mkdirSync(path.join(BK, '_tmp'), { recursive: true });
    fs.writeFileSync(path.join(BK, '_tmp', 'glyph-lib.png'), pm.asPNG());
    console.log('字形庫 ' + lib.items.length + ' 個字形，' + digits.length + ' 列（由上到下 = ' + digits.map(d => String.fromCodePoint(0x245F + d)).join(' ') + '）');
    console.log('已寫 ' + path.join(BK, '_tmp', 'glyph-lib.png'));
    return;
  }
  const stats = { fixed: 0, skip: 0, nopaper: 0, nochange: 0 };
  for (const key of keys) {
    const parts = key.split('|');
    const exam = parts[0], code = parts[1], subject = parts.slice(2).join('|');
    console.log('\n■ ' + exam + ' ' + code + ' ' + subject + '  (' + jobs[key].length + ' 題)');
    try { await doPaper(exam, code, subject, jobs[key], stats); }
    catch (e) { console.log('  ✗ ' + e.message); stats.nopaper++; }
  }
  console.log('\n修好 ' + stats.fixed + '｜無變化 ' + stats.nochange + '｜略過 ' + stats.skip + '｜拿不到卷 ' + stats.nopaper);
  if (!APPLY) console.log('(試跑；加 --apply 才寫入)');
})().catch(e => { console.error(e.stack); process.exit(1); });
